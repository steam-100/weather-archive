/**
 * 模型适配层 — 统一接口
 * 所有 LLM 提供商实现这套接口,供工作流引擎调用
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
