"use client";

import { useState } from "react";
import { marketRankPoints, type JournalHorse } from "@/lib/prediction-journal";

export function MarketRankMap({ horses }: { horses: JournalHorse[] }) {
  const [role, setRole] = useState<"firstProbability" | "secondProbability" | "thirdProbability">("firstProbability");
  const [selected, setSelected] = useState<number | null>(null);
  const points = marketRankPoints(horses, role);
  const choice = points.find(h => h.number === selected);
  const axis = Math.max(1, horses.length - 1);
  if (!points.length) return <p className="p-4 text-xs text-slate-400">全頭の人気・適性が揃うと比較図を表示します。</p>;
  return <div className="border-b border-slate-700 p-4">
    <div role="group" aria-label="比較する適性" className="grid grid-cols-3 gap-2">{(["firstProbability", "secondProbability", "thirdProbability"] as const).map((r,i) => <button key={r} type="button" aria-pressed={role===r} onClick={()=>{setRole(r);setSelected(null);}} className={`min-h-11 rounded-lg border px-2 text-sm font-semibold ${role===r ? "border-violet-300 bg-violet-300/15 text-violet-200" : "border-slate-700 text-slate-400"}`}>{i+1}着適性</button>)}</div>
    <svg viewBox="0 0 420 305" className="mx-auto mt-3 w-full max-w-[600px]" role="img" aria-label="横軸は人気順位、縦軸はREINの適性順位。右ほど人気上位、上ほどREIN上位です。">
      <rect x="38" y="28" width="344" height="224" rx="8" fill="#071220" />
      <path d="M38 252 L382 28" stroke="#64748b" strokeDasharray="5 6" />
      <path d="M38 140 H382 M210 28 V252" stroke="#1e334b" />
      <text x="55" y="13" fontSize="11" fill="#c4b5fd">REIN上位</text><text x="40" y="278" fontSize="11" fill="#94a3b8">人気薄</text><text x="318" y="278" fontSize="11" fill="#94a3b8">人気上位 →</text>
      {points.map(h => <g key={h.number} transform={`translate(${38+(horses.length-h.popularity)/axis*344},${28+(h.rank-1)/axis*224})`}>
        <circle r={selected===h.number ? 13 : 10} fill={h.difference>0 ? "#22d3ee" : h.difference<0 ? "#a78bfa" : "#64748b"} stroke={selected===h.number ? "#fff" : "#0c192a"} strokeWidth="2" />
        <text textAnchor="middle" dominantBaseline="central" fontSize="10" fontWeight="700" fill="#071220">{h.number}</text>
        <title>{h.number} {h.name}：{h.popularity}番人気、REIN {h.rank}位</title>
      </g>)}
      <text x="210" y="297" textAnchor="middle" fontSize="11" fill="#94a3b8">破線＝人気順位と適性順位が同じ</text>
    </svg>
    <label className="mt-1 block text-xs text-slate-400">馬を選んで確認<select aria-label="市場比較で確認する馬" value={selected ?? ""} onChange={e=>setSelected(e.target.value ? Number(e.target.value) : null)} className="mt-2 min-h-11 w-full rounded-lg border border-slate-600 bg-[#071220] px-3 text-sm text-slate-200"><option value="">馬番・馬名を選択</option>{points.map(h=><option key={h.number} value={h.number}>{h.number} {h.name}</option>)}</select></label>
    {choice && <p className="mt-2 break-words text-sm leading-6 text-cyan-200">{choice.number} {choice.name}：{choice.popularity}番人気 → REIN {choice.rank}位</p>}
    <p className="mt-2 text-[11px] leading-5 text-slate-500">右上は人気・REINとも上位。左上は人気よりREINが高く評価した馬です。水色は人気以上、紫色は人気以下の評価を示します。</p>
  </div>;
}
