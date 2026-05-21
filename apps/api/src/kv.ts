/**
 * KV 抽象层 — 工作流持久化
 *
 * Key 设计:
 *   wf:<uuid> → JSON.stringify(WorkflowDef)
 *   metadata: { name, description, updatedAt }  ← list 时无需 get,直接读 metadata
 *
 * 限制:
 *   - KV.list 单次最多 1000 个,家用规模够;真到大量时再加分页
 *   - KV 写有 1/秒/key 的速率限制,家用工作流编辑场景完全够
 */
import type { WorkflowDef, WorkflowSummary } from "@app/shared";

const PREFIX = "wf:";
const buildKey = (id: string): string => `${PREFIX}${id}`;

interface WorkflowMetadata {
  name: string;
  description?: string;
  updatedAt: number;
}

/** 列出所有工作流 — 用 metadata 避免逐个 get,效率好 */
export async function listWorkflows(
  kv: KVNamespace,
): Promise<WorkflowSummary[]> {
  const list = await kv.list<WorkflowMetadata>({ prefix: PREFIX, limit: 200 });

  const summaries: WorkflowSummary[] = list.keys
    .filter((k) => !!k.metadata)
    .map((k) => ({
      id: k.name.slice(PREFIX.length),
      name: k.metadata!.name,
      description: k.metadata!.description,
      updatedAt: k.metadata!.updatedAt,
    }));

  // 最近更新优先
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

/** 获取单个工作流的完整定义 */
export async function getWorkflow(
  kv: KVNamespace,
  id: string,
): Promise<WorkflowDef | null> {
  return (await kv.get<WorkflowDef>(buildKey(id), "json")) ?? null;
}

/** 写入(create / update 通用) */
export async function saveWorkflow(
  kv: KVNamespace,
  wf: WorkflowDef,
): Promise<void> {
  const metadata: WorkflowMetadata = {
    name: wf.name,
    description: wf.description,
    updatedAt: wf.updatedAt,
  };
  await kv.put(buildKey(wf.id), JSON.stringify(wf), { metadata });
}

/** 删除 — 不存在时返回 false */
export async function deleteWorkflow(
  kv: KVNamespace,
  id: string,
): Promise<boolean> {
  const k = buildKey(id);
  const existed = await kv.get(k);
  if (existed === null) return false;
  await kv.delete(k);
  return true;
}
