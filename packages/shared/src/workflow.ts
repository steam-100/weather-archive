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

/**
 * 文件引用 — Input 节点的 image / audio 输入运行时是这种形态
 * 文件本体存在 FILES KV 里,前端用 GET /api/files/:fileKey 取
 */
export interface FileRef {
  /** KV key */
  fileKey: string;
  /** MIME 类型,如 image/jpeg / audio/mpeg */
  contentType: string;
  /** 原始文件名(展示用) */
  name: string;
  /** 字节数 */
  size: number;
}

/** 判断一个值是不是 FileRef */
export function isFileRef(v: unknown): v is FileRef {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { fileKey?: unknown }).fileKey === "string" &&
    typeof (v as { contentType?: unknown }).contentType === "string"
  );
}
