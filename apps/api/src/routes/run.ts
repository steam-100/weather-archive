/**
 * 工作流执行路由 — POST /api/run
 *
 * Body: { workflowId: string, inputs?: Record<string, unknown> }
 * Response: SSE 流(text/event-stream),每条 data: 是 RunStreamEvent JSON
 *
 * 流末尾追加 "data: [DONE]\n\n" 表示彻底结束
 */
import { Hono } from "hono";
import type { Bindings, Variables } from "../index";
import type { RunWorkflowRequest } from "@app/shared";
import { getWorkflow } from "../kv";
import { runWorkflow } from "../engine/runner";

export const runRouter = new Hono<{
  Bindings: Bindings;
  Variables: Variables;
}>();

runRouter.post("/", async (c) => {
  const body = await c.req
    .json<Partial<RunWorkflowRequest>>()
    .catch(() => ({}) as Partial<RunWorkflowRequest>);

  if (!body.workflowId || typeof body.workflowId !== "string") {
    return c.json({ error: "workflowId_required" }, 400);
  }

  const wf = await getWorkflow(c.env.KV, body.workflowId);
  if (!wf) {
    return c.json({ error: "workflow_not_found" }, 404);
  }

  const inputs =
    body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs)
      ? body.inputs
      : {};

  const env = c.env;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      try {
        for await (const evt of runWorkflow(wf, inputs, env)) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`));
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ type: "error", message: msg })}\n\n`,
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
});
