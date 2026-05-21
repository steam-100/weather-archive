/**
 * 工作流画布编辑器 — /#/x9f3a/wf/:id
 *
 * 功能:
 *   - React Flow 画布(拖拽节点 + 连线)
 *   - 3 种节点(input/llm/output),各有配色 + 图标
 *   - 工具栏:返回列表 / 重命名 / 添加节点 / 保存状态
 *   - 选中节点 → 右侧配置面板(prompt/from 等编辑)
 *   - Debounced 自动保存(1.5s)
 *
 * P3-C 范围;运行(/api/run SSE)放 P3-D
 */
import {
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  addEdge,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { WorkflowDef, NodeDef, EdgeDef } from "@app/shared";
import { api, ApiError } from "../lib/api";
import RunPanel from "../components/RunPanel";

// ─── 节点 data 类型 ──────────────────────────────────────────────────

type InputData = {
  label?: string;
  default?: string;
  /** 输入类型 — text 默认;image 给 I2V/T2I/I2I 用;audio 给 VoiceClone 用 */
  kind?: "text" | "image" | "audio";
};
type LLMData = { prompt?: string; maxTokens?: number; model?: string };
type OutputData = { from?: string };
type HttpData = {
  url?: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: string;
};
type CodeData = { code?: string };

type EditorNode = Node<InputData | LLMData | OutputData | HttpData | CodeData>;

// ─── 节点 UI 组件 ────────────────────────────────────────────────────

const NODE_BOX = "px-4 py-3 rounded-lg shadow-sm bg-white border-2 min-w-[180px] max-w-[260px]";
const HANDLE_BASE = "!border-2 !border-white !w-3 !h-3";

function InputNodeView({ id, data, selected }: NodeProps<Node<InputData>>) {
  const kind = data.kind ?? "text";
  const icon = kind === "image" ? "🖼️" : kind === "audio" ? "🎵" : "📥";
  const label = kind === "image" ? "Image" : kind === "audio" ? "Audio" : "Input";
  const preview = kind === "text" ? data.default?.trim() : null;
  return (
    <div className={`${NODE_BOX} ${selected ? "border-emerald-400" : "border-slate-200"}`}>
      <div className="flex items-center gap-2 text-emerald-700 text-xs font-medium uppercase tracking-wide">
        <span>{icon}</span>
        <span>{label}</span>
      </div>
      <div className="mt-1 text-xs text-slate-500 font-mono truncate">{id}</div>
      {preview && (
        <div
          className="mt-1 text-xs text-slate-600 break-words"
          style={{
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          “{preview}”
        </div>
      )}
      {kind !== "text" && (
        <div className="mt-1 text-xs text-slate-400 italic">运行时上传</div>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className={`${HANDLE_BASE} !bg-emerald-400`}
      />
    </div>
  );
}

// ─── P7 创作节点 ──────────────────────────────────────────────

type T2IData = {
  model?: string;
  prompt?: string;
  aspect_ratio?: string;
  n?: number;
};
type I2IData = T2IData & { image_input?: string };
type I2VData = {
  model?: string;
  prompt?: string;
  image_input?: string;
  duration?: number;
  resolution?: string;
};
type VoiceCloneData = {
  audio_input?: string;
  voice_id?: string;
};
type TTSData = {
  model?: string;
  text?: string;
  voice_id?: string;
  speed?: number;
  vol?: number;
  pitch?: number;
};

function T2INodeView({ data, selected }: NodeProps<Node<T2IData>>) {
  return (
    <div className={`${NODE_BOX} ${selected ? "border-fuchsia-400" : "border-slate-200"}`}>
      <Handle type="target" position={Position.Left} className={`${HANDLE_BASE} !bg-fuchsia-400`} />
      <div className="flex items-center gap-2 text-fuchsia-700 text-xs font-medium uppercase tracking-wide">
        <span>🎨</span><span>T2I</span>
      </div>
      <div className="mt-1 text-sm text-slate-700 break-words" style={{
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
      }}>
        {data.prompt?.trim() || <span className="text-slate-400 italic">未配 prompt</span>}
      </div>
      <Handle type="source" position={Position.Right} className={`${HANDLE_BASE} !bg-fuchsia-400`} />
    </div>
  );
}

function I2INodeView({ data, selected }: NodeProps<Node<I2IData>>) {
  return (
    <div className={`${NODE_BOX} ${selected ? "border-pink-400" : "border-slate-200"}`}>
      <Handle type="target" position={Position.Left} className={`${HANDLE_BASE} !bg-pink-400`} />
      <div className="flex items-center gap-2 text-pink-700 text-xs font-medium uppercase tracking-wide">
        <span>🖌️</span><span>I2I</span>
      </div>
      <div className="mt-1 text-xs text-slate-500 font-mono truncate">
        img: {data.image_input || "?"}
      </div>
      <div className="mt-0.5 text-sm text-slate-700 truncate">
        {data.prompt?.trim() || <span className="text-slate-400 italic">未配 prompt</span>}
      </div>
      <Handle type="source" position={Position.Right} className={`${HANDLE_BASE} !bg-pink-400`} />
    </div>
  );
}

function I2VNodeView({ data, selected }: NodeProps<Node<I2VData>>) {
  return (
    <div className={`${NODE_BOX} ${selected ? "border-blue-400" : "border-slate-200"}`}>
      <Handle type="target" position={Position.Left} className={`${HANDLE_BASE} !bg-blue-400`} />
      <div className="flex items-center gap-2 text-blue-700 text-xs font-medium uppercase tracking-wide">
        <span>🎬</span><span>I2V</span>
      </div>
      <div className="mt-1 text-xs text-slate-500 font-mono truncate">
        img: {data.image_input || "?"} · {data.duration ?? 6}s
      </div>
      <div className="mt-0.5 text-sm text-slate-700 truncate">
        {data.prompt?.trim() || <span className="text-slate-400 italic">未配 prompt</span>}
      </div>
      <Handle type="source" position={Position.Right} className={`${HANDLE_BASE} !bg-blue-400`} />
    </div>
  );
}

function VoiceCloneNodeView({ data, selected }: NodeProps<Node<VoiceCloneData>>) {
  return (
    <div className={`${NODE_BOX} ${selected ? "border-teal-400" : "border-slate-200"}`}>
      <Handle type="target" position={Position.Left} className={`${HANDLE_BASE} !bg-teal-400`} />
      <div className="flex items-center gap-2 text-teal-700 text-xs font-medium uppercase tracking-wide">
        <span>🎤</span><span>VoiceClone</span>
      </div>
      <div className="mt-1 text-xs text-slate-500 font-mono truncate">
        audio: {data.audio_input || "?"}
      </div>
      <div className="mt-0.5 text-xs text-slate-700 font-mono truncate">
        → {data.voice_id?.trim() || <span className="text-slate-400 italic">自动生成</span>}
      </div>
      <Handle type="source" position={Position.Right} className={`${HANDLE_BASE} !bg-teal-400`} />
    </div>
  );
}

function TTSNodeView({ data, selected }: NodeProps<Node<TTSData>>) {
  return (
    <div className={`${NODE_BOX} ${selected ? "border-cyan-400" : "border-slate-200"}`}>
      <Handle type="target" position={Position.Left} className={`${HANDLE_BASE} !bg-cyan-400`} />
      <div className="flex items-center gap-2 text-cyan-700 text-xs font-medium uppercase tracking-wide">
        <span>🔊</span><span>TTS</span>
      </div>
      <div className="mt-1 text-xs text-slate-500 font-mono truncate">
        voice: {data.voice_id?.trim() || "?"}
      </div>
      <div className="mt-0.5 text-sm text-slate-700 truncate">
        {data.text?.trim() || <span className="text-slate-400 italic">未配 text</span>}
      </div>
      <Handle type="source" position={Position.Right} className={`${HANDLE_BASE} !bg-cyan-400`} />
    </div>
  );
}

const NODE_TYPES = {
  input: InputNodeView,
  llm: LLMNodeView,
  output: OutputNodeView,
  http: HttpNodeView,
  code: CodeNodeView,
  t2i: T2INodeView,
  i2i: I2INodeView,
  i2v: I2VNodeView,
  voice_clone: VoiceCloneNodeView,
  tts: TTSNodeView,
};

function LLMNodeView({ data, selected }: NodeProps<Node<LLMData>>) {
  const preview = data.prompt?.trim();
  return (
    <div className={`${NODE_BOX} ${selected ? "border-violet-400" : "border-slate-200"}`}>
      <Handle
        type="target"
        position={Position.Left}
        className={`${HANDLE_BASE} !bg-violet-400`}
      />
      <div className="flex items-center gap-2 text-violet-700 text-xs font-medium uppercase tracking-wide">
        <span>🤖</span>
        <span>LLM</span>
      </div>
      <div className="mt-1 text-sm text-slate-700 break-words" style={{
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        overflow: "hidden",
      }}>
        {preview || <span className="text-slate-400 italic">未配置 prompt</span>}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className={`${HANDLE_BASE} !bg-violet-400`}
      />
    </div>
  );
}

function OutputNodeView({ data, selected }: NodeProps<Node<OutputData>>) {
  return (
    <div className={`${NODE_BOX} ${selected ? "border-amber-400" : "border-slate-200"}`}>
      <Handle
        type="target"
        position={Position.Left}
        className={`${HANDLE_BASE} !bg-amber-400`}
      />
      <div className="flex items-center gap-2 text-amber-700 text-xs font-medium uppercase tracking-wide">
        <span>📤</span>
        <span>Output</span>
      </div>
      <div className="mt-1 text-sm text-slate-700 truncate font-mono">
        {data.from || <span className="text-slate-400 italic">未配置 from</span>}
      </div>
    </div>
  );
}

function HttpNodeView({ data, selected }: NodeProps<Node<HttpData>>) {
  const method = data.method ?? "GET";
  const url = data.url?.trim();
  return (
    <div className={`${NODE_BOX} ${selected ? "border-sky-400" : "border-slate-200"}`}>
      <Handle
        type="target"
        position={Position.Left}
        className={`${HANDLE_BASE} !bg-sky-400`}
      />
      <div className="flex items-center gap-2 text-sky-700 text-xs font-medium uppercase tracking-wide">
        <span>🌐</span>
        <span>HTTP</span>
      </div>
      <div className="mt-1 text-xs flex items-baseline gap-1.5">
        <span className="font-mono font-semibold text-sky-700">{method}</span>
        <span className="text-slate-700 truncate font-mono">
          {url || <span className="italic text-slate-400">未配置 url</span>}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className={`${HANDLE_BASE} !bg-sky-400`}
      />
    </div>
  );
}

function CodeNodeView({ data, selected }: NodeProps<Node<CodeData>>) {
  const preview = data.code?.trim().split("\n")[0]?.slice(0, 40);
  return (
    <div className={`${NODE_BOX} ${selected ? "border-slate-500" : "border-slate-200"}`}>
      <Handle
        type="target"
        position={Position.Left}
        className={`${HANDLE_BASE} !bg-slate-500`}
      />
      <div className="flex items-center gap-2 text-slate-700 text-xs font-medium uppercase tracking-wide">
        <span>💻</span>
        <span>Code</span>
      </div>
      <div className="mt-1 text-xs text-slate-700 font-mono truncate">
        {preview || <span className="italic text-slate-400">未配置 code</span>}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className={`${HANDLE_BASE} !bg-slate-500`}
      />
    </div>
  );
}

// ─── 配置面板:右侧抽屉 ───────────────────────────────────────────────

interface ConfigPanelProps {
  node: EditorNode;
  onChange: (id: string, patch: Record<string, unknown>) => void;
  onClose: () => void;
  onDelete: (id: string) => void;
}

function ConfigPanel({ node, onChange, onClose, onDelete }: ConfigPanelProps) {
  return (
    <aside className="w-80 bg-white border-l border-slate-200 flex flex-col shrink-0">
      <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-800">
          {node.type === "input" && "📥 Input 节点"}
          {node.type === "llm" && "🤖 LLM 节点"}
          {node.type === "output" && "📤 Output 节点"}
          {node.type === "http" && "🌐 HTTP 节点"}
          {node.type === "code" && "💻 Code 节点"}
          {node.type === "t2i" && "🎨 T2I 文生图"}
          {node.type === "i2i" && "🖌️ I2I 图生图"}
          {node.type === "i2v" && "🎬 I2V 图生视频"}
          {node.type === "voice_clone" && "🎤 VoiceClone 声音克隆"}
          {node.type === "tts" && "🔊 TTS 文转语音"}
        </h3>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-700 text-xl leading-none w-6 h-6 flex items-center justify-center"
          aria-label="关闭"
        >
          ×
        </button>
      </header>

      <div className="flex-1 overflow-auto p-5 space-y-4">
        <Field
          label="ID(运行时输入字典 key)"
          value={node.id}
          disabled
          mono
        />

        {node.type === "input" && (
          <>
            <Select
              label="输入类型"
              value={(node.data as InputData).kind ?? "text"}
              onChange={(v) =>
                onChange(node.id, { kind: v as InputData["kind"] })
              }
              options={["text", "image"]}
              hint="image 类型由 RunPanel 上传文件,给 I2V 节点用"
            />
            {((node.data as InputData).kind ?? "text") === "text" && (
              <TextArea
                label="默认值(可选)"
                hint="运行时 RunPanel 会用这个值预填输入框"
                value={(node.data as InputData).default ?? ""}
                onChange={(v) => onChange(node.id, { default: v })}
                rows={4}
                placeholder="例:今天天气怎么样?"
              />
            )}
            {(node.data as InputData).kind === "image" && (
              <p className="text-xs text-slate-500 leading-relaxed bg-slate-50 border border-slate-200 rounded-md p-3">
                运行时,RunPanel 会显示文件选择按钮(JPG/PNG/WebP,&lt;20MB)。
              </p>
            )}
            <p className="text-xs text-slate-500 leading-relaxed bg-slate-50 border border-slate-200 rounded-md p-3">
              其它节点引用方式:
              <code className="block mt-1 text-slate-700 font-mono break-all">
                {`{{${node.id}}}`}
              </code>
            </p>
          </>
        )}

        {node.type === "llm" && (
          <>
            <TextArea
              label="Prompt 模板"
              hint="支持 {{nodeId}} 引用前序节点的输出(图片节点会显示为 [文件:name] 占位)"
              value={(node.data as LLMData).prompt ?? ""}
              onChange={(v) => onChange(node.id, { prompt: v })}
              rows={6}
              placeholder="例:用一句话回答:{{q}}"
            />
            <ComboBox
              label="模型(可选)"
              hint="MiniMax 文本模型,留空走默认 MiniMax-M2.7"
              value={(node.data as LLMData).model ?? ""}
              onChange={(v) => onChange(node.id, { model: v })}
              options={MODELS.text}
              placeholder="MiniMax-M2.7"
            />
            <NumberInput
              label="Max Tokens"
              hint="推理模型建议 ≥ 2048(留出思考空间)"
              value={(node.data as LLMData).maxTokens ?? 2048}
              onChange={(v) => onChange(node.id, { maxTokens: v })}
            />
          </>
        )}

        {node.type === "output" && (
          <Field
            label="From(模板引用)"
            hint="例:{{ai}} — 引用 LLM 节点的输出"
            value={(node.data as OutputData).from ?? ""}
            onChange={(v) => onChange(node.id, { from: v })}
            placeholder="{{ai}}"
            mono
          />
        )}

        {node.type === "http" && (
          <>
            <Field
              label="URL(模板)"
              hint="支持 {{nodeId}} 引用前序节点输出"
              value={(node.data as HttpData).url ?? ""}
              onChange={(v) => onChange(node.id, { url: v })}
              placeholder="https://api.example.com/q?keyword={{q}}"
              mono
            />
            <Select
              label="Method"
              value={(node.data as HttpData).method ?? "GET"}
              onChange={(v) =>
                onChange(node.id, { method: v as HttpData["method"] })
              }
              options={["GET", "POST", "PUT", "DELETE", "PATCH"]}
            />
            <TextArea
              label="Body(可选,模板)"
              hint="GET 请求会忽略 body;非 GET 时默认带 application/json"
              value={(node.data as HttpData).body ?? ""}
              onChange={(v) => onChange(node.id, { body: v })}
              rows={3}
              placeholder='{"q": "{{q}}"}'
            />
            <p className="text-xs text-slate-500 leading-relaxed bg-slate-50 border border-slate-200 rounded-md p-3">
              输出:JSON 自动 parse,其它走 text。后续节点可用{" "}
              <code className="font-mono">{`{{${node.id}}}`}</code>{" "}
              或 <code className="font-mono">{`{{${node.id}.field}}`}</code>{" "}
              引用响应字段。
            </p>
          </>
        )}

        {node.type === "code" && (
          <>
            <TextArea
              label="JavaScript 代码"
              hint="参数 vars 是所有前序节点的输出字典(strict mode + async,可 await)"
              value={(node.data as CodeData).code ?? ""}
              onChange={(v) => onChange(node.id, { code: v })}
              rows={10}
              placeholder={`// 例:把 LLM 输出转大写
return vars.ai.toUpperCase();`}
            />
            <p className="text-xs text-slate-500 leading-relaxed bg-slate-50 border border-slate-200 rounded-md p-3">
              函数签名:<code className="font-mono">async (vars) =&gt; any</code>
              <br />
              访问前序节点输出:<code className="font-mono">vars.nodeId</code>
              <br />
              ⚠️ 受 Workers 默认 10ms CPU 限制
            </p>
          </>
        )}

        {node.type === "t2i" && (
          <>
            <TextArea
              label="Prompt(文本描述)"
              hint="支持 {{nodeId}} 引用前序节点;最长 1500 字符"
              value={(node.data as T2IData).prompt ?? ""}
              onChange={(v) => onChange(node.id, { prompt: v })}
              rows={5}
              placeholder="例:水墨画风的山间小院,春雨初霁"
            />
            <ComboBox
              label="模型"
              value={(node.data as T2IData).model ?? ""}
              onChange={(v) => onChange(node.id, { model: v })}
              options={MODELS.image}
              placeholder="image-01"
              hint="image-01 标准 / image-01-live 漫画/水彩等画风"
            />
            <Select
              label="宽高比"
              value={(node.data as T2IData).aspect_ratio ?? "1:1"}
              onChange={(v) =>
                onChange(node.id, { aspect_ratio: v })
              }
              options={["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"]}
            />
            <NumberInput
              label="生成数量 (n)"
              hint="1-9 张"
              value={(node.data as T2IData).n ?? 1}
              onChange={(v) =>
                onChange(node.id, {
                  n: Math.max(1, Math.min(9, Math.floor(v))),
                })
              }
            />
          </>
        )}

        {node.type === "i2i" && (
          <>
            <Field
              label="图片输入节点 ID"
              hint="填一个 kind=image 的 Input 节点 id(参考主体图)"
              value={(node.data as I2IData).image_input ?? ""}
              onChange={(v) => onChange(node.id, { image_input: v })}
              placeholder="in_xxxxxx"
              mono
            />
            <TextArea
              label="Prompt(描述要修改的内容)"
              hint="例:把这个人变成动漫风格"
              value={(node.data as I2IData).prompt ?? ""}
              onChange={(v) => onChange(node.id, { prompt: v })}
              rows={4}
              placeholder="动漫风格、保持神态"
            />
            <ComboBox
              label="模型"
              value={(node.data as I2IData).model ?? ""}
              onChange={(v) => onChange(node.id, { model: v })}
              options={MODELS.image}
              placeholder="image-01"
            />
            <Select
              label="宽高比"
              value={(node.data as I2IData).aspect_ratio ?? "1:1"}
              onChange={(v) => onChange(node.id, { aspect_ratio: v })}
              options={["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"]}
            />
          </>
        )}

        {node.type === "i2v" && (
          <>
            <Field
              label="图片输入节点 ID"
              hint="填一个 kind=image 的 Input 节点 id(作为首帧)"
              value={(node.data as I2VData).image_input ?? ""}
              onChange={(v) => onChange(node.id, { image_input: v })}
              placeholder="in_xxxxxx"
              mono
            />
            <TextArea
              label="动作 / 镜头描述 (Prompt)"
              hint="支持 {{nodeId}};最长 2000 字符"
              value={(node.data as I2VData).prompt ?? ""}
              onChange={(v) => onChange(node.id, { prompt: v })}
              rows={4}
              placeholder="例:她笑着挥手,镜头缓缓推近"
            />
            <ComboBox
              label="模型"
              value={(node.data as I2VData).model ?? ""}
              onChange={(v) => onChange(node.id, { model: v })}
              options={MODELS.video}
              placeholder="MiniMax-Hailuo-2.3"
              hint="2.3 标准 / 2.3-Fast 快速 / I2V-01-Director 运镜版"
            />
            <Select
              label="时长(秒)"
              value={String((node.data as I2VData).duration ?? 6)}
              onChange={(v) => onChange(node.id, { duration: Number(v) })}
              options={["6", "10"]}
            />
            <Select
              label="分辨率"
              value={(node.data as I2VData).resolution ?? "768P"}
              onChange={(v) => onChange(node.id, { resolution: v })}
              options={["512P", "720P", "768P", "1080P"]}
            />
            <p className="text-xs text-slate-500 leading-relaxed bg-amber-50 border border-amber-200 rounded-md p-3">
              ⏰ 异步任务,通常需 30 秒~3 分钟。运行时会推送状态。
            </p>
          </>
        )}

        {node.type === "voice_clone" && (
          <>
            <Field
              label="音频输入节点 ID"
              hint="填一个 kind=audio 的 Input 节点 id(10秒~5分钟)"
              value={(node.data as VoiceCloneData).audio_input ?? ""}
              onChange={(v) =>
                onChange(node.id, { audio_input: v })
              }
              placeholder="in_xxxxxx"
              mono
            />
            <Field
              label="自定义音色 ID(可选)"
              hint="字母开头,8-256 字符;留空自动生成"
              value={(node.data as VoiceCloneData).voice_id ?? ""}
              onChange={(v) => onChange(node.id, { voice_id: v })}
              placeholder="VnMyMomVoice"
              mono
            />
            <p className="text-xs text-slate-500 leading-relaxed bg-slate-50 border border-slate-200 rounded-md p-3">
              输出 voice_id 字符串。后续 TTS 节点的「音色 ID」字段填{" "}
              <code className="font-mono">{`{{${node.id}.voice_id}}`}</code>{" "}
              即可用克隆音色合成语音。
              <br />⚠️ 7 天内未调用,音色会被 MiniMax 清理。
            </p>
          </>
        )}

        {node.type === "tts" && (
          <>
            <TextArea
              label="文本(要合成的话)"
              hint="支持 {{nodeId}};最长 10000 字符"
              value={(node.data as TTSData).text ?? ""}
              onChange={(v) => onChange(node.id, { text: v })}
              rows={4}
              placeholder="今天是妈妈的生日,生日快乐!"
            />
            <Field
              label="音色 ID"
              hint="系统音色名 / VoiceClone 输出。例:{{vc1.voice_id}}"
              value={(node.data as TTSData).voice_id ?? ""}
              onChange={(v) => onChange(node.id, { voice_id: v })}
              placeholder="male-qn-qingse / VnXxx"
              mono
            />
            <ComboBox
              label="模型"
              value={(node.data as TTSData).model ?? ""}
              onChange={(v) => onChange(node.id, { model: v })}
              options={MODELS.speech}
              placeholder="speech-02-hd"
              hint="hd 高保真 / turbo 快速"
            />
            <NumberInput
              label="语速 (speed)"
              hint="0.5-2.0,默认 1.0"
              value={(node.data as TTSData).speed ?? 1}
              onChange={(v) => onChange(node.id, { speed: v })}
            />
            <NumberInput
              label="音量 (vol)"
              hint="0.1-10,默认 1"
              value={(node.data as TTSData).vol ?? 1}
              onChange={(v) => onChange(node.id, { vol: v })}
            />
            <NumberInput
              label="音调 (pitch)"
              hint="-12 ~ 12,默认 0"
              value={(node.data as TTSData).pitch ?? 0}
              onChange={(v) => onChange(node.id, { pitch: v })}
            />
          </>
        )}
      </div>

      <footer className="px-5 py-3 border-t border-slate-200">
        <button
          onClick={() => onDelete(node.id)}
          className="text-xs text-slate-500 hover:text-red-600"
        >
          删除节点
        </button>
      </footer>
    </aside>
  );
}

// ─── 表单组件 ────────────────────────────────────────────────────────

function Field({
  label, value, onChange, disabled, placeholder, hint, mono,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className={`w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:bg-slate-100 disabled:text-slate-500 ${mono ? "font-mono" : ""}`}
      />
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function TextArea({
  label, value, onChange, rows = 4, placeholder, hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-400 resize-none"
      />
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function NumberInput({
  label, value, onChange, hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-400"
      />
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function Select({
  label, value, onChange, options, hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-400 bg-white"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

/**
 * 带 datalist 的 input — 老大可以下拉选,也能手敲新值
 * 用于模型名字段(预置 MiniMax 模型清单 + 兼容未来新模型)
 */
function ComboBox({
  label, value, onChange, options, hint, placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  hint?: string;
  placeholder?: string;
}) {
  const listId = `dl-${label.replace(/\s/g, "_")}-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={listId}
        placeholder={placeholder}
        className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-400"
      />
      <datalist id={listId}>
        {options.map((opt) => (
          <option key={opt} value={opt} />
        ))}
      </datalist>
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

// 模型清单(MiniMax 官方文档清单)— 各节点用对应集
const MODELS = {
  text: [
    "MiniMax-M2.7",
    "MiniMax-M2.7-highspeed",
    "MiniMax-M2.5",
    "MiniMax-M2.5-highspeed",
    "MiniMax-M2.1",
    "MiniMax-M2.1-highspeed",
    "MiniMax-M2",
  ],
  image: ["image-01", "image-01-live"],
  video: [
    "MiniMax-Hailuo-2.3",
    "MiniMax-Hailuo-2.3-Fast",
    "MiniMax-Hailuo-02",
    "I2V-01-Director",
    "I2V-01-live",
    "I2V-01",
  ],
  speech: [
    "speech-2.8-hd",
    "speech-2.8-turbo",
    "speech-2.6-hd",
    "speech-2.6-turbo",
    "speech-02-hd",
    "speech-02-turbo",
    "speech-01-hd",
    "speech-01-turbo",
  ],
};

// ─── 保存状态徽章 ────────────────────────────────────────────────────

type SaveState = "idle" | "saving" | "saved" | "error";

function SaveStatus({ status }: { status: SaveState }) {
  const text =
    status === "idle" ? "" :
    status === "saving" ? "保存中…" :
    status === "saved" ? "✓ 已保存" :
    "保存失败";
  const cls = status === "error" ? "text-red-600" : "text-slate-400";
  return <span className={`text-xs ${cls} min-w-[64px] text-right tabular-nums`}>{text}</span>;
}

// ─── 主 Editor ────────────────────────────────────────────────────────

function EditorInner() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [name, setName] = useState("加载中…");
  const [nodes, setNodes, onNodesChange] = useNodesState<EditorNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveState>("idle");
  const [showRun, setShowRun] = useState<boolean>(false);

  const loadedRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);

  // 加载工作流
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api
      .getWorkflow(id)
      .then(({ workflow }) => {
        if (cancelled) return;
        setName(workflow.name);
        setNodes(
          workflow.nodes.map<EditorNode>((n) => ({
            id: n.id,
            type: n.type,
            position: n.position,
            data: n.data as InputData | LLMData | OutputData,
          })),
        );
        setEdges(
          workflow.edges.map<Edge>((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            markerEnd: { type: MarkerType.ArrowClosed },
          })),
        );
        loadedRef.current = true;
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) {
          navigate("/x9f3a/login", { replace: true });
        } else {
          setLoadError(e instanceof Error ? e.message : "加载失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, navigate, setNodes, setEdges]);

  // 保存(实际请求)
  const save = useCallback(async () => {
    if (!id || !loadedRef.current) return;
    setSaveStatus("saving");
    try {
      const wf: Partial<WorkflowDef> = {
        name,
        nodes: nodes.map<NodeDef>((n) => ({
          id: n.id,
          type: n.type as NodeDef["type"],
          position: n.position,
          data: (n.data ?? {}) as Record<string, unknown>,
        })),
        edges: edges.map<EdgeDef>((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
        })),
      };
      await api.updateWorkflow(id, wf);
      setSaveStatus("saved");
      window.setTimeout(() => {
        setSaveStatus((s) => (s === "saved" ? "idle" : s));
      }, 1500);
    } catch {
      setSaveStatus("error");
    }
  }, [id, name, nodes, edges]);

  // Debounced 自动保存
  useEffect(() => {
    if (!loadedRef.current) return;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      void save();
    }, 1500);
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [name, nodes, edges, save]);

  // 添加节点
  const addNode = useCallback(
    (
      type:
        | "input"
        | "llm"
        | "output"
        | "http"
        | "code"
        | "t2i"
        | "i2i"
        | "i2v"
        | "voice_clone"
        | "tts",
    ) => {
      const idPrefix =
        type === "input" ? "in_" :
        type === "llm" ? "ai_" :
        type === "output" ? "out_" :
        type === "http" ? "http_" :
        type === "code" ? "code_" :
        type === "t2i" ? "t2i_" :
        type === "i2i" ? "i2i_" :
        type === "i2v" ? "i2v_" :
        type === "voice_clone" ? "vc_" :
        "tts_";
      const newId = idPrefix + crypto.randomUUID().slice(0, 6);
      const offset = nodes.length * 40;
      const baseData: Record<string, unknown> =
        type === "input" ? {} :
        type === "llm" ? { prompt: "", maxTokens: 2048 } :
        type === "output" ? { from: "" } :
        type === "http" ? { url: "", method: "GET" } :
        type === "code" ? { code: "" } :
        type === "t2i" ? { prompt: "", model: "image-01", aspect_ratio: "1:1", n: 1 } :
        type === "i2i" ? { prompt: "", image_input: "", model: "image-01", aspect_ratio: "1:1" } :
        type === "i2v" ? { prompt: "", image_input: "", model: "MiniMax-Hailuo-2.3", duration: 6, resolution: "768P" } :
        type === "voice_clone" ? { audio_input: "", voice_id: "" } :
        { text: "", voice_id: "", model: "speech-02-hd", speed: 1, vol: 1, pitch: 0 };
      setNodes((ns) => [
        ...ns,
        {
          id: newId,
          type,
          position: { x: 120 + offset, y: 120 + offset },
          data: baseData,
        } as EditorNode,
      ]);
    },
    [nodes.length, setNodes],
  );

  // 连线
  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((es) =>
        addEdge(
          {
            ...params,
            id: `e_${params.source}_${params.target}_${Date.now().toString(36).slice(-4)}`,
            markerEnd: { type: MarkerType.ArrowClosed },
          },
          es,
        ),
      );
    },
    [setEdges],
  );

  // 修改节点 data
  const updateNodeData = useCallback(
    (nodeId: string, patch: Record<string, unknown>) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === nodeId
            ? ({ ...n, data: { ...n.data, ...patch } } as EditorNode)
            : n,
        ),
      );
    },
    [setNodes],
  );

  // 删除节点
  const deleteNode = useCallback(
    (nodeId: string) => {
      if (!window.confirm("确认删除这个节点?连接也会一起删。")) return;
      setNodes((ns) => ns.filter((n) => n.id !== nodeId));
      setEdges((es) =>
        es.filter((e) => e.source !== nodeId && e.target !== nodeId),
      );
      setSelectedId(null);
    },
    [setNodes, setEdges],
  );

  const selectedNode = useMemo<EditorNode | null>(
    () => nodes.find((n) => n.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  if (loadError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center space-y-3">
          <p className="text-sm text-red-600">{loadError}</p>
          <button
            onClick={() => navigate("/x9f3a")}
            className="text-sm text-slate-600 underline"
          >
            ← 回到列表
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      {/* Top bar */}
      <header className="bg-white border-b border-slate-200 shrink-0">
        <div className="px-4 py-2.5 flex items-center gap-3">
          <button
            onClick={() => navigate("/x9f3a")}
            className="text-xs text-slate-500 hover:text-slate-800 px-2"
          >
            ← 列表
          </button>
          <div className="h-5 w-px bg-slate-200" />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="text-sm font-medium text-slate-800 bg-transparent border-0 border-b border-transparent hover:border-slate-300 focus:border-slate-400 focus:outline-none px-1 -mx-1 min-w-[200px] max-w-[400px]"
            placeholder="工作流名"
          />
          <div className="flex-1" />
          <button
            onClick={() => setShowRun((v) => !v)}
            className={`text-xs font-medium px-3 py-1 rounded-md border transition-colors ${
              showRun
                ? "bg-slate-800 text-white border-slate-800"
                : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
            }`}
          >
            ▶ 运行
          </button>
          <div className="h-5 w-px bg-slate-200" />
          <SaveStatus status={saveStatus} />
          <div className="h-5 w-px bg-slate-200" />
          <span className="text-xs text-slate-400">添加</span>
          <button
            onClick={() => addNode("input")}
            className="text-xs bg-emerald-50 text-emerald-700 hover:bg-emerald-100 px-2.5 py-1 rounded-md border border-emerald-200 transition-colors"
          >
            📥 Input
          </button>
          <button
            onClick={() => addNode("llm")}
            className="text-xs bg-violet-50 text-violet-700 hover:bg-violet-100 px-2.5 py-1 rounded-md border border-violet-200 transition-colors"
          >
            🤖 LLM
          </button>
          <button
            onClick={() => addNode("output")}
            className="text-xs bg-amber-50 text-amber-700 hover:bg-amber-100 px-2.5 py-1 rounded-md border border-amber-200 transition-colors"
          >
            📤 Output
          </button>
          <button
            onClick={() => addNode("http")}
            className="text-xs bg-sky-50 text-sky-700 hover:bg-sky-100 px-2.5 py-1 rounded-md border border-sky-200 transition-colors"
          >
            🌐 HTTP
          </button>
          <button
            onClick={() => addNode("code")}
            className="text-xs bg-slate-100 text-slate-700 hover:bg-slate-200 px-2.5 py-1 rounded-md border border-slate-300 transition-colors"
          >
            💻 Code
          </button>
          <div className="h-5 w-px bg-slate-200" />
          <span className="text-xs text-slate-400">创作</span>
          <button
            onClick={() => addNode("t2i")}
            className="text-xs bg-fuchsia-50 text-fuchsia-700 hover:bg-fuchsia-100 px-2.5 py-1 rounded-md border border-fuchsia-200 transition-colors"
          >
            🎨 T2I
          </button>
          <button
            onClick={() => addNode("i2i")}
            className="text-xs bg-pink-50 text-pink-700 hover:bg-pink-100 px-2.5 py-1 rounded-md border border-pink-200 transition-colors"
          >
            🖌️ I2I
          </button>
          <button
            onClick={() => addNode("i2v")}
            className="text-xs bg-blue-50 text-blue-700 hover:bg-blue-100 px-2.5 py-1 rounded-md border border-blue-200 transition-colors"
          >
            🎬 I2V
          </button>
          <button
            onClick={() => addNode("voice_clone")}
            className="text-xs bg-teal-50 text-teal-700 hover:bg-teal-100 px-2.5 py-1 rounded-md border border-teal-200 transition-colors"
          >
            🎤 Clone
          </button>
          <button
            onClick={() => addNode("tts")}
            className="text-xs bg-cyan-50 text-cyan-700 hover:bg-cyan-100 px-2.5 py-1 rounded-md border border-cyan-200 transition-colors"
          >
            🔊 TTS
          </button>
        </div>
      </header>

      {/* Canvas + Config Panel */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 min-w-0">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            fitViewOptions={{ padding: 0.2 }}
          >
            <Background gap={16} />
            <Controls />
          </ReactFlow>
        </div>
        {selectedNode && (
          <ConfigPanel
            node={selectedNode}
            onChange={updateNodeData}
            onClose={() => setSelectedId(null)}
            onDelete={deleteNode}
          />
        )}
      </div>

      {/* 运行抽屉 — 浮在画布底部 */}
      {showRun && id && (
        <RunPanel
          workflowId={id}
          nodes={nodes.map((n) => ({
            id: n.id,
            type: n.type as NodeDef["type"],
            position: n.position,
            data: (n.data ?? {}) as Record<string, unknown>,
          }))}
          onClose={() => setShowRun(false)}
        />
      )}
    </div>
  );
}

export default function Editor() {
  return (
    <ReactFlowProvider>
      <EditorInner />
    </ReactFlowProvider>
  );
}
