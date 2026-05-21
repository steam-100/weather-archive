/**
 * 登录 / 登出 路由
 * POST /api/login  { passcode } → set cookie
 * POST /api/logout            → clear cookie
 */
import { Hono } from "hono";
import type { Bindings, Variables } from "../index";
import { verifyPasscode, issueToken, clearToken } from "../auth";

export const loginRouter = new Hono<{
  Bindings: Bindings;
  Variables: Variables;
}>();

loginRouter.post("/login", async (c) => {
  // 解析 body,失败给一个稳定的错误
  const body = await c.req
    .json<{ passcode?: unknown }>()
    .catch(() => ({}) as { passcode?: unknown });

  if (typeof body.passcode !== "string" || body.passcode.length === 0) {
    return c.json({ ok: false, error: "passcode_required" }, 400);
  }

  // 服务端未配 hash → 拒绝并提示
  if (!c.env.PASSCODE_HASH) {
    return c.json(
      { ok: false, error: "server_not_configured" },
      500,
    );
  }

  const ok = await verifyPasscode(body.passcode, c.env.PASSCODE_HASH);
  if (!ok) {
    return c.json({ ok: false, error: "wrong_passcode" }, 401);
  }

  await issueToken(c);
  return c.json({ ok: true });
});

loginRouter.post("/logout", (c) => {
  clearToken(c);
  return c.json({ ok: true });
});

/** 受鉴权保护 — 验证当前 token 是否仍有效(前端用来检查登录状态) */
loginRouter.get("/me", (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ ok: false }, 401);
  }
  return c.json({ ok: true, user });
});
