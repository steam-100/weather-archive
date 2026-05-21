/**
 * 模型连通性测试路由 — 验证 LLM_API_KEY/Base/Model 是否串通
 *
 *   POST /api/llm/test         一次性返回模型回复
 *   POST /api/llm/test-stream  SSE 流式返回(供前端验证流式协议)
 *
 * P2 阶段会有真正的 /api/run(走工作流 DAG),这里只是 ping。
 */
import { Hono } from "hono";
import type { Bindings, Variables } from "../index";
import { getAdapter } from "../llm";

export const llmRouter = new Hono<{
  Bindings: Bindings;
  Variables: Variables;
}>();

interface TestBody {
  prompt?: string;
}

llmRouter.post("/test", async (c) => {
  const body = await c.req.json<TestBody>().catch(() => ({}) as TestBody);
  const prompt = typeof body.prompt === "string" && body.prompt.length > 0
    ? body.prompt
    : "你好,简短自我介绍一句话即可。";

  try {
    const adapter = getAdapter("MiniMax", c.env);
    const text = await adapter.chat({
      model: c.env.LLM_DEFAULT_MODEL,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 2048, // M2.7 是推理模型,需要给思考留空间
    });
    return c.json({ ok: true, text });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: msg }, 500);
  }
});

llmRouter.post("/test-stream", async (c) => {
  const body = await c.req.json<TestBody>().catch(() => ({}) as TestBody);
  const prompt = typeof body.prompt === "string" && body.prompt.length > 0
    ? body.prompt
    : "用一句话讲一个有趣的小故事。";

  const adapter = getAdapter("MiniMax", c.env);

  const sseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      try {
        for await (const chunk of adapter.stream({
          model: c.env.LLM_DEFAULT_MODEL,
          messages: [{ role: "user", content: prompt }],
          maxTokens: 2048,
        })) {
          controller.enqueue(
            enc.encode(`data: ${JSON.stringify(chunk)}\n\n`),
          );
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(
          enc.encode(`data: ${JSON.stringify({ error: msg })}\n\n`),
        );
        controller.close();
      }
    },
  });

  return new Response(sseStream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
});
