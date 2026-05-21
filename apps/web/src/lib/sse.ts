/**
 * SSE 流式 fetch — EventSource 不支持 POST,所以手撸 fetch + ReadableStream
 *
 * 用法:
 *   for await (const evt of streamSSE<MyEvent>('/api/run', { method: 'POST', body: ... })) {
 *     // 处理 evt
 *   }
 *
 * 协议解析:按 \n\n 分块,每块取 "data: " 开头的行作为 JSON 载荷,"[DONE]" 表示流结束
 */
const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";

export async function* streamSSE<T>(
  path: string,
  init: RequestInit = {},
): AsyncGenerator<T, void, unknown> {
  const resp = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  if (!resp.body) return;

  const reader = resp.body
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;

      let blockEnd: number;
      while ((blockEnd = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, blockEnd);
        buffer = buffer.slice(blockEnd + 2);

        // 提取首个 "data: " 行
        let dataLine = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) {
            dataLine = line.slice(6);
            break;
          }
        }
        if (!dataLine || dataLine === "[DONE]") continue;

        try {
          yield JSON.parse(dataLine) as T;
        } catch {
          // 跳过格式错误的事件,保持流不中断
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
