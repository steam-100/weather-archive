/**
 * 文件上传 / 下载 — 走 FILES KV namespace
 *
 *   POST /api/files       multipart 上传 → 返回 key + meta
 *   GET  /api/files/:key  鉴权后下载(浏览器预览/前端 blob)
 *
 * 限制:
 *   - 单文件 ≤ 24MiB(KV value 上限 25MiB,留余量)
 *   - 仅允许 image/* audio/* application/pdf text/*
 *   - 所有路由受 authGuard 保护(白名单不包含 /api/files)
 */
import { Hono } from "hono";
import type { Bindings, Variables } from "../index";

export const filesRouter = new Hono<{
  Bindings: Bindings;
  Variables: Variables;
}>();

const MAX_SIZE = 24 * 1024 * 1024;
const ALLOWED_PREFIXES = [
  "image/",
  "audio/",
  "application/pdf",
  "text/",
];

interface FileMetadata {
  contentType: string;
  size: number;
  name: string;
  uploadedAt: number;
}

/** 从原始文件名提取一个安全的扩展名(纯字母数字,≤8 字符) */
function safeExt(filename: string): string {
  const last = filename.split(".").pop();
  if (!last) return "bin";
  const cleaned = last.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned.slice(0, 8) || "bin";
}

filesRouter.post("/", async (c) => {
  const body = await c.req.parseBody({ all: false });
  const raw = body["file"];

  if (!(raw instanceof File)) {
    return c.json({ error: "no_file_in_form_field_'file'" }, 400);
  }

  if (raw.size === 0) {
    return c.json({ error: "empty_file" }, 400);
  }
  if (raw.size > MAX_SIZE) {
    return c.json(
      { error: "too_large", maxBytes: MAX_SIZE, actualBytes: raw.size },
      413,
    );
  }

  const ct = raw.type || "application/octet-stream";
  if (!ALLOWED_PREFIXES.some((p) => ct.startsWith(p))) {
    return c.json({ error: "type_not_allowed", contentType: ct }, 415);
  }

  const key = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.${safeExt(raw.name)}`;
  const buf = await raw.arrayBuffer();

  const metadata: FileMetadata = {
    contentType: ct,
    size: raw.size,
    name: raw.name,
    uploadedAt: Date.now(),
  };

  await c.env.FILES.put(key, buf, { metadata });

  return c.json({
    key,
    contentType: ct,
    size: raw.size,
    name: raw.name,
  });
});

filesRouter.get("/:key", async (c) => {
  const key = c.req.param("key");
  const obj = await c.env.FILES.getWithMetadata<FileMetadata>(key, {
    type: "arrayBuffer",
  });
  if (!obj.value) {
    return c.json({ error: "not_found" }, 404);
  }
  return new Response(obj.value, {
    headers: {
      "content-type":
        obj.metadata?.contentType ?? "application/octet-stream",
      "content-length": String(
        obj.metadata?.size ?? obj.value.byteLength,
      ),
      "cache-control": "private, max-age=300",
    },
  });
});

filesRouter.delete("/:key", async (c) => {
  const key = c.req.param("key");
  await c.env.FILES.delete(key);
  return c.json({ ok: true });
});
