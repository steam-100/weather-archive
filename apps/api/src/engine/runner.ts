/**
 * 工作流执行引擎 — 单文件包含 DAG 拓扑、变量替换、节点 dispatch、流式执行
 *
 * 设计:
 *   - 工作流 = NodeDef[] + EdgeDef[]
 *   - 拓扑排序后按顺序执行
 *   - 每个节点输出存到 ctx.vars[nodeId]
 *   - 后续节点用 {{nodeId}} 或 {{nodeId.field}} 模板引用
 *   - LLM 节点流式 → 逐 token yield node_delta
 *
 * P2 内置节点(其它见 P4):
 *   - input  : 用户输入(从 inputs 预填)
 *   - llm    : 调模型 + 流式输出
 *   - output : 模板引用前面节点的最终输出
 */
import type {
  WorkflowDef,
  NodeDef,
  EdgeDef,
  RunStreamEvent,
  FileRef,
} from "@app/shared";
import { isFileRef } from "@app/shared";
import type { Bindings } from "../index";
import { getAdapter } from "../llm";
import type { ContentBlock } from "../llm/types";

// ─── DAG 拓扑排序 ─────────────────────────────────────────────────────

/** Kahn 算法拓扑排序;有环则抛错 */
export function topoSort(nodes: NodeDef[], edges: EdgeDef[]): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const n of nodes) {
    inDegree.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    if (!adj.has(e.source) || !inDegree.has(e.target)) continue;
    adj.get(e.source)!.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  if (order.length !== nodes.length) {
    throw new Error("workflow has a cycle");
  }
  return order;
}

// ─── 模板替换 ─────────────────────────────────────────────────────────

/**
 * 解析模板 — {{path.to.value}} 替换为 vars 里对应的内容
 * 路径不存在时返回空字符串(温和降级,不报错)
 *
 * 例:resolveTemplate("Hello {{user.name}}", { user: { name: "World" } }) → "Hello World"
 *
 * 特殊处理:vars[key] 是 FileRef 时,替换为 [文件:name] 占位(便于阅读)
 */
export function resolveTemplate(
  template: string,
  vars: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expr: string) => {
    const path = expr.trim().split(".");
    const rootKey = path[0]!;
    const v = vars[rootKey];
    if (isFileRef(v)) return `[文件:${v.name}]`;
    let cur: unknown = vars;
    for (const segment of path) {
      if (
        cur !== null &&
        typeof cur === "object" &&
        segment in (cur as Record<string, unknown>)
      ) {
        cur = (cur as Record<string, unknown>)[segment];
      } else {
        return "";
      }
    }
    if (cur === null || cur === undefined) return "";
    return typeof cur === "string" ? cur : JSON.stringify(cur);
  });
}

// ─── 节点执行 ─────────────────────────────────────────────────────────

// ─── 多模态辅助 ──────────────────────────────────────────────────────

interface FileMetadata {
  contentType: string;
  size: number;
  name: string;
  uploadedAt: number;
}

/** ArrayBuffer → base64 (chunked,避免大文件爆栈) */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(binary);
}

/** 从 FILES KV 把 FileRef 加载成 ContentBlock(image / audio) */
async function loadFileAsBlock(
  ref: FileRef,
  env: Bindings,
): Promise<ContentBlock | null> {
  const buf = await env.FILES.get(ref.fileKey, "arrayBuffer");
  if (!buf) return null;
  const ct = ref.contentType;
  const kind: "image" | "audio" | null =
    ct.startsWith("image/")
      ? "image"
      : ct.startsWith("audio/")
        ? "audio"
        : null;
  if (!kind) return null;
  return {
    type: kind,
    mediaType: ct,
    data: arrayBufferToBase64(buf),
  };
}

/**
 * 构造 LLM 节点的 content:
 *   - prompt 模板里 {{xxx}} 引用 FileRef → 收集为多模态 block
 *   - 普通字符串引用 → 替换到文字
 *   - 返回 string(纯文本)或 ContentBlock[](多模态)
 */
async function buildLLMContent(
  template: string,
  vars: Record<string, unknown>,
  env: Bindings,
): Promise<string | ContentBlock[]> {
  // 1. 扫描收集所有文件引用(去重)
  const seenKeys = new Set<string>();
  const fileRefs: FileRef[] = [];
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  for (const m of template.matchAll(re)) {
    const rootKey = m[1]!.trim().split(".")[0]!;
    const v = vars[rootKey];
    if (isFileRef(v) && !seenKeys.has(v.fileKey)) {
      seenKeys.add(v.fileKey);
      fileRefs.push(v);
    }
  }

  // 2. 文本替换(file ref 处替换为可读占位 [文件:name])
  const text = template.replace(re, (_, expr: string) => {
    const path = expr.trim().split(".");
    const rootKey = path[0]!;
    const v = vars[rootKey];
    if (isFileRef(v)) return `[文件:${v.name}]`;
    let cur: unknown = vars;
    for (const seg of path) {
      if (
        cur !== null &&
        typeof cur === "object" &&
        seg in (cur as Record<string, unknown>)
      ) {
        cur = (cur as Record<string, unknown>)[seg];
      } else {
        return "";
      }
    }
    if (cur === null || cur === undefined) return "";
    return typeof cur === "string" ? cur : JSON.stringify(cur);
  });

  // 3. 没有文件引用 → 直接返回字符串
  if (fileRefs.length === 0) return text;

  // 4. 加载文件 → 拼 content blocks
  const fileBlocks: ContentBlock[] = [];
  for (const ref of fileRefs) {
    const block = await loadFileAsBlock(ref, env);
    if (block) fileBlocks.push(block);
  }

  return [{ type: "text", text }, ...fileBlocks];
}

// ─── MiniMax API helpers ────────────────────────────────────────────

const MiniMax_BASE = "https://api.minimaxi.com";

/** 收集所有可用 key — 主 key + 兜底 key(若配置),按优先级顺序 */
function collectKeys(env: Bindings): string[] {
  const keys: string[] = [];
  if (env.LLM_API_KEY) keys.push(env.LLM_API_KEY);
  if (env.LLM_API_KEY_FALLBACK) keys.push(env.LLM_API_KEY_FALLBACK);
  return keys;
}

/** MiniMax base_resp 里"账号类"错误码 → 应切兜底 key 重试 */
const ACCOUNT_LEVEL_STATUS = new Set<number>([
  1004, // invalid key
  1008, // 余额不足
  1011, // 配额限制
  1013, // 触发频控
  1027, // 调用频率超限
  1039, // 触发 RPM 限流
]);

/** HTTP 状态码 → 应切兜底 key 重试(quota/key 类) */
function isHttpFallbackStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 429 ||
    status >= 500
  );
}

/** Bearer 认证 + JSON 的统一 fetch helper(带 key fallback) */
export async function MiniMaxFetch<T>(
  env: Bindings,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const keys = collectKeys(env);
  if (keys.length === 0) throw new Error("no LLM_API_KEY configured");

  const url = path.startsWith("http") ? path : `${MiniMax_BASE}${path}`;
  let lastErr: Error = new Error("no attempt");

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${key}`);
    if (init.body && !headers.has("content-type") && typeof init.body === "string") {
      headers.set("content-type", "application/json");
    }

    try {
      const resp = await fetch(url, { ...init, headers });

      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        const err = new Error(
          `MiniMax HTTP ${resp.status} (key #${i + 1}): ${t.slice(0, 300)}`,
        );
        if (isHttpFallbackStatus(resp.status) && i < keys.length - 1) {
          lastErr = err;
          continue;
        }
        throw err;
      }

      // MiniMax 部分 API 用 base_resp 报账号类错误,HTTP 仍是 200
      const json = (await resp.json()) as T & {
        base_resp?: { status_code?: number; status_msg?: string };
      };
      const status = json?.base_resp?.status_code;
      if (status !== undefined && status !== 0) {
        const msg = json.base_resp?.status_msg ?? "";
        const err = new Error(
          `MiniMax base_resp.status_code=${status} (key #${i + 1}): ${msg}`,
        );
        if (ACCOUNT_LEVEL_STATUS.has(status) && i < keys.length - 1) {
          lastErr = err;
          continue;
        }
        throw err;
      }
      return json;
    } catch (e) {
      // 网络异常 / fetch 抛错 → 切下一个
      if (i < keys.length - 1) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/** 把我们 KV 里的文件中转上传到 MiniMax 文件管理,返回 file_id */
async function uploadToMiniMax(
  env: Bindings,
  fileRef: FileRef,
  purpose: "voice_clone" | "prompt_audio" | "t2a_async_input",
): Promise<number> {
  const buf = await env.FILES.get(fileRef.fileKey, "arrayBuffer");
  if (!buf) throw new Error(`file not found: ${fileRef.fileKey}`);

  const keys = collectKeys(env);
  if (keys.length === 0) throw new Error("no LLM_API_KEY configured");

  let lastErr: Error = new Error("no attempt");
  for (let i = 0; i < keys.length; i++) {
    const fd = new FormData();
    fd.append("purpose", purpose);
    fd.append(
      "file",
      new Blob([buf], { type: fileRef.contentType }),
      fileRef.name,
    );
    try {
      const resp = await fetch(`${MiniMax_BASE}/v1/files/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${keys[i]}` },
        body: fd,
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        const err = new Error(
          `MiniMax upload ${resp.status} (key #${i + 1}): ${t.slice(0, 300)}`,
        );
        if (isHttpFallbackStatus(resp.status) && i < keys.length - 1) {
          lastErr = err;
          continue;
        }
        throw err;
      }
      const data = (await resp.json()) as {
        file?: { file_id?: number };
        base_resp?: { status_code?: number };
      };
      if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
        if (
          ACCOUNT_LEVEL_STATUS.has(data.base_resp.status_code) &&
          i < keys.length - 1
        ) {
          lastErr = new Error(`MiniMax upload base_resp=${data.base_resp.status_code}`);
          continue;
        }
      }
      if (!data.file?.file_id) throw new Error("MiniMax upload: no file_id");
      return data.file.file_id;
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

/** KV 里的图片 → base64 data URL(给 i2i/i2v 用) */
async function fileRefToDataUrl(
  env: Bindings,
  fileRef: FileRef,
): Promise<string> {
  const buf = await env.FILES.get(fileRef.fileKey, "arrayBuffer");
  if (!buf) throw new Error(`file not found: ${fileRef.fileKey}`);
  return `data:${fileRef.contentType};base64,${arrayBufferToBase64(buf)}`;
}

/** 通过 file_id 拿 MiniMax 上的文件下载 URL */
async function retrieveHjbhxegFileUrl(
  env: Bindings,
  fileId: string | number,
): Promise<string> {
  const data = await MiniMaxFetch<{ file?: { download_url?: string } }>(
    env,
    `/v1/files/retrieve?file_id=${fileId}`,
  );
  if (!data.file?.download_url) throw new Error("no download_url for file");
  return data.file.download_url;
}

/** Hex 字符串 → Uint8Array(TTS 返回 hex 解码用) */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

interface ExecContext {
  vars: Record<string, unknown>;
  env: Bindings;
}

/** LLM 节点的 data 形状(P4 会扩展) */
interface LLMNodeData {
  prompt?: string;
  system?: string;
  model?: string;
  maxTokens?: number;
}

/** Output 节点的 data 形状 */
interface OutputNodeData {
  from?: string; // 模板字符串,如 "{{node1}}"
}

/** HTTP 节点 — 调外部 API */
interface HttpNodeData {
  url?: string; // 模板
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: string; // 模板,JSON / form / 纯文本
}

/** Code 节点 — 执行 JS 片段 */
interface CodeNodeData {
  /** 函数体;签名 (vars) => any。可以 return Promise(会被 await) */
  code?: string;
}

/** Input 节点 — P3 加了默认值 */
interface InputNodeData {
  default?: string;
}

/**
 * 执行单个节点 — 返回输出值 + 中间过程通过 yield 推 SSE 事件
 */
async function* execNode(
  node: NodeDef,
  ctx: ExecContext,
): AsyncGenerator<RunStreamEvent, unknown, unknown> {
  yield { type: "node_start", nodeId: node.id };

  switch (node.type) {
    case "input": {
      // 优先用 inputs 字典传入的值,其次用画布上配的 default
      const data = (node.data ?? {}) as InputNodeData;
      const provided = ctx.vars[node.id];
      const out =
        provided !== undefined && provided !== null && provided !== ""
          ? provided
          : (data.default ?? null);
      ctx.vars[node.id] = out; // 写回方便 LLM 引用
      yield { type: "node_end", nodeId: node.id, output: out };
      return out;
    }

    case "output": {
      const data = (node.data ?? {}) as OutputNodeData;
      const value = data.from ? resolveTemplate(data.from, ctx.vars) : "";
      yield { type: "node_end", nodeId: node.id, output: value };
      return value;
    }

    case "llm": {
      const data = (node.data ?? {}) as LLMNodeData;
      // MiniMax Anthropic 兼容端点不支持 image/document content block,
      // 所以遇到 FileRef 引用时,在文本中以 [文件:name] 占位代替(不 inline)
      const prompt = resolveTemplate(data.prompt ?? "", ctx.vars);
      const system = data.system
        ? resolveTemplate(data.system, ctx.vars)
        : undefined;

      const adapter = getAdapter("MiniMax", ctx.env);
      let accumulated = "";

      for await (const chunk of adapter.stream({
        model: data.model ?? ctx.env.LLM_DEFAULT_MODEL,
        messages: [{ role: "user", content: prompt }],
        ...(system ? { system } : {}),
        maxTokens: data.maxTokens ?? 2048,
      })) {
        if (chunk.delta) {
          accumulated = chunk.text;
          yield {
            type: "node_delta",
            nodeId: node.id,
            delta: chunk.delta,
          };
        }
      }

      yield { type: "node_end", nodeId: node.id, output: accumulated };
      return accumulated;
    }

    case "http": {
      const data = (node.data ?? {}) as HttpNodeData;
      const url = resolveTemplate(data.url ?? "", ctx.vars);
      if (!url) throw new Error("http node: url is required");
      const method = data.method ?? "GET";
      const headers: Record<string, string> = { ...(data.headers ?? {}) };
      // 把 headers 的值也走模板
      for (const k of Object.keys(headers)) {
        headers[k] = resolveTemplate(headers[k] ?? "", ctx.vars);
      }
      const bodyTpl = data.body ?? "";
      const body =
        bodyTpl && method !== "GET"
          ? resolveTemplate(bodyTpl, ctx.vars)
          : undefined;

      // body 默认带上 JSON content-type(若未显式设置)
      if (body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
        headers["content-type"] = "application/json";
      }

      const resp = await fetch(url, { method, headers, body });
      const ct = resp.headers.get("content-type") ?? "";
      let result: unknown;
      if (ct.includes("application/json")) {
        result = await resp.json().catch(() => null);
      } else {
        result = await resp.text();
      }

      if (!resp.ok) {
        const preview =
          typeof result === "string"
            ? result.slice(0, 300)
            : JSON.stringify(result).slice(0, 300);
        throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${preview}`);
      }

      yield { type: "node_end", nodeId: node.id, output: result };
      return result;
    }

    case "code": {
      const data = (node.data ?? {}) as CodeNodeData;
      const code = (data.code ?? "").trim();
      if (!code) throw new Error("code node: code is required");

      // 注意:Cloudflare Workers 默认禁用动态代码执行(eval/Function),
      // 但 wrangler 配置 nodejs_compat + globalThis 限定下,Function 构造在 Workers 环境是可用的。
      // 用户代码以 vars 为唯一参数,strict mode,签名 (vars) => any
      let result: unknown;
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(
          "vars",
          `"use strict";\nreturn (async (vars) => {\n${code}\n})(vars);`,
        ) as (vars: Record<string, unknown>) => Promise<unknown>;
        result = await fn(ctx.vars);
      } catch (e) {
        throw new Error(
          `code node error: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      yield { type: "node_end", nodeId: node.id, output: result };
      return result;
    }

    // ─── P7 创作工具箱 ──────────────────────────────────────────────

    case "t2i": {
      const data = (node.data ?? {}) as {
        model?: string;
        prompt?: string;
        aspect_ratio?: string;
        n?: number;
      };
      const prompt = resolveTemplate(data.prompt ?? "", ctx.vars);
      if (!prompt) throw new Error("t2i: prompt is required");
      yield { type: "node_delta", nodeId: node.id, delta: "调用 MiniMax 文生图…" };
      const resp = await MiniMaxFetch<{
        data?: { image_urls?: string[] };
      }>(ctx.env, "/v1/image_generation", {
        method: "POST",
        body: JSON.stringify({
          model: data.model || "image-01",
          prompt,
          aspect_ratio: data.aspect_ratio || "1:1",
          n: data.n || 1,
          response_format: "url",
        }),
      });
      const urls = resp.data?.image_urls ?? [];
      const output = { kind: "image" as const, urls };
      yield { type: "node_end", nodeId: node.id, output };
      return output;
    }

    case "i2i": {
      const data = (node.data ?? {}) as {
        model?: string;
        prompt?: string;
        image_input?: string;
        aspect_ratio?: string;
        n?: number;
      };
      const prompt = resolveTemplate(data.prompt ?? "", ctx.vars);
      const refId = data.image_input ?? "";
      const ref = ctx.vars[refId];
      if (!isFileRef(ref)) {
        throw new Error(
          `i2i: image_input '${refId}' is not a file (got ${typeof ref})`,
        );
      }
      yield { type: "node_delta", nodeId: node.id, delta: "加载图片…" };
      const dataUrl = await fileRefToDataUrl(ctx.env, ref);
      yield { type: "node_delta", nodeId: node.id, delta: "\n调用图生图…" };
      const resp = await MiniMaxFetch<{
        data?: { image_urls?: string[] };
      }>(ctx.env, "/v1/image_generation", {
        method: "POST",
        body: JSON.stringify({
          model: data.model || "image-01",
          prompt: prompt || "保持原图主体",
          subject_reference: [
            { type: "character", image_file: [dataUrl] },
          ],
          aspect_ratio: data.aspect_ratio || "1:1",
          n: data.n || 1,
          response_format: "url",
        }),
      });
      const urls = resp.data?.image_urls ?? [];
      const output = { kind: "image" as const, urls };
      yield { type: "node_end", nodeId: node.id, output };
      return output;
    }

    case "i2v": {
      const data = (node.data ?? {}) as {
        model?: string;
        prompt?: string;
        image_input?: string;
        duration?: number;
        resolution?: string;
      };
      const prompt = resolveTemplate(data.prompt ?? "", ctx.vars);
      const refId = data.image_input ?? "";
      const ref = ctx.vars[refId];
      if (!isFileRef(ref)) {
        throw new Error(`i2v: image_input '${refId}' is not a file`);
      }
      yield { type: "node_delta", nodeId: node.id, delta: "加载图片…" };
      const dataUrl = await fileRefToDataUrl(ctx.env, ref);
      yield { type: "node_delta", nodeId: node.id, delta: "\n提交视频任务…" };
      const taskResp = await MiniMaxFetch<{ task_id: string }>(
        ctx.env,
        "/v1/video_generation",
        {
          method: "POST",
          body: JSON.stringify({
            model: data.model || "MiniMax-Hailuo-2.3",
            prompt,
            first_frame_image: dataUrl,
            duration: data.duration ?? 6,
            resolution: data.resolution || "768P",
          }),
        },
      );
      yield {
        type: "node_delta",
        nodeId: node.id,
        delta: `\ntask_id=${taskResp.task_id},轮询中…`,
      };
      // 轮询(每 5s 一次,最多 5min)
      const MAX_ATTEMPTS = 60;
      let fileId = "";
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const q = await MiniMaxFetch<{
          status: string;
          file_id?: string;
        }>(ctx.env, `/v1/query/video_generation?task_id=${taskResp.task_id}`);
        yield {
          type: "node_delta",
          nodeId: node.id,
          delta: `\n[${q.status}]`,
        };
        if (q.status === "Success" && q.file_id) {
          fileId = q.file_id;
          break;
        }
        if (q.status === "Fail") {
          throw new Error("视频任务失败");
        }
      }
      if (!fileId) throw new Error("视频任务超时(>5min)");
      yield {
        type: "node_delta",
        nodeId: node.id,
        delta: "\n获取下载链接…",
      };
      const url = await retrieveHjbhxegFileUrl(ctx.env, fileId);
      const output = { kind: "video" as const, url };
      yield { type: "node_end", nodeId: node.id, output };
      return output;
    }

    case "voice_clone": {
      const data = (node.data ?? {}) as {
        audio_input?: string;
        voice_id?: string;
      };
      const refId = data.audio_input ?? "";
      const ref = ctx.vars[refId];
      if (!isFileRef(ref)) {
        throw new Error(`voice_clone: audio_input '${refId}' is not a file`);
      }
      yield {
        type: "node_delta",
        nodeId: node.id,
        delta: "上传音频到 MiniMax…",
      };
      const fileId = await uploadToMiniMax(ctx.env, ref, "voice_clone");
      yield {
        type: "node_delta",
        nodeId: node.id,
        delta: `\nfile_id=${fileId},注册音色…`,
      };
      // voice_id 必须英文字母开头,8-256 字符
      const voiceId =
        (data.voice_id && data.voice_id.trim()) ||
        `Vn${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
      await MiniMaxFetch(ctx.env, "/v1/voice_clone", {
        method: "POST",
        body: JSON.stringify({
          file_id: fileId,
          voice_id: voiceId,
        }),
      });
      const output = { kind: "voice_id" as const, voice_id: voiceId };
      yield { type: "node_end", nodeId: node.id, output };
      return output;
    }

    case "tts": {
      const data = (node.data ?? {}) as {
        model?: string;
        text?: string;
        voice_id?: string;
        speed?: number;
        vol?: number;
        pitch?: number;
      };
      const text = resolveTemplate(data.text ?? "", ctx.vars);
      if (!text) throw new Error("tts: text is required");

      // voice_id 也可以模板引用前序 voice_clone 节点;支持
      // {{vc1.voice_id}} 或 {{vc1}}(若直接是 voice_id 字符串)
      let voiceId = resolveTemplate(data.voice_id ?? "", ctx.vars).trim();
      // 如果 vars[voiceId] 是 voice_clone 输出对象,自动取 voice_id 字段
      if (!voiceId) {
        // 模板内直接引用了 voice_clone 节点 → ctx.vars[id] 是 { kind, voice_id }
        const refKey = (data.voice_id ?? "").trim().replace(/^\{\{|\}\}$/g, "");
        const v = ctx.vars[refKey];
        if (v && typeof v === "object" && "voice_id" in v) {
          voiceId = String((v as { voice_id: string }).voice_id);
        }
      }
      if (!voiceId) {
        throw new Error("tts: voice_id is required (系统音色 id 或克隆音色 id)");
      }

      yield {
        type: "node_delta",
        nodeId: node.id,
        delta: "调用文转语音…",
      };
      const resp = await MiniMaxFetch<{
        data?: { audio?: string };
      }>(ctx.env, "/v1/t2a_v2", {
        method: "POST",
        body: JSON.stringify({
          model: data.model || "speech-02-hd",
          text,
          voice_setting: {
            voice_id: voiceId,
            speed: data.speed ?? 1,
            vol: data.vol ?? 1,
            pitch: data.pitch ?? 0,
          },
          audio_setting: { format: "mp3", channel: 1 },
        }),
      });
      const hex = resp.data?.audio ?? "";
      if (!hex) throw new Error("tts: no audio in response");
      const bytes = hexToBytes(hex);
      const fileKey = `tts-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}.mp3`;
      await ctx.env.FILES.put(fileKey, bytes.buffer as ArrayBuffer, {
        metadata: {
          contentType: "audio/mpeg",
          size: bytes.byteLength,
          name: `tts-${Date.now()}.mp3`,
          uploadedAt: Date.now(),
        },
      });
      const output = {
        kind: "audio" as const,
        fileKey,
        contentType: "audio/mpeg",
      };
      yield { type: "node_end", nodeId: node.id, output };
      return output;
    }

    default: {
      // P4 阶段实现:http / condition / code
      const err = `node type '${node.type}' not implemented (coming in P4)`;
      yield { type: "error", message: err };
      throw new Error(err);
    }
  }
}

// ─── 整体执行入口 ─────────────────────────────────────────────────────

/**
 * 执行整个工作流,流式 yield 事件序列
 *
 * @param wf      工作流定义
 * @param inputs  input 节点的初始值,key 是 input 节点的 id
 * @param env     Workers Bindings(KV / 模型配置 / secrets)
 */
export async function* runWorkflow(
  wf: WorkflowDef,
  inputs: Record<string, unknown>,
  env: Bindings,
): AsyncGenerator<RunStreamEvent, void, unknown> {
  // 1) 拓扑排序(可能抛环检测错误)
  let order: string[];
  try {
    order = topoSort(wf.nodes, wf.edges);
  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : String(e) };
    return;
  }

  const nodeMap = new Map<string, NodeDef>(wf.nodes.map((n) => [n.id, n]));

  // 2) 初始化执行上下文 — input 节点的初始值预填到 vars
  const ctx: ExecContext = { vars: {}, env };
  for (const n of wf.nodes) {
    if (n.type === "input") {
      ctx.vars[n.id] = inputs[n.id] ?? null;
    }
  }

  // 3) 按拓扑序逐节点执行,事件流穿透 yield
  try {
    for (const id of order) {
      const node = nodeMap.get(id);
      if (!node) continue;
      const output = yield* execNode(node, ctx);
      ctx.vars[id] = output;
    }
    yield { type: "done" };
  } catch (e) {
    yield {
      type: "error",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
