/**
 * 运行面板 — 底部抽屉,SSE 流式渲染
 *
 * 输入区:每个 Input 节点一个输入框 + ▶ 开始运行按钮
 * 输出区:每个执行过的节点一个卡片,LLM 节点实时打字机
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeDef, RunStreamEvent } from "@app/shared";
import { streamSSE } from "../lib/sse";

interface RunPanelProps {
  workflowId: string;
  nodes: NodeDef[];
  onClose: () => void;
}

type NodeStatus = "idle" | "running" | "done";

interface NodeRunState {
  nodeType: NodeDef["type"];
  text: string;
  status: NodeStatus;
}

export default function RunPanel({ workflowId, nodes, onClose }: RunPanelProps) {
  const inputNodes = useMemo(
    () => nodes.filter((n) => n.type === "input"),
    [nodes],
  );

  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [nodeStates, setNodeStates] = useState<Record<string, NodeRunState>>({});
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // 当画布的 input 节点增减或默认值变化时,补齐 / 删除 inputs key
  // 已有用户输入的优先保留;新增节点用其 default 字段预填
  useEffect(() => {
    setInputs((prev) => {
      const next: Record<string, string> = {};
      for (const n of inputNodes) {
        const def = (n.data as { default?: string } | undefined)?.default ?? "";
        next[n.id] = prev[n.id] !== undefined ? prev[n.id]! : def;
      }
      return next;
    });
  }, [inputNodes]);

  async function run() {
    if (running) return;
    setRunning(true);
    setError(null);
    setNodeStates({});

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      for await (const evt of streamSSE<RunStreamEvent>("/run", {
        method: "POST",
        body: JSON.stringify({ workflowId, inputs }),
        signal: ctrl.signal,
      })) {
        switch (evt.type) {
          case "node_start": {
            const n = nodes.find((x) => x.id === evt.nodeId);
            setNodeStates((prev) => ({
              ...prev,
              [evt.nodeId]: {
                nodeType: n?.type ?? "llm",
                text: "",
                status: "running",
              },
            }));
            break;
          }
          case "node_delta": {
            setNodeStates((prev) => {
              const cur = prev[evt.nodeId];
              if (!cur) return prev;
              return {
                ...prev,
                [evt.nodeId]: { ...cur, text: cur.text + evt.delta },
              };
            });
            break;
          }
          case "node_end": {
            setNodeStates((prev) => {
              const cur = prev[evt.nodeId];
              const newText =
                cur?.text ||
                (typeof evt.output === "string"
                  ? evt.output
                  : JSON.stringify(evt.output));
              return {
                ...prev,
                [evt.nodeId]: {
                  nodeType: cur?.nodeType ?? "llm",
                  text: newText,
                  status: "done",
                },
              };
            });
            break;
          }
          case "error": {
            setError(evt.message);
            break;
          }
          case "done":
            break;
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name !== "AbortError") {
        setError(e.message);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  // 输出区:按节点在工作流中的位置排列
  const orderedNodes = useMemo(
    () => nodes.filter((n) => nodeStates[n.id]),
    [nodes, nodeStates],
  );

  return (
    <div
      className="fixed bottom-0 left-0 right-0 bg-white border-t-2 border-slate-300 shadow-2xl flex flex-col"
      style={{ height: "55vh" }}
    >
      {/* 顶栏 */}
      <header className="px-5 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
        <h3 className="text-sm font-medium text-slate-800 flex items-center gap-2">
          <span>▶</span>
          <span>运行工作流</span>
          {running && (
            <span className="text-xs text-slate-500 ml-1 animate-pulse">
              进行中…
            </span>
          )}
        </h3>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-700 text-xl leading-none w-7 h-7 flex items-center justify-center"
          aria-label="关闭"
        >
          ×
        </button>
      </header>

      <div className="flex-1 overflow-auto p-5 space-y-5">
        {/* 输入区 */}
        <section>
          <h4 className="text-xs font-medium text-slate-600 uppercase tracking-wide mb-2">
            输入
          </h4>
          {inputNodes.length === 0 ? (
            <p className="text-xs text-slate-500 italic bg-slate-50 border border-slate-200 rounded-md p-3">
              这个工作流没有 Input 节点,运行不需要参数。
            </p>
          ) : (
            <div className="space-y-2">
              {inputNodes.map((n) => (
                <div key={n.id}>
                  <label className="block text-xs font-mono text-slate-500 mb-1">
                    {n.id}
                  </label>
                  <input
                    type="text"
                    value={inputs[n.id] ?? ""}
                    onChange={(e) =>
                      setInputs((prev) => ({ ...prev, [n.id]: e.target.value }))
                    }
                    disabled={running}
                    className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:bg-slate-100"
                    placeholder={`输入 ${n.id} 的值`}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="mt-3">
            <button
              onClick={running ? stop : run}
              className={`text-sm font-medium px-5 py-1.5 rounded-md text-white transition-colors ${
                running
                  ? "bg-red-500 hover:bg-red-600"
                  : "bg-slate-800 hover:bg-slate-700"
              }`}
            >
              {running ? "⏹ 停止" : "▶ 开始运行"}
            </button>
          </div>
        </section>

        {/* 错误 */}
        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-4 py-3">
            ❌ {error}
          </div>
        )}

        {/* 输出区 */}
        {orderedNodes.length > 0 && (
          <section>
            <h4 className="text-xs font-medium text-slate-600 uppercase tracking-wide mb-2">
              输出
            </h4>
            <div className="space-y-2">
              {orderedNodes.map((n) => {
                const state = nodeStates[n.id]!;
                const icon =
                  n.type === "input" ? "📥" :
                  n.type === "llm" ? "🤖" :
                  n.type === "output" ? "📤" : "⚙️";
                const color =
                  n.type === "input" ? "border-emerald-200 bg-emerald-50" :
                  n.type === "llm" ? "border-violet-200 bg-violet-50" :
                  n.type === "output" ? "border-amber-200 bg-amber-50" :
                  "border-slate-200 bg-slate-50";
                return (
                  <div
                    key={n.id}
                    className={`border rounded-md p-3 ${color}`}
                  >
                    <div className="flex items-center gap-2 text-xs font-mono text-slate-700 mb-1.5">
                      <span>{icon}</span>
                      <span className="font-semibold">{n.id}</span>
                      {state.status === "running" && (
                        <span className="text-slate-500 italic">流式中…</span>
                      )}
                      {state.status === "done" && (
                        <span className="text-green-700">✓</span>
                      )}
                    </div>
                    <pre className="text-sm text-slate-800 whitespace-pre-wrap break-words font-sans leading-relaxed">
                      {state.text ||
                        (state.status === "running" ? "…" : "(空)")}
                    </pre>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
