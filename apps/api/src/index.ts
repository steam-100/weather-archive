/**
 * Cloudflare Workers entry — Hono app
 * 路由组织:
 *   公开:  GET  /api/health
 *           POST /api/login  POST /api/logout
 *   鉴权后: GET  /api/me  (校验 token 有效)
 *           TODO P1: /api/workflows (CRUD)
 *           TODO P2: POST /api/run  (SSE 流式)
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authGuard } from "./auth";
import { loginRouter } from "./routes/login";
import { workflowsRouter } from "./routes/workflows";
import { llmRouter } from "./routes/llm";
import { runRouter } from "./routes/run";

export type Bindings = {
  // KV (P1 后段才用到,先占位)
  KV: KVNamespace;
  // Public vars
  LLM_BASE_URL: string;
  LLM_DEFAULT_MODEL: string;
  // Secrets — wrangler secret put
  LLM_API_KEY: string;
  PASSCODE_HASH: string;
  JWT_SECRET: string;
};

export type Variables = {
  user: { sub: string; iat: number; exp: number };
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ─── 中间件 ───────────────────────────────────────────────────────────
// CORS — 允许 Pages 域名 + localhost dev,带 cookie
app.use(
  "/api/*",
  cors({
    origin: (origin) => {
      if (!origin) return "";
      // 任意 *.pages.dev 子域 + localhost(dev)
      if (origin.endsWith(".pages.dev")) return origin;
      if (
        origin.startsWith("http://localhost:") ||
        origin.startsWith("http://127.0.0.1:")
      ) {
        return origin;
      }
      return "";
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

// authGuard 内部已对公开路径白名单放行,所以可以全局挂
app.use("/api/*", authGuard);

// ─── 公开路由 ──────────────────────────────────────────────────────────
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    ts: Date.now(),
    model: c.env.LLM_DEFAULT_MODEL,
  }),
);

// /login + /logout 在白名单内,/me 受鉴权保护
app.route("/api", loginRouter);

// 工作流 CRUD(全部受鉴权保护)
app.route("/api/workflows", workflowsRouter);

// 模型连通性测试(P1 收尾;P2 会有真正的 /api/run 工作流执行)
app.route("/api/llm", llmRouter);

// 工作流执行(P2)— SSE 流式
app.route("/api/run", runRouter);

export default app;
