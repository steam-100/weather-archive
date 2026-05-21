/**
 * MiniMax adapter — 走 Anthropic Messages API 兼容协议
 * 端点:<base>/v1/messages
 * 文档参考:Anthropic Messages API + MiniMax 兼容层
 *
 * 实现:
 *   - chat(): 一次性请求,返回完整文本
 *   - stream(): SSE 流式,按 content_block_delta 解析 text_delta
 */
import type {
  LLMAdapter,
  ChatRequest,
  ChatStreamChunk,
} from "./types";

export interface MiniMaxConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
}

/** Anthropic Messages 请求体 */
interface AnthropicMessagesBody {
  model: string;
  max_tokens: number;
  messages: { role: "user" | "assistant"; content: string }[];
  system?: string;
  temperature?: number;
  stream?: boolean;
}

/** 把统一 ChatRequest 转成 Anthropic body */
function buildBody(
  req: ChatRequest,
  defaultModel: string,
  stream: boolean,
): AnthropicMessagesBody {
  // 把 system 角色单独提出(Anthropic 协议要求 system 与 messages 分离)
  let system = req.system;
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of req.messages) {
    if (m.role === "system") {
      system = (system ? system + "\n\n" : "") + m.content;
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }
  const body: AnthropicMessagesBody = {
    model: req.model || defaultModel,
    max_tokens: req.maxTokens ?? 1024,
    messages,
    stream,
  };
  if (system) body.system = system;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  return body;
}

/** 通用 fetch,失败时抛带状态码和错误内容的异常 */
async function callMessages(
  cfg: MiniMaxConfig,
  body: AnthropicMessagesBody,
): Promise<Response> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/v1/messages`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // 双 header 兼容(Anthropic 用 x-api-key,部分代理用 Authorization)
      authorization: `Bearer ${cfg.apiKey}`,
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`LLM ${resp.status} ${resp.statusText}: ${text.slice(0, 500)}`);
  }
  return resp;
}

/** 一次性返回响应中的文本(取所有 content[type=text].text 拼接) */
interface AnthropicResponse {
  content?: { type: string; text?: string }[];
}
function extractText(data: AnthropicResponse): string {
  if (!data.content) return "";
  return data.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("");
}

/** SSE 事件流的单条 data JSON */
interface SSEEvent {
  type: string;
  delta?: { type?: string; text?: string };
}

/** 解析 SSE 流,逐 token yield */
async function* parseSSE(
  resp: Response,
): AsyncGenerator<ChatStreamChunk, void, unknown> {
  if (!resp.body) {
    yield { text: "", delta: "", done: true };
    return;
  }
  const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let accumulated = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;

      // SSE 按 \n\n 分块
      let blockEnd: number;
      while ((blockEnd = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, blockEnd);
        buffer = buffer.slice(blockEnd + 2);

        // 提取 data: 行(可能跨多行,但 Anthropic 通常单行)
        let dataLine = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) {
            dataLine = line.slice(6);
            break;
          }
        }
        if (!dataLine || dataLine === "[DONE]") continue;

        let evt: SSEEvent;
        try {
          evt = JSON.parse(dataLine) as SSEEvent;
        } catch {
          continue;
        }

        if (
          evt.type === "content_block_delta" &&
          evt.delta?.type === "text_delta" &&
          typeof evt.delta.text === "string"
        ) {
          const delta = evt.delta.text;
          accumulated += delta;
          yield { text: accumulated, delta, done: false };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { text: accumulated, delta: "", done: true };
}

export function createMiniMaxAdapter(cfg: MiniMaxConfig): LLMAdapter {
  return {
    name: "MiniMax",

    async chat(req: ChatRequest): Promise<string> {
      const body = buildBody(req, cfg.defaultModel, false);
      const resp = await callMessages(cfg, body);
      const data = (await resp.json()) as AnthropicResponse;
      return extractText(data);
    },

    async *stream(req: ChatRequest): AsyncIterable<ChatStreamChunk> {
      const body = buildBody(req, cfg.defaultModel, true);
      const resp = await callMessages(cfg, body);
      yield* parseSSE(resp);
    },
  };
}
