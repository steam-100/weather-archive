/**
 * 前后端共享 API 契约
 * 任意接口签名变更必须前后端同步更新这里
 */
import type { WorkflowDef, WorkflowSummary } from "./workflow";

export interface LoginRequest {
  passcode: string;
}

export interface LoginResponse {
  ok: boolean;
}

export interface ListWorkflowsResponse {
  workflows: WorkflowSummary[];
}

export interface SaveWorkflowRequest {
  workflow: WorkflowDef;
}

export interface SaveWorkflowResponse {
  id: string;
  updatedAt: number;
}

/** 运行工作流请求 */
export interface RunWorkflowRequest {
  workflowId: string;
  /** 输入节点的初始值 */
  inputs: Record<string, unknown>;
}

/** SSE 流事件 */
export type RunStreamEvent =
  | { type: "node_start"; nodeId: string }
  | { type: "node_delta"; nodeId: string; delta: string }
  | { type: "node_end"; nodeId: string; output: unknown }
  | { type: "done" }
  | { type: "error"; message: string };
