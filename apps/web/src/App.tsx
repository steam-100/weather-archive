/**
 * 路由分发
 *   /                      → 伪装首页(默认)
 *   /#/x9f3a/login        → 真入口登录页
 *   /#/x9f3a               → 工作流列表(受保护)
 *   /#/x9f3a/wf/:id       → 编辑器(P3-C 上线前的占位页)
 *   其它                    → 跳回伪装首页
 */
import { useEffect, type ReactNode } from "react";
import {
  HashRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
} from "react-router-dom";
import DecoyHome from "./pages/DecoyHome";
import Login from "./pages/Login";
import WorkflowList from "./pages/WorkflowList";
import Editor from "./pages/Editor";
import { useAuth } from "./lib/store";

function Protected({ children }: { children: ReactNode }) {
  const authed = useAuth((s) => s.authed);

  // 初次加载触发 /me 探测
  useEffect(() => {
    if (authed === null) {
      void useAuth.getState().init();
    }
  }, [authed]);

  if (authed === null) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-slate-400">
        ……
      </div>
    );
  }

  if (!authed) {
    return <RedirectToLogin />;
  }
  return <>{children}</>;
}

function RedirectToLogin() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate("/x9f3a/login", { replace: true });
  }, [navigate]);
  return null;
}

/** 编辑器路由 — 真正的 React Flow 画布(P3-C 已实现) */

export default function App() {
  return (
    <HashRouter>
      <Routes>
        {/* 默认:伪装天气存档 */}
        <Route path="/" element={<DecoyHome />} />

        {/* 真入口(混淆 token x9f3a) */}
        <Route path="/x9f3a/login" element={<Login />} />
        <Route
          path="/x9f3a"
          element={
            <Protected>
              <WorkflowList />
            </Protected>
          }
        />
        <Route
          path="/x9f3a/wf/:id"
          element={
            <Protected>
              <Editor />
            </Protected>
          }
        />

        {/* 兜底:其它都回伪装 */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
