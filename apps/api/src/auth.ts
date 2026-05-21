/**
 * 鉴权工具集 — 口令 hash + JWT cookie 中间件
 * 所有加密走 Web Crypto API(Workers 原生支持,无需额外包)
 */
import type { Context, MiddlewareHandler } from "hono";
import { sign, verify } from "hono/jwt";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import type { Bindings, Variables } from "./index";

/** Cookie 名 + token 有效期(30 天,家用方便) */
const COOKIE_NAME = "wa_auth";
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

/** 公开路径白名单,中间件会跳过这些 */
const PUBLIC_PATHS = new Set<string>([
  "/api/health",
  "/api/login",
  "/api/logout",
]);

/**
 * PBKDF2-SHA256 算口令哈希
 * @param passcode 明文口令
 * @param saltB64  可选 — 校验时传入存档的 salt;不传则随机生成(注册场景)
 * @returns "base64(salt)$base64(hash)" 格式
 */
export async function hashPasscode(
  passcode: string,
  saltB64?: string,
): Promise<string> {
  const enc = new TextEncoder();
  const salt = saltB64
    ? base64ToBytes(saltB64)
    : crypto.getRandomValues(new Uint8Array(16));

  // 导入口令作为 PBKDF2 base key
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passcode),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );

  // 100k 迭代足够防暴力,Workers CPU 限制内能扛
  const hashBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    baseKey,
    256,
  );

  return `${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(hashBits))}`;
}

/**
 * 常量时间比较两个 base64 字节串 — 防 timing attack
 */
function timingSafeEqualB64(a: string, b: string): boolean {
  const ba = base64ToBytes(a);
  const bb = base64ToBytes(b);
  if (ba.length !== bb.length) return false;
  let r = 0;
  for (let i = 0; i < ba.length; i++) {
    r |= ba[i]! ^ bb[i]!;
  }
  return r === 0;
}

/** 校验明文口令是否匹配存档 hash */
export async function verifyPasscode(
  passcode: string,
  storedHash: string,
): Promise<boolean> {
  const [saltB64, hashB64] = storedHash.split("$");
  if (!saltB64 || !hashB64) return false;
  const recomputed = await hashPasscode(passcode, saltB64);
  const [, recomputedHashB64] = recomputed.split("$");
  if (!recomputedHashB64) return false;
  return timingSafeEqualB64(recomputedHashB64, hashB64);
}

/** 签发 JWT 并下发 HttpOnly cookie */
export async function issueToken(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const token = await sign(
    {
      sub: "family",
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    },
    c.env.JWT_SECRET,
    "HS256",
  );

  // dev (http) 时不能加 Secure,且只能 Lax(浏览器拒绝 None+非 Secure)
  // 生产 (https) 跨域(Pages → Workers)需要 None + Secure 才能携带 cookie
  const isHttps = c.req.url.startsWith("https://");

  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: isHttps ? "None" : "Lax",
    secure: isHttps,
    path: "/",
    maxAge: TOKEN_TTL_SECONDS,
  });
}

/** 清除登录 cookie */
export function clearToken(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
): void {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

/**
 * Hono 鉴权中间件
 * - 白名单路径直通
 * - 其它路径必须带有效 JWT cookie,否则 401
 */
export const authGuard: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: Variables;
}> = async (c, next) => {
  if (PUBLIC_PATHS.has(c.req.path)) {
    return next();
  }

  const token = getCookie(c, COOKIE_NAME);
  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }

  try {
    const payload = await verify(token, c.env.JWT_SECRET, "HS256");
    c.set("user", payload as Variables["user"]);
    return next();
  } catch {
    return c.json({ error: "invalid_token" }, 401);
  }
};

// ─── Base64 helpers (Workers 没 Buffer,手写) ────────────────────────

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (const v of b) s += String.fromCharCode(v);
  return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
