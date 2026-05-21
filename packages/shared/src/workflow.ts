/**
 * 前后端共享类型 — 工作流定义 + API 契约
 * P2 阶段会扩展节点 schema 细节
 */

/** 节点类型枚举 */
export type NodeType =
  | "input"
  | "llm"
  | "http"
  | "condition"
  | "code"
  | "output";

/** 单个节点定义 */
export interface NodeDef {
  id: string;
  type: NodeType;
  /** 画布坐标 */
  position: { x: number; y: number };
  /** 节点配置(prompt 模板 / URL / 条件表达式 等) */
  data: Record<string, unknown>;
}

/** 节点之间的连线 */
export interface EdgeDef {
  id: string;
  source: string;
  target: string;
  /** 可选:source 节点的输出字段 → target 节点的输入字段 */
  sourceHandle?: string;
  targetHandle?: string;
}

/** 一个工作流的完整定义(存到 KV 里的 JSON 形态) */
export interface WorkflowDef {
  id: string;
  name: string;
  description?: string;
  nodes: NodeDef[];
  edges: EdgeDef[];
  createdAt: number;
  updatedAt: number;
}

/** 工作流摘要(列表页用) */
export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  updatedAt: number;
}
