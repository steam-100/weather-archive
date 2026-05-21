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
  ContentBlock,
} from "./types";

export interface MiniMaxConfig {
  apiKey: string;
  apiKeyFallback?: string;
  baseUrl: string;
  defaultModel: string;
}

/** Anthropic content block 输出格式(API 实际要的) */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | {
      // MiniMax 兼容协议下的音频 block;不通则降级到 text 占位
      type: "audio";
      source: { type: "base64"; media_type: string; data: string };
    };

/** 把统一 ContentBlock 转 Anthropic 格式 */
function toAnthropicContent(
  content: string | ContentBlock[],
): string | AnthropicContentBlock[] {
  if (typeof content === "string") return content;
  return content.map((b): AnthropicContentBlock => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "image") {
      return {
        type: "image",
        source: { type: "base64", media_type: b.mediaType, data: b.data },
      };
    }
    // audio — Anthropic 标准协议无,作为兼容尝试 MiniMax 扩展
    return {
      type: "audio",
      source: { type: "base64", media_type: b.mediaType, data: b.data },
    };
  });
}

/** Anthropic Messages 请求体 */
interface AnthropicMessagesBody {
  model: string;
  max_tokens: number;
  messages: {
    role: "user" | "assistant";
    content: string | AnthropicContentBlock[];
  }[];
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
  const messages: AnthropicMessagesBody["messages"] = [];
  for (const m of req.messages) {
    if (m.role === "system") {
      // system 块只支持纯字符串拼接(忽略多模态 system 场景,家用够)
      const text =
        typeof m.content === "string"
          ? m.content
          : m.content
              .filter((b) => b.type === "text")
              .map((b) => (b as { text: string }).text)
              .join("");
      system = (system ? system + "\n\n" : "") + text;
    } else {
      messages.push({
        role: m.role,
        content: toAnthropicContent(m.content),
      });
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

/** 通用 fetch — key 列表 fallback;失败时切下一个再试 */
async function callMessages(
  cfg: MiniMaxConfig,
  body: AnthropicMessagesBody,
): Promise<Response> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/v1/messages`;
  const keys = [cfg.apiKey, cfg.apiKeyFallback].filter(
    (k): k is string => !!k,
  );
  if (keys.length === 0) throw new Error("no LLM_API_KEY configured");

  let lastErr: Error = new Error("no attempt");
  for (let i = 0; i < keys.length; i++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // 双 header 兼容(Anthropic 用 x-api-key,部分代理用 Authorization)
          authorization: `Bearer ${keys[i]}`,
          "x-api-key": keys[i]!,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      if (resp.ok) return resp;
      // 失败:account/quota 类切下一个
      const isFallback =
        resp.status === 401 ||
        resp.status === 403 ||
        resp.status === 429 ||
        resp.status >= 500;
      const text = await resp.text().catch(() => "");
      const err = new Error(
        `LLM ${resp.status} ${resp.statusText} (key #${i + 1}): ${text.slice(0, 400)}`,
      );
      if (isFallback && i < keys.length - 1) {
        lastErr = err;
        continue;
      }
      throw err;
    } catch (e) {
      if (i < keys.length - 1) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
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
