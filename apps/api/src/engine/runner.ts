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
  FileRef,
} from "@app/shared";
import { isFileRef } from "@app/shared";
import type { Bindings } from "../index";
import { getAdapter } from "../llm";
import type { ContentBlock } from "../llm/types";

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

// ─── 多模态辅助 ──────────────────────────────────────────────────────

interface FileMetadata {
  contentType: string;
  size: number;
  name: string;
  uploadedAt: number;
}

/** ArrayBuffer → base64 (chunked,避免大文件爆栈) */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(binary);
}

/** 从 FILES KV 把 FileRef 加载成 ContentBlock(image / audio) */
async function loadFileAsBlock(
  ref: FileRef,
  env: Bindings,
): Promise<ContentBlock | null> {
  const buf = await env.FILES.get(ref.fileKey, "arrayBuffer");
  if (!buf) return null;
  const ct = ref.contentType;
  const kind: "image" | "audio" | null =
    ct.startsWith("image/")
      ? "image"
      : ct.startsWith("audio/")
        ? "audio"
        : null;
  if (!kind) return null;
  return {
    type: kind,
    mediaType: ct,
    data: arrayBufferToBase64(buf),
  };
}

/**
 * 构造 LLM 节点的 content:
 *   - prompt 模板里 {{xxx}} 引用 FileRef → 收集为多模态 block
 *   - 普通字符串引用 → 替换到文字
 *   - 返回 string(纯文本)或 ContentBlock[](多模态)
 */
async function buildLLMContent(
  template: string,
  vars: Record<string, unknown>,
  env: Bindings,
): Promise<string | ContentBlock[]> {
  // 1. 扫描收集所有文件引用(去重)
  const seenKeys = new Set<string>();
  const fileRefs: FileRef[] = [];
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  for (const m of template.matchAll(re)) {
    const rootKey = m[1]!.trim().split(".")[0]!;
    const v = vars[rootKey];
    if (isFileRef(v) && !seenKeys.has(v.fileKey)) {
      seenKeys.add(v.fileKey);
      fileRefs.push(v);
    }
  }

  // 2. 文本替换(file ref 处替换为可读占位 [文件:name])
  const text = template.replace(re, (_, expr: string) => {
    const path = expr.trim().split(".");
    const rootKey = path[0]!;
    const v = vars[rootKey];
    if (isFileRef(v)) return `[文件:${v.name}]`;
    let cur: unknown = vars;
    for (const seg of path) {
      if (
        cur !== null &&
        typeof cur === "object" &&
        seg in (cur as Record<string, unknown>)
      ) {
        cur = (cur as Record<string, unknown>)[seg];
      } else {
        return "";
      }
    }
    if (cur === null || cur === undefined) return "";
    return typeof cur === "string" ? cur : JSON.stringify(cur);
  });

  // 3. 没有文件引用 → 直接返回字符串
  if (fileRefs.length === 0) return text;

  // 4. 加载文件 → 拼 content blocks
  const fileBlocks: ContentBlock[] = [];
  for (const ref of fileRefs) {
    const block = await loadFileAsBlock(ref, env);
    if (block) fileBlocks.push(block);
  }

  return [{ type: "text", text }, ...fileBlocks];
}

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

/** HTTP 节点 — 调外部 API */
interface HttpNodeData {
  url?: string; // 模板
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: string; // 模板,JSON / form / 纯文本
}

/** Code 节点 — 执行 JS 片段 */
interface CodeNodeData {
  /** 函数体;签名 (vars) => any。可以 return Promise(会被 await) */
  code?: string;
}

/** Input 节点 — P3 加了默认值 */
interface InputNodeData {
  default?: string;
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
      // 优先用 inputs 字典传入的值,其次用画布上配的 default
      const data = (node.data ?? {}) as InputNodeData;
      const provided = ctx.vars[node.id];
      const out =
        provided !== undefined && provided !== null && provided !== ""
          ? provided
          : (data.default ?? null);
      ctx.vars[node.id] = out; // 写回方便 LLM 引用
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
      // 多模态:把 prompt 模板 + ctx.vars 里的 FileRef 拼成 content blocks
      const content = await buildLLMContent(
        data.prompt ?? "",
        ctx.vars,
        ctx.env,
      );
      const system = data.system
        ? resolveTemplate(data.system, ctx.vars)
        : undefined;

      const adapter = getAdapter("MiniMax", ctx.env);
      let accumulated = "";

      for await (const chunk of adapter.stream({
        model: data.model ?? ctx.env.LLM_DEFAULT_MODEL,
        messages: [{ role: "user", content }],
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

    case "http": {
      const data = (node.data ?? {}) as HttpNodeData;
      const url = resolveTemplate(data.url ?? "", ctx.vars);
      if (!url) throw new Error("http node: url is required");
      const method = data.method ?? "GET";
      const headers: Record<string, string> = { ...(data.headers ?? {}) };
      // 把 headers 的值也走模板
      for (const k of Object.keys(headers)) {
        headers[k] = resolveTemplate(headers[k] ?? "", ctx.vars);
      }
      const bodyTpl = data.body ?? "";
      const body =
        bodyTpl && method !== "GET"
          ? resolveTemplate(bodyTpl, ctx.vars)
          : undefined;

      // body 默认带上 JSON content-type(若未显式设置)
      if (body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
        headers["content-type"] = "application/json";
      }

      const resp = await fetch(url, { method, headers, body });
      const ct = resp.headers.get("content-type") ?? "";
      let result: unknown;
      if (ct.includes("application/json")) {
        result = await resp.json().catch(() => null);
      } else {
        result = await resp.text();
      }

      if (!resp.ok) {
        const preview =
          typeof result === "string"
            ? result.slice(0, 300)
            : JSON.stringify(result).slice(0, 300);
        throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${preview}`);
      }

      yield { type: "node_end", nodeId: node.id, output: result };
      return result;
    }

    case "code": {
      const data = (node.data ?? {}) as CodeNodeData;
      const code = (data.code ?? "").trim();
      if (!code) throw new Error("code node: code is required");

      // 注意:Cloudflare Workers 默认禁用动态代码执行(eval/Function),
      // 但 wrangler 配置 nodejs_compat + globalThis 限定下,Function 构造在 Workers 环境是可用的。
      // 用户代码以 vars 为唯一参数,strict mode,签名 (vars) => any
      let result: unknown;
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(
          "vars",
          `"use strict";\nreturn (async (vars) => {\n${code}\n})(vars);`,
        ) as (vars: Record<string, unknown>) => Promise<unknown>;
        result = await fn(ctx.vars);
      } catch (e) {
        throw new Error(
          `code node error: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      yield { type: "node_end", nodeId: node.id, output: result };
      return result;
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
