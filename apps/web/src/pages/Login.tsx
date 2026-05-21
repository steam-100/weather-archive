/**
 * 登录页 — 真入口路径 /#/x9f3a/login
 * 输入口令 → 调 /api/login → 成功后跳 /#/x9f3a (列表页)
 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/store";
import { ApiError } from "../lib/api";

export default function Login() {
  const navigate = useNavigate();
  const login = useAuth((s) => s.login);
  const [passcode, setPasscode] = useState("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!passcode || pending) return;
    setPending(true);
    setErr(null);
    try {
      await login(passcode);
      navigate("/x9f3a", { replace: true });
    } catch (e) {
      if (e instanceof ApiError) {
        setErr(
          e.code === "wrong_passcode" || e.status === 401
            ? "口令不对,再试试。"
            : `登录失败:${e.message}`,
        );
      } else {
        setErr("网络异常,请稍后重试。");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-white border border-slate-200 rounded-xl shadow-sm p-8 space-y-5"
      >
        <div>
          <h1 className="text-xl font-medium text-slate-800">家里人通道</h1>
          <p className="mt-1 text-sm text-slate-500">输入口令进入。</p>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="passcode"
            className="block text-xs font-medium text-slate-600"
          >
            口令
          </label>
          <input
            id="passcode"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            disabled={pending}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm tracking-wider focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-slate-400 disabled:bg-slate-100"
          />
        </div>

        {err && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {err}
          </div>
        )}

        <button
          type="submit"
          disabled={pending || !passcode}
          className="w-full bg-slate-800 text-white text-sm font-medium py-2.5 rounded-md hover:bg-slate-700 disabled:bg-slate-400 disabled:cursor-not-allowed transition-colors"
        >
          {pending ? "正在进门…" : "进入"}
        </button>
      </form>
    </div>
  );
}
