/**
 * 工作流 CRUD 路由 — 全部受鉴权保护
 *
 *   GET    /api/workflows        list
 *   POST   /api/workflows        create (auto-id)
 *   GET    /api/workflows/:id    detail
 *   PUT    /api/workflows/:id    update
 *   DELETE /api/workflows/:id    remove
 */
import { Hono } from "hono";
import type { Bindings, Variables } from "../index";
import type {
  WorkflowDef,
  NodeDef,
  EdgeDef,
  ListWorkflowsResponse,
  SaveWorkflowResponse,
} from "@app/shared";
import {
  listWorkflows,
  getWorkflow,
  saveWorkflow,
  deleteWorkflow,
} from "../kv";

export const workflowsRouter = new Hono<{
  Bindings: Bindings;
  Variables: Variables;
}>();

/** body 容错解析 */
async function parseBody<T>(req: Request): Promise<Partial<T>> {
  try {
    return (await req.json()) as Partial<T>;
  } catch {
    return {};
  }
}

/** 安全转字符串 — 避免空对象 / 类型错误污染存储 */
function asString(v: unknown, max = 200): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

/** 节点/连线列表的简单白名单(P1 阶段不深校验,P4 节点池铺好后再加) */
function asNodes(v: unknown): NodeDef[] {
  return Array.isArray(v) ? (v as NodeDef[]) : [];
}
function asEdges(v: unknown): EdgeDef[] {
  return Array.isArray(v) ? (v as EdgeDef[]) : [];
}

// ─── LIST ─────────────────────────────────────────────────────────────
workflowsRouter.get("/", async (c) => {
  const workflows = await listWorkflows(c.env.KV);
  return c.json<ListWorkflowsResponse>({ workflows });
});

// ─── CREATE ───────────────────────────────────────────────────────────
workflowsRouter.post("/", async (c) => {
  const body = await parseBody<WorkflowDef>(c.req.raw);
  const now = Date.now();
  const wf: WorkflowDef = {
    id: crypto.randomUUID(),
    name: asString(body.name, 80) ?? "未命名工作流",
    description: asString(body.description, 500),
    nodes: asNodes(body.nodes),
    edges: asEdges(body.edges),
    createdAt: now,
    updatedAt: now,
  };
  await saveWorkflow(c.env.KV, wf);
  return c.json<SaveWorkflowResponse>(
    { id: wf.id, updatedAt: wf.updatedAt },
    201,
  );
});

// ─── DETAIL ───────────────────────────────────────────────────────────
workflowsRouter.get("/:id", async (c) => {
  const wf = await getWorkflow(c.env.KV, c.req.param("id"));
  if (!wf) return c.json({ error: "not_found" }, 404);
  return c.json({ workflow: wf });
});

// ─── UPDATE ───────────────────────────────────────────────────────────
workflowsRouter.put("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getWorkflow(c.env.KV, id);
  if (!existing) return c.json({ error: "not_found" }, 404);

  const body = await parseBody<WorkflowDef>(c.req.raw);
  const wf: WorkflowDef = {
    id, // 强制保留原 id,防 body 篡改
    name: asString(body.name, 80) ?? existing.name,
    description:
      body.description === undefined
        ? existing.description
        : asString(body.description, 500),
    nodes: body.nodes !== undefined ? asNodes(body.nodes) : existing.nodes,
    edges: body.edges !== undefined ? asEdges(body.edges) : existing.edges,
    createdAt: existing.createdAt, // 强制保留
    updatedAt: Date.now(),
  };
  await saveWorkflow(c.env.KV, wf);
  return c.json<SaveWorkflowResponse>({ id: wf.id, updatedAt: wf.updatedAt });
});

// ─── DELETE ───────────────────────────────────────────────────────────
workflowsRouter.delete("/:id", async (c) => {
  const ok = await deleteWorkflow(c.env.KV, c.req.param("id"));
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});
