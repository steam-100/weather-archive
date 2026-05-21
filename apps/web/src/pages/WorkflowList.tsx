/**
 * 工作流列表页 — /#/x9f3a
 * - 拉所有工作流(/api/workflows GET)
 * - 新建按钮 → POST + 跳到编辑器
 * - 每行点击 → 进编辑器
 * - 删除按钮 → confirm + DELETE
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { WorkflowSummary } from "@app/shared";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/store";

/** 友好的相对时间("3 分钟前" / "2 小时前" / "5 天前" / 日期) */
function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}

export default function WorkflowList() {
  const navigate = useNavigate();
  const logout = useAuth((s) => s.logout);

  const [items, setItems] = useState<WorkflowSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState<boolean>(false);

  async function loadList() {
    setError(null);
    try {
      const { workflows } = await api.listWorkflows();
      setItems(workflows);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        navigate("/x9f3a/login", { replace: true });
        return;
      }
      const msg = e instanceof Error ? e.message : "加载失败";
      setError(msg);
      setItems([]);
    }
  }

  useEffect(() => {
    void loadList();
  }, []);

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    try {
      const { id } = await api.createWorkflow({
        name: "新建工作流",
        description: "",
        nodes: [],
        edges: [],
      });
      navigate(`/x9f3a/wf/${id}`);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "创建失败");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (busyId) return;
    if (
      !window.confirm(`确认删除工作流「${name || "未命名"}」?这个动作不能撤销。`)
    ) {
      return;
    }
    setBusyId(id);
    try {
      await api.deleteWorkflow(id);
      setItems((prev) => prev?.filter((w) => w.id !== id) ?? null);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusyId(null);
    }
  }

  async function handleLogout() {
    await logout();
    navigate("/x9f3a/login", { replace: true });
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* ─── Top bar ─── */}
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <h1 className="text-lg font-medium text-slate-800">我的工作流</h1>
          <div className="flex items-center gap-4">
            <button
              onClick={handleCreate}
              disabled={creating}
              className="bg-slate-800 text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-slate-700 disabled:bg-slate-400 disabled:cursor-not-allowed transition-colors"
            >
              {creating ? "创建中…" : "+ 新建"}
            </button>
            <button
              onClick={handleLogout}
              className="text-xs text-slate-500 hover:text-slate-800 transition-colors"
            >
              登出
            </button>
          </div>
        </div>
      </header>

      {/* ─── Main ─── */}
      <main className="max-w-4xl mx-auto px-6 py-8">
        {error && (
          <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-4 py-3 flex items-center justify-between">
            <span>{error}</span>
            <button
              onClick={() => loadList()}
              className="text-xs underline hover:no-underline ml-3"
            >
              重试
            </button>
          </div>
        )}

        {items === null ? (
          <div className="text-center text-sm text-slate-400 py-16">加载中…</div>
        ) : items.length === 0 ? (
          <div className="bg-white border border-dashed border-slate-300 rounded-lg p-16 text-center">
            <div className="text-4xl mb-3">📭</div>
            <p className="text-sm text-slate-500 mb-4">还没有工作流。</p>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="text-sm text-slate-800 underline hover:no-underline disabled:opacity-50"
            >
              新建第一个 →
            </button>
          </div>
        ) : (
          <ul className="space-y-3">
            {items.map((wf) => (
              <li
                key={wf.id}
                className="bg-white border border-slate-200 rounded-lg hover:shadow-md hover:border-slate-300 transition-all"
              >
                <div className="flex items-center">
                  <button
                    onClick={() => navigate(`/x9f3a/wf/${wf.id}`)}
                    className="flex-1 text-left p-4 min-w-0"
                  >
                    <div className="flex items-baseline gap-3">
                      <h2 className="text-base font-medium text-slate-800 truncate">
                        {wf.name || "(未命名)"}
                      </h2>
                      <span className="text-xs text-slate-400 shrink-0">
                        {formatRelativeTime(wf.updatedAt)}
                      </span>
                    </div>
                    {wf.description && (
                      <p className="mt-1 text-sm text-slate-500 truncate">
                        {wf.description}
                      </p>
                    )}
                  </button>
                  <button
                    onClick={() => handleDelete(wf.id, wf.name)}
                    disabled={busyId === wf.id}
                    className="text-xs text-slate-400 hover:text-red-600 disabled:opacity-30 px-4 py-4 border-l border-slate-100 self-stretch"
                  >
                    {busyId === wf.id ? "删除中…" : "删除"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
