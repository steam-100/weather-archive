/**
 * 模型适配层 — 统一接口
 * P6:ChatMessage.content 支持多模态 block 数组
 */

/** 内容块 — 文本 / 图片 / 音频 */
export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      /** MIME 类型,如 image/jpeg / image/png */
      mediaType: string;
      /** 文件二进制的 base64 编码(不含 data: 前缀) */
      data: string;
    }
  | {
      type: "audio";
      /** MIME 类型,如 audio/mpeg / audio/wav */
      mediaType: string;
      /** 音频二进制的 base64 编码 */
      data: string;
    };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  /** 文本(向后兼容)或多模态 block 数组 */
  content: string | ContentBlock[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 系统提示;Anthropic 风格,与 messages 分离 */
  system?: string;
}

/** 流式输出的增量块 */
export interface ChatStreamChunk {
  /** 累计到当前的全文 */
  text: string;
  /** 本次新增的 token */
  delta: string;
  /** 是否结束 */
  done: boolean;
}

export interface LLMAdapter {
  name: string;
  /** 一次性返回 */
  chat(req: ChatRequest): Promise<string>;
  /** 流式返回 */
  stream(req: ChatRequest): AsyncIterable<ChatStreamChunk>;
}
