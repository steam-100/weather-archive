/**
 * API 客户端 — 与 Cloudflare Worker 后端通讯
 *
 * 设计:
 *   - 同源相对路径(/api/...),dev 走 vite proxy → :8787,prod 同域(P5 部署 Pages 时绑)
 *   - 全部带 credentials: 'include' 让 cookie 自动跟着走
 *   - 统一错误:非 2xx 抛 ApiError(含 status / code / message)
 */
import type {
  ListWorkflowsResponse,
  SaveWorkflowResponse,
  WorkflowDef,
} from "@app/shared";

const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    ...init,
  });

  // 优先尝试解析 JSON,失败则按 text
  let data: unknown;
  const text = await resp.text();
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }

  if (!resp.ok) {
    const msg =
      (data as { error?: string; message?: string } | undefined)?.error ??
      (data as { message?: string } | undefined)?.message ??
      `HTTP ${resp.status}`;
    throw new ApiError(resp.status, msg);
  }
  return data as T;
}

// ─── auth ─────────────────────────────────────────────────────────────

export const api = {
  health: () => request<{ ok: boolean; ts: number; model: string }>("/health"),

  login: (passcode: string) =>
    request<{ ok: boolean }>("/login", {
      method: "POST",
      body: JSON.stringify({ passcode }),
    }),

  logout: () => request<{ ok: boolean }>("/logout", { method: "POST" }),

  me: () =>
    request<{ ok: boolean; user: { sub: string; exp: number } }>("/me"),

  // ─── workflows(P3-B 详细用到) ─────────────────────────────────────
  listWorkflows: () => request<ListWorkflowsResponse>("/workflows"),

  getWorkflow: (id: string) =>
    request<{ workflow: WorkflowDef }>(`/workflows/${id}`),

  createWorkflow: (wf: Partial<WorkflowDef>) =>
    request<SaveWorkflowResponse>("/workflows", {
      method: "POST",
      body: JSON.stringify(wf),
    }),

  updateWorkflow: (id: string, wf: Partial<WorkflowDef>) =>
    request<SaveWorkflowResponse>(`/workflows/${id}`, {
      method: "PUT",
      body: JSON.stringify(wf),
    }),

  deleteWorkflow: (id: string) =>
    request<{ ok: boolean }>(`/workflows/${id}`, { method: "DELETE" }),
};
