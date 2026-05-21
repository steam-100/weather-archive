/**
 * 运行面板 — 底部抽屉,SSE 流式渲染
 *
 * 输入区:每个 Input 节点一个输入框 + ▶ 开始运行按钮
 * 输出区:每个执行过的节点一个卡片,LLM 节点实时打字机
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeDef, RunStreamEvent, FileRef } from "@app/shared";
import { isFileRef } from "@app/shared";
import { api } from "../lib/api";
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
  output?: unknown;
  status: NodeStatus;
}

export default function RunPanel({ workflowId, nodes, onClose }: RunPanelProps) {
  const inputNodes = useMemo(
    () => nodes.filter((n) => n.type === "input"),
    [nodes],
  );  const [inputs, setInputs] = useState<Record<string, string | FileRef>>({});
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [uploadError, setUploadError] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [nodeStates, setNodeStates] = useState<Record<string, NodeRunState>>({});
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // 初始化 / 同步 inputs(节点增减或默认值变化时)
  useEffect(() => {
    setInputs((prev) => {
      const next: Record<string, string | FileRef> = {};
      for (const n of inputNodes) {
        const data = (n.data ?? {}) as { default?: string; kind?: string };
        const kind = data.kind ?? "text";
        if (prev[n.id] !== undefined) {
          next[n.id] = prev[n.id]!;
        } else if (kind === "text") {
          next[n.id] = data.default ?? "";
        } else {
          next[n.id] = ""; // 文件类型,等用户上传
        }
      }
      return next;
    });
  }, [inputNodes]);

  async function handleFileSelect(nodeId: string, file: File) {
    setUploading((prev) => ({ ...prev, [nodeId]: true }));
    setUploadError((prev) => ({ ...prev, [nodeId]: "" }));
    try {
      const r = await api.uploadFile(file);
      const ref: FileRef = {
        fileKey: r.key,
        contentType: r.contentType,
        name: r.name,
        size: r.size,
      };
      setInputs((prev) => ({ ...prev, [nodeId]: ref }));
    } catch (e) {
      setUploadError((prev) => ({
        ...prev,
        [nodeId]: e instanceof Error ? e.message : "上传失败",
      }));
    } finally {
      setUploading((prev) => ({ ...prev, [nodeId]: false }));
    }
  }

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
                  output: evt.output,
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
            <div className="space-y-3">
              {inputNodes.map((n) => {
                const data = (n.data ?? {}) as {
                  default?: string;
                  kind?: "text" | "image" | "audio";
                };
                const kind = data.kind ?? "text";
                const v = inputs[n.id];
                const isUploading = uploading[n.id] ?? false;
                const upErr = uploadError[n.id];

                return (
                  <div key={n.id}>
                    <label className="block text-xs font-mono text-slate-500 mb-1">
                      {n.id}
                      {kind !== "text" && (
                        <span className="ml-1.5 text-slate-400">
                          ({kind === "image" ? "🖼️ image" : "🎵 audio"})
                        </span>
                      )}
                    </label>

                    {kind === "text" ? (
                      <input
                        type="text"
                        value={typeof v === "string" ? v : ""}
                        onChange={(e) =>
                          setInputs((prev) => ({
                            ...prev,
                            [n.id]: e.target.value,
                          }))
                        }
                        disabled={running}
                        className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:bg-slate-100"
                        placeholder={`输入 ${n.id} 的值`}
                      />
                    ) : (
                      <FilePicker
                        accept={kind === "image" ? "image/*" : "audio/*"}
                        value={isFileRef(v) ? v : null}
                        uploading={isUploading}
                        error={upErr}
                        disabled={running}
                        onSelect={(f) => handleFileSelect(n.id, f)}
                        onClear={() =>
                          setInputs((prev) => ({ ...prev, [n.id]: "" }))
                        }
                      />
                    )}
                  </div>
                );
              })}
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
                  n.type === "output" ? "📤" :
                  n.type === "http" ? "🌐" :
                  n.type === "code" ? "💻" :
                  n.type === "t2i" ? "🎨" :
                  n.type === "i2i" ? "🖌️" :
                  n.type === "i2v" ? "🎬" :
                  n.type === "voice_clone" ? "🎤" :
                  n.type === "tts" ? "🔊" : "⚙️";
                const color =
                  n.type === "input" ? "border-emerald-200 bg-emerald-50" :
                  n.type === "llm" ? "border-violet-200 bg-violet-50" :
                  n.type === "output" ? "border-amber-200 bg-amber-50" :
                  n.type === "http" ? "border-sky-200 bg-sky-50" :
                  n.type === "code" ? "border-slate-200 bg-slate-50" :
                  n.type === "t2i" ? "border-fuchsia-200 bg-fuchsia-50" :
                  n.type === "i2i" ? "border-pink-200 bg-pink-50" :
                  n.type === "i2v" ? "border-blue-200 bg-blue-50" :
                  n.type === "voice_clone" ? "border-teal-200 bg-teal-50" :
                  n.type === "tts" ? "border-cyan-200 bg-cyan-50" :
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
                    <NodeOutput state={state} />
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

// ─── 节点输出渲染(根据 output.kind 切换 UI) ────────────────────────

function NodeOutput({ state }: { state: NodeRunState }) {
  const out = state.output;

  // 1. 创作类节点输出对象 — 按 kind 渲染
  if (out && typeof out === "object" && "kind" in out) {
    const o = out as {
      kind: string;
      urls?: string[];
      url?: string;
      voice_id?: string;
      fileKey?: string;
      contentType?: string;
    };
    if (o.kind === "image" && o.urls && o.urls.length > 0) {
      return (
        <div className="grid grid-cols-2 gap-2">
          {o.urls.map((u) => (
            <a
              key={u}
              href={u}
              target="_blank"
              rel="noopener noreferrer"
              className="block"
            >
              <img
                src={u}
                alt="generated"
                className="w-full rounded border border-slate-200 hover:opacity-90 transition-opacity"
              />
            </a>
          ))}
        </div>
      );
    }
    if (o.kind === "video" && o.url) {
      return (
        <video
          src={o.url}
          controls
          className="w-full max-h-96 rounded border border-slate-200 bg-black"
        >
          您的浏览器不支持 video 标签
        </video>
      );
    }
    if (o.kind === "audio" && o.fileKey) {
      return (
        <audio
          src={api.fileUrl(o.fileKey)}
          controls
          className="w-full"
        >
          您的浏览器不支持 audio 标签
        </audio>
      );
    }
    if (o.kind === "voice_id" && o.voice_id) {
      return (
        <div className="text-sm font-mono bg-white border border-slate-200 rounded px-3 py-2">
          🎤 voice_id ={" "}
          <code className="text-teal-700 font-bold">{o.voice_id}</code>
        </div>
      );
    }
  }

  // 2. 字符串(LLM 等):流式 pre 文本
  return (
    <pre className="text-sm text-slate-800 whitespace-pre-wrap break-words font-sans leading-relaxed">
      {state.text || (state.status === "running" ? "…" : "(空)")}
    </pre>
  );
}

// ─── 文件选择器组件 ──────────────────────────────────────────────────

interface FilePickerProps {
  accept: string;
  value: FileRef | null;
  uploading: boolean;
  error?: string;
  disabled: boolean;
  onSelect: (file: File) => void;
  onClear: () => void;
}

function FilePicker({
  accept,
  value,
  uploading,
  error,
  disabled,
  onSelect,
  onClear,
}: FilePickerProps) {
  if (uploading) {
    return (
      <div className="text-xs text-slate-500 italic bg-slate-50 border border-slate-200 rounded-md px-3 py-2">
        上传中…
      </div>
    );
  }

  if (value) {
    const isImage = value.contentType.startsWith("image/");
    const sizeKB = (value.size / 1024).toFixed(1);
    return (
      <div className="border border-slate-200 rounded-md p-2 bg-slate-50">
        <div className="flex items-center gap-2 text-xs">
          {isImage ? (
            <img
              src={api.fileUrl(value.fileKey)}
              alt={value.name}
              className="h-12 w-12 object-cover rounded border border-slate-200"
            />
          ) : (
            <span className="text-2xl">🎵</span>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-slate-700 truncate font-mono">
              {value.name}
            </div>
            <div className="text-slate-400">
              {value.contentType} · {sizeKB} KB
            </div>
          </div>
          <button
            onClick={onClear}
            disabled={disabled}
            className="text-xs text-slate-500 hover:text-red-600 underline disabled:opacity-30 px-2"
          >
            重选
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label
        className={`inline-block text-xs px-3 py-1.5 rounded-md border transition-colors cursor-pointer ${
          disabled
            ? "bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed"
            : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
        }`}
      >
        📎 选择文件
        <input
          type="file"
          accept={accept}
          className="hidden"
          disabled={disabled}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onSelect(f);
            e.currentTarget.value = ""; // 允许重选同名
          }}
        />
      </label>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
