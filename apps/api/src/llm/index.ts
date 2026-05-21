/**
 * 模型路由入口 — 按 provider 名分发到不同 adapter
 * 后续扩展:DeepSeek / 智谱 / 豆包 同样模式
 */
import type { LLMAdapter } from "./types";
import { createMiniMaxAdapter } from "./MiniMax";

export interface LLMEnv {
  LLM_API_KEY: string;
  LLM_BASE_URL: string;
  LLM_DEFAULT_MODEL: string;
}

export function getAdapter(provider: string, env: LLMEnv): LLMAdapter {
  switch (provider) {
    case "MiniMax":
      return createMiniMaxAdapter({
        apiKey: env.LLM_API_KEY,
        baseUrl: env.LLM_BASE_URL,
        defaultModel: env.LLM_DEFAULT_MODEL,
      });
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}

export type { LLMAdapter, ChatRequest, ChatMessage, ChatStreamChunk } from "./types";
