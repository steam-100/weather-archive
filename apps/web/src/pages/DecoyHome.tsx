/**
 * 伪装首页 — DecoyHome
 * 给搜索引擎、瞎逛的人看的"四季天气存档"页
 * 默认路径 / 渲染此页,真入口 hash 路由 /#/x9f3a/login 才进真应用
 */
const SEASONS = [
  { name: "春", emoji: "🌸", temp: "12 ~ 18", humidity: "62%", note: "海棠开了,昨天下了点小雨。" },
  { name: "夏", emoji: "☀️", temp: "26 ~ 32", humidity: "78%", note: "院子里的西红柿熟了一茬。" },
  { name: "秋", emoji: "🍂", temp: "14 ~ 22", humidity: "55%", note: "落叶扫了三回,桂花香了一周。" },
  { name: "冬", emoji: "❄️", temp: "-2 ~ 6", humidity: "40%", note: "门口的腊梅总是先开。" },
];

export default function DecoyHome() {
  return (
    <div className="min-h-screen bg-stone-50 text-stone-800">
      <header className="max-w-3xl mx-auto px-6 pt-16 pb-8">
        <h1 className="text-3xl font-medium tracking-tight">小院天气存档</h1>
        <p className="mt-2 text-sm text-stone-500">
          记录温度、湿度,以及每一年四季里的小事。
        </p>
      </header>

      <main className="max-w-3xl mx-auto px-6 pb-16">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {SEASONS.map((s) => (
            <article
              key={s.name}
              className="bg-white border border-stone-200 rounded-lg p-5 shadow-sm hover:shadow transition-shadow"
            >
              <div className="flex items-baseline justify-between">
                <h2 className="text-lg font-medium">
                  <span className="mr-2">{s.emoji}</span>
                  {s.name}
                </h2>
                <span className="text-xs text-stone-400">2025</span>
              </div>
              <dl className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between text-stone-600">
                  <dt>气温(℃)</dt>
                  <dd className="tabular-nums">{s.temp}</dd>
                </div>
                <div className="flex justify-between text-stone-600">
                  <dt>湿度</dt>
                  <dd className="tabular-nums">{s.humidity}</dd>
                </div>
              </dl>
              <p className="mt-3 text-sm text-stone-500 leading-relaxed">
                {s.note}
              </p>
            </article>
          ))}
        </div>

        <footer className="mt-12 pt-6 border-t border-stone-200 text-xs text-stone-400">
          <p>最后更新:2026 年春</p>
        </footer>
      </main>
    </div>
  );
}
