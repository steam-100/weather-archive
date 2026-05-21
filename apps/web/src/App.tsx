/**
 * Decoy entry — 默认显示伪装首页(看着像四季天气存档)
 * 真入口走 hash 路由,P3 阶段实现
 */
export default function App() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center font-sans">
      <div className="max-w-md text-center space-y-3 p-8">
        <h1 className="text-2xl font-medium text-slate-700">小院天气存档</h1>
        <p className="text-sm text-slate-500">
          四季的温度、湿度,和晴雨之间的小事。施工中。
        </p>
      </div>
    </div>
  );
}
