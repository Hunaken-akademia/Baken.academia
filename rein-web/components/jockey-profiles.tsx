"use client";

import { useState } from "react";

type JockeyHorse = {
  number: number;
  name: string;
  jockey?: string;
  style: string;
  weightCarried?: number;
  historyFactors?: Array<{ label: string; samples: number; wins?: number; top3?: number; winRate?: number; top3Rate?: number; averageFinish?: number }>;
};

// These factors describe the jockey across all conditions. A horse's running
// style must not be presented as the jockey's personal tactical preference.
export function JockeyProfiles({ horses, dateFrom, dateTo }: { horses: JockeyHorse[]; dateFrom?: string; dateTo?: string }) {
  const [query, setQuery] = useState("");
  const groups = new Map<string, JockeyHorse[]>();
  for (const horse of [...horses].sort((a, b) => a.number - b.number)) {
    const key = horse.jockey?.trim() || `未取得-${horse.number}`;
    groups.set(key, [...(groups.get(key) ?? []), horse]);
  }
  const visible = [...groups.entries()].filter(([name, mounts]) => `${name} ${mounts.map((horse) => horse.name).join(" ")}`.includes(query.trim()));
  const percent = (value?: number) => value != null && Number.isFinite(value) ? `${value.toFixed(1)}%` : "未取得";
  return (
    <section className="min-w-0 rounded-2xl border border-slate-700 bg-[#0c192a] p-4 sm:p-5">
      <h2 className="text-xl font-bold">騎手の成績・騎乗馬</h2>
      <p className="mt-2 text-sm leading-6 text-slate-400">騎手名を開くと、履歴全体の成績と今回の騎乗馬を確認できます。馬の脚質は騎手自身の特徴とは別に表示しています。</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{dateFrom && dateTo ? `モデル履歴：${dateFrom}〜${dateTo}。` : "履歴期間は未取得。"}各保存予想に含まれる集計値を表示します。競馬場・距離別や人気に対する成績は未集計です。</p>
      <input type="search" aria-label="騎手・馬を検索" placeholder="騎手名・馬名で検索" value={query} onChange={(event) => setQuery(event.target.value)} className="my-4 min-h-11 w-full rounded-lg border border-slate-600 bg-[#101f32] px-3 text-sm" />
      <div className="space-y-3">
        {visible.map(([key, mounts]) => {
          const horse = mounts[0];
          const factor = horse.historyFactors?.find((item) => item.label === "騎手傾向");
          return <details key={key} className="rounded-xl border border-slate-700 bg-black/10" open={query.trim() ? true : undefined}>
            <summary className="cursor-pointer px-4 py-3">
              <span className="font-bold text-cyan-200">{horse.jockey || "騎手未取得"}</span>
              <span className="ml-2 text-xs text-slate-400">{mounts.map((mount) => `${mount.number} ${mount.name}`).join(" / ")}</span>
              <span className="mt-1 block text-xs text-slate-500">{factor ? `${factor.samples.toLocaleString()}走・勝率 ${percent(factor.winRate)}・3着内率 ${percent(factor.top3Rate)}` : "成績データ未取得"}</span>
            </summary>
            <div className="border-t border-slate-800 p-4">
              <div className="grid grid-cols-3 gap-2">
                {[["出走数", factor ? `${factor.samples.toLocaleString()}走` : "未取得"], ["勝率", percent(factor?.winRate)], ["3着内率", percent(factor?.top3Rate)]].map(([label, value]) => <div key={label} className="rounded-lg bg-[#101f32] p-3"><p className="text-[11px] text-slate-400">{label}</p><p className="mt-1 text-base font-bold sm:text-xl">{value}</p></div>)}
              </div>
              {factor && factor.samples < 30 && <p className="mt-3 text-xs text-amber-200">出走数が少ないため参考値です。</p>}
              <p className="mt-3 text-xs leading-5 text-slate-400">騎乗する馬の能力・人気・条件も成績に影響します。この成績だけで騎手の優劣や今回の勝率は決まりません。</p>
              {mounts.map((mount) => <div key={mount.number} className="mt-3 rounded-lg border border-slate-800 p-3 text-sm"><p className="font-semibold">{mount.number} {mount.name}</p><p className="mt-1 text-slate-400">馬の近走脚質：{mount.style || "未取得"}{mount.weightCarried != null ? `・斤量 ${mount.weightCarried}kg` : ""}</p></div>)}
            </div>
          </details>;
        })}
        {!visible.length && <p className="py-6 text-center text-sm text-slate-400">該当する騎手・馬がいません。</p>}
      </div>
    </section>
  );
}
