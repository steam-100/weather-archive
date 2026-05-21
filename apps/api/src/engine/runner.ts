/**
 * 工作流执行引擎 — 单文件包含 DAG 拓扑、变量替换、节点 dispatch、流式执行
 *
 * 设计:
 *   - 工作流 = NodeDef[] + EdgeDef[]
 *   - 拓扑排序后按顺序执行
 *   - 每个节点输出存到 ctx.vars[nodeId]
 *   - 后续节点用 {{nodeId}} 或 {{nodeId.field}} 模板引用
 *   - LLM 节点流式 → 逐 token yield node_delta
 *
 * P2 内置节点(其它见 P4):
 *   - input  : 用户输入(从 inputs 预填)
 *   - llm    : 调模型 + 流式输出
 *   - output : 模板引用前面节点的最终输出
 */
import type {
  WorkflowDef,
  NodeDef,
  EdgeDef,
  RunStreamEvent,
} from "@app/shared";
import type { Bindings } from "../index";
import { getAdapter } from "../llm";

// ─── DAG 拓扑排序 ─────────────────────────────────────────────────────

/** Kahn 算法拓扑排序;有环则抛错 */
export function topoSort(nodes: NodeDef[], edges: EdgeDef[]): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const n of nodes) {
    inDegree.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    if (!adj.has(e.source) || !inDegree.has(e.target)) continue;
    adj.get(e.source)!.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  if (order.length !== nodes.length) {
    throw new Error("workflow has a cycle");
  }
  return order;
}

// ─── 变量替换 ─────────────────────────────────────────────────────────

/**
 * 解析模板 — {{path.to.value}} 替换为 vars 里对应的内容
 * 路径不存在时返回空字符串(温和降级,不报错)
 *
 * 例:resolveTemplate("Hello {{user.name}}", { user: { name: "World" } }) → "Hello World"
 */
export function resolveTemplate(
  template: string,
  vars: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expr: string) => {
    const path = expr.trim().split(".");
    let cur: unknown = vars;
    for (const segment of path) {
      if (
        cur !== null &&
        typeof cur === "object" &&
        segment in (cur as Record<string, unknown>)
      ) {
        cur = (cur as Record<string, unknown>)[segment];
      } else {
        return "";
      }
    }
    if (cur === null || cur === undefined) return "";
    return typeof cur === "string" ? cur : JSON.stringify(cur);
  });
}

// ─── 节点执行 ─────────────────────────────────────────────────────────

interface ExecContext {
  vars: Record<string, unknown>;
  env: Bindings;
}

/** LLM 节点的 data 形状(P4 会扩展) */
interface LLMNodeData {
  prompt?: string;
  system?: string;
  model?: string;
  maxTokens?: number;
}

/** Output 节点的 data 形状 */
interface OutputNodeData {
  from?: string; // 模板字符串,如 "{{node1}}"
}

/**
 * 执行单个节点 — 返回输出值 + 中间过程通过 yield 推 SSE 事件
 */
async function* execNode(
  node: NodeDef,
  ctx: ExecContext,
): AsyncGenerator<RunStreamEvent, unknown, unknown> {
  yield { type: "node_start", nodeId: node.id };

  switch (node.type) {
    case "input": {
      // 输入节点的值已由 runner 预填到 ctx.vars[node.id]
      const out = ctx.vars[node.id] ?? null;
      yield { type: "node_end", nodeId: node.id, output: out };
      return out;
    }

    case "output": {
      const data = (node.data ?? {}) as OutputNodeData;
      const value = data.from ? resolveTemplate(data.from, ctx.vars) : "";
      yield { type: "node_end", nodeId: node.id, output: value };
      return value;
    }

    case "llm": {
      const data = (node.data ?? {}) as LLMNodeData;
      const prompt = resolveTemplate(data.prompt ?? "", ctx.vars);
      const system = data.system
        ? resolveTemplate(data.system, ctx.vars)
        : undefined;

      const adapter = getAdapter("MiniMax", ctx.env);
      let accumulated = "";

      for await (const chunk of adapter.stream({
        model: data.model ?? ctx.env.LLM_DEFAULT_MODEL,
        messages: [{ role: "user", content: prompt }],
        ...(system ? { system } : {}),
        maxTokens: data.maxTokens ?? 2048,
      })) {
        if (chunk.delta) {
          accumulated = chunk.text;
          yield {
            type: "node_delta",
            nodeId: node.id,
            delta: chunk.delta,
          };
        }
      }

      yield { type: "node_end", nodeId: node.id, output: accumulated };
      return accumulated;
    }

    default: {
      // P4 阶段实现:http / condition / code
      const err = `node type '${node.type}' not implemented (coming in P4)`;
      yield { type: "error", message: err };
      throw new Error(err);
    }
  }
}

// ─── 整体执行入口 ─────────────────────────────────────────────────────

/**
 * 执行整个工作流,流式 yield 事件序列
 *
 * @param wf      工作流定义
 * @param inputs  input 节点的初始值,key 是 input 节点的 id
 * @param env     Workers Bindings(KV / 模型配置 / secrets)
 */
export async function* runWorkflow(
  wf: WorkflowDef,
  inputs: Record<string, unknown>,
  env: Bindings,
): AsyncGenerator<RunStreamEvent, void, unknown> {
  // 1) 拓扑排序(可能抛环检测错误)
  let order: string[];
  try {
    order = topoSort(wf.nodes, wf.edges);
  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : String(e) };
    return;
  }

  const nodeMap = new Map<string, NodeDef>(wf.nodes.map((n) => [n.id, n]));

  // 2) 初始化执行上下文 — input 节点的初始值预填到 vars
  const ctx: ExecContext = { vars: {}, env };
  for (const n of wf.nodes) {
    if (n.type === "input") {
      ctx.vars[n.id] = inputs[n.id] ?? null;
    }
  }

  // 3) 按拓扑序逐节点执行,事件流穿透 yield
  try {
    for (const id of order) {
      const node = nodeMap.get(id);
      if (!node) continue;
      const output = yield* execNode(node, ctx);
      ctx.vars[id] = output;
    }
    yield { type: "done" };
  } catch (e) {
    yield {
      type: "error",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
