"use client";

import { useState } from "react";
import { courseStages, horseSequences, predictCorner, stagePosition, type MapHorse } from "@/lib/corner-reference";

const frameColors = ["#94a3b8", "#f8fafc", "#171717", "#dc433c", "#3778dc", "#f4d641", "#329249", "#ec9a30", "#d94c90"];
const styleOrder: Record<string, number> = { "逃げ": 1, "先行": 2, "好位": 3, "差し": 4, "追込": 5 };

export function RaceFormationMap({ horses, title, course, raceId, pace, league = "jra", scenario }: {
  horses: MapHorse[]; title: string; course: string; raceId: string; pace: string; league?: "jra" | "nar"; scenario?: { label: string; positions: Record<number, Record<number, number | null>> };
}) {
  const [mode, setMode] = useState("ai0");
  const [selected, setSelected] = useState<number | null>(null);
  const nar = league === "nar", banei = nar && /ばんえい/.test(course);
  const stages = nar ? banei ? null : [3,4] : courseStages(title, course);
  const year = raceId.length === 10 ? 2000 + Number(raceId.slice(0, 2)) : Number(raceId.slice(0, 4));
  const eligible = year >= 2025 && !!stages?.length;
  const options = [
    { id: "style", label: "脚質" },
    ...((eligible || scenario) ? [{ id: "ai0", label: scenario ? "条件・序盤" : nar ? "暫定序盤" : "AI序盤" }, ...(stages ?? (/直線/.test(course) ? [] : [3,4])).map((n) => ({ id: `ai${n}`, label: `${scenario ? "条件・" : nar ? "暫定" : "AI"}${n}角` }))] : []),
    ...(stages?.length ? [{ id: "past3", label: "前走3角" }, { id: "past4", label: "前走4角" }] : []),
  ];
  const active = options.some((item) => item.id === mode) ? mode : "style";
  const ai = active.startsWith("ai");
  const past = active.startsWith("past");
  const corner = ai ? Number(active.slice(2)) : past ? Number(active.slice(4)) : 0;

  const projected = horses.map((horse) => {
    const estimate = ai && scenario ? (() => { const position = scenario.positions[horse.number]?.[corner]; return position == null ? null : {position, samples: horseSequences(horse).length, low: Math.floor(position), high: Math.ceil(position)}; })() : ai ? nar ? narCorner(horse,corner,horses.length) : predictCorner(horse, corner, horses.length, course) : null;
    const prior = past ? stagePosition(horseSequences(horse)[0] ?? [], corner) : null;
    const value = ai ? estimate?.position ?? null : past ? prior : styleOrder[horse.style] ?? null;
    return { horse, value, estimate };
  });
  const visible = projected.filter((p) => p.value !== null).sort((a,b) => a.value! - b.value! || a.horse.number-b.horse.number);
  const unknown = projected.filter((p) => p.value === null);
  const current = projected.find((p) => p.horse.number === selected);
  const tops = [...horses].filter((h) => (h.firstSuitability ?? 0) > 0).sort((a,b) => (b.firstSuitability ?? 0)-(a.firstSuitability ?? 0)).slice(0,3).map((h) => h.number);
  const modeLabel = options.find((item) => item.id === active)?.label;
  const groupSize = Math.max(1, Math.ceil(visible.length / 3));

  return (
    <section className="mb-5 overflow-hidden rounded-2xl border border-cyan-300/20 bg-[#0c192a] text-white">
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-bold">隊列マップ</h2>
          <span className="rounded-full bg-cyan-300/10 px-3 py-1 text-xs font-semibold text-cyan-200">{ai ? scenario ? `${scenario.label}の仮定` : nar ? "地方・暫定位置取り" : "AI位置取り予測 β" : past ? "前走の通過順位" : "近走の脚質傾向"}</span>
        </div>
        <p className="mt-2 text-sm text-slate-300">{nar?"先行構成":"ペース想定"}：{pace}</p>
        <div role="group" aria-label="隊列マップの場面" className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4" data-testid="formation-controls">
          {options.map((option) => <button key={option.id} type="button" aria-pressed={active === option.id} onClick={() => { setMode(option.id); setSelected(null); }} className={`min-h-11 rounded-lg border px-2 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 ${active === option.id ? "border-cyan-300 bg-cyan-300 text-[#071220]" : "border-slate-700 bg-[#101f32] text-slate-300 hover:border-slate-500 hover:text-white"}`}>{option.label}</button>)}
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-300">
          {["逃げ", "先行", "好位", "差し", "追込"].map((style) => {
            const count = horses.filter((h) => h.style === style).length;
            return count ? <span key={style} className="rounded-full bg-white/5 px-2 py-1">{style} {count}頭</span> : null;
          })}
          <span className="rounded-full bg-white/5 px-2 py-1">{modeLabel}：{visible.length}/{horses.length}頭を配置</span>
        </div>
      </div>
      <div className="grid gap-5 px-4 pb-5 sm:px-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,.85fr)]">
        <div className="min-w-0">
          <div className="overflow-hidden rounded-xl border border-slate-700 bg-[#071220]" aria-label={`${modeLabel}の隊列。先頭側から${visible.map((p) => p.horse.number).join("、")}番。内外や馬身差は表しません。`} data-testid="formation-board">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 px-3 py-3 text-xs text-slate-400">
              <span className="font-bold text-cyan-200">{corner ? `${corner}コーナー` : active === "style" ? "脚質の並び" : "最初の通過地点"}</span>
              <span>{visible.length}/{horses.length}頭を配置</span>
            </div>
            <div className="grid grid-cols-3 gap-2 p-3 sm:gap-3">
              {["先頭側", "中ほど", "後方側"].map((label, column) => <div key={label} className="min-w-0">
                <p className="mb-3 flex items-center justify-between border-b border-slate-700 pb-2 text-xs font-semibold text-slate-400"><span>{label}</span><span aria-hidden="true">{column < 2 ? "→" : ""}</span></p>
                <div className="grid gap-2">
                  {visible.slice(column * groupSize, (column + 1) * groupSize).map(({ horse, value, estimate }) => {
                    const topIndex = tops.indexOf(horse.number);
                    const selectedHorse = selected === horse.number;
                    return <button key={horse.number} type="button" data-formation-horse={horse.number} aria-pressed={selectedHorse} aria-label={`${horse.number}番 ${horse.name} ${ai && estimate ? `${scenario ? "仮定" : "推定"}${estimate.position.toFixed(1)}番手` : past ? `前走${value}番手` : horse.style}`} onClick={() => setSelected(horse.number)} className={`relative min-h-16 min-w-0 overflow-hidden rounded-lg border px-2 py-2 pl-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 ${selectedHorse ? "border-cyan-300 bg-cyan-300/15" : "border-slate-700 bg-[#132338] hover:border-cyan-300/60"}`}>
                      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 border-r border-white/20" style={{ background: frameColors[horse.gate ?? 0] ?? frameColors[0] }} />
                      <span className="flex flex-wrap items-center justify-between gap-1"><span className="text-xl font-extrabold tabular-nums">{horse.number}</span>{topIndex >= 0 && <span className={`rounded px-1 py-0.5 text-[10px] font-bold ${topIndex === 0 ? "bg-cyan-300/15 text-cyan-200" : topIndex === 1 ? "bg-violet-300/15 text-violet-200" : "bg-amber-300/15 text-amber-200"}`}>適{topIndex + 1}</span>}</span>
                      <span className="mt-1 block whitespace-nowrap text-[10px] leading-4 text-slate-300 sm:text-xs">{ai && estimate ? `${scenario ? "仮定 " : ""}${estimate.position.toFixed(1)}番手` : past ? `${value}番手` : horse.style}</span>
                    </button>;
                  })}
                </div>
              </div>)}
            </div>
            {!visible.length && <p className="px-4 pb-5 text-center text-sm leading-6 text-slate-400">この場面を推定できる通過順データがありません。</p>}
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-400">各列の上から下、左の列から右の列へ前後順に配置。枠色はカードの左端、適1〜3は1着適性の上位3頭です。内外・馬身差は表しません。</p>
        </div>
        <div className="min-w-0 space-y-3">
          <div className="rounded-xl border border-slate-700 bg-black/10 p-4" aria-live="polite">
            {current ? <>
              <p className="font-bold">{current.horse.number}　{current.horse.name}</p>
              <p className="mt-2 text-sm text-cyan-200">{current.estimate ? scenario && ai ? `仮定の並び ${current.estimate.position}番手` : `推定 ${current.estimate.position.toFixed(1)}番手 / ${nar ? "過去の範囲" : "目安"} ${current.estimate.low}〜${current.estimate.high}番手` : past ? current.value === null ? "該当コーナーの記録なし" : `前走 ${current.value}番手` : `近走の脚質：${current.horse.style}`}</p>
              <p className="mt-2 break-words text-xs leading-5 text-slate-400">近走通過順（新しい順）：{horseSequences(current.horse).map((s) => s.join("-")).join(" / ") || "未取得"}</p>
              {current.estimate && <p className="mt-1 text-xs text-slate-400">{scenario ? "近走通過順" : "この地点の履歴"} {current.estimate.samples}走。履歴が少ない馬は参考度が下がります。</p>}
            </> : <><p className="font-semibold">位置取りの根拠を見る</p><p className="mt-2 text-sm leading-6 text-slate-400">馬番をタップすると、推定番手と近走の通過順を確認できます。</p></>}
          </div>
          {unknown.length > 0 && <div className="rounded-xl border border-slate-700 p-3"><p className="text-xs text-slate-400">この場面は未判定</p><div className="mt-2 flex flex-wrap gap-2">{unknown.map(({horse}) => <button key={horse.number} type="button" onClick={() => setSelected(horse.number)} className="min-h-10 rounded-lg bg-white/5 px-3 text-sm">{horse.number} {horse.name}</button>)}</div></div>}
          <p className="text-xs leading-5 text-slate-400">{scenario ? "条件の隊列は選択した馬と近走位置に脚質の動きを置いた例です。誤差幅を示すものではありません。" : "位置取りは予測の目安です。"}実際の進路・馬身差を表すものではありません。</p>
          {!eligible && !scenario && <p className="text-xs leading-5 text-amber-200">{banei ? "ばんえいにコーナーはないため、平地の隊列図は表示しません。" : "このコースまたは日付はAI予測対象外のため、脚質を表示しています。"}</p>}
        </div>
      </div>
    </section>
  );
}

function narCorner(horse:MapHorse,stage:number,field:number) {
  const observations=horseSequences(horse).flatMap((sequence,i)=>{const position=stagePosition(sequence,stage);return position===null?[]:[{position,weight:5-i}];});
  if(!observations.length)return null;
  const position=Math.max(1,Math.min(field,observations.reduce((s,v)=>s+v.position*v.weight,0)/observations.reduce((s,v)=>s+v.weight,0)));
  return {position,samples:observations.length,low:Math.min(...observations.map(v=>v.position)),high:Math.max(...observations.map(v=>v.position))};
}
