"use client";
import { useState } from "react";
import type { Horse } from "@/lib/horse-types";
import { CONDITION_ROWS, availableConditionRows, conditionSymbol } from "@/lib/condition-symbols";

const tone: Record<string, string> = { "◎": "bg-emerald-400/15 text-emerald-200", "○": "bg-cyan-400/10 text-cyan-200", "△": "bg-amber-400/10 text-amber-200", "×": "bg-rose-400/10 text-rose-200", "—": "text-slate-500" };
export function ConditionMatrix({ horses, onHorse }: { horses: Horse[]; onHorse: (horse: Horse) => void }) {
  const [detail, setDetail] = useState<{ number: number; factor: string } | null>(null);
  const rows = availableConditionRows(horses);
  const sorted = [...horses].sort((a,b) => a.number-b.number);
  const horse = sorted.find(h => h.number === detail?.number);
  const cell = horse && detail ? conditionSymbol(horse, detail.factor) : null;
  return <section aria-label="全頭の適性早見表" className="mb-5 min-w-0 overflow-hidden rounded-2xl border border-cyan-400/30 bg-[#0c192a]">
    <div className="p-4"><h2 className="text-lg font-bold">全頭の適性早見表</h2><p className="mt-1 text-xs leading-5 text-slate-300">馬番を横に並べて比較。記号を押すと実績数と判定根拠、馬名を押すと詳細を確認できます。</p><p className="mt-2 text-xs text-slate-400">◎ 高評価 ／ ○ 好材料 ／ △ 標準 ／ × 低め ／ — 該当実績なし</p></div>
    <div data-no-swipe role="region" aria-label="全頭適性表・横スクロール" tabIndex={0} className="max-h-[65vh] overflow-auto overscroll-x-contain" style={{touchAction:"pan-x pan-y pinch-zoom"}}>
      <table className="w-full table-fixed border-collapse text-center text-xs" style={{minWidth:104+sorted.length*80}}><caption className="sr-only">全出走馬の条件別適性</caption><colgroup><col style={{width:104}} />{sorted.map(h=><col key={h.number} style={{width:80}} />)}</colgroup>
        <thead className="sticky top-0 z-10"><tr><th scope="col" className="sticky left-0 z-20 bg-[#102139] p-2">項目／馬番</th>{sorted.map(h=><th scope="col" key={h.number} className="bg-[#102139] p-1"><button type="button" onClick={()=>onHorse(h)} aria-label={`${h.number} ${h.name}の詳細を見る`} className="min-h-11 w-full rounded p-1"><span className="block text-lg text-cyan-200">{h.number}</span><span className="block truncate text-[10px]">{h.name}</span></button></th>)}</tr></thead>
        <tbody>{rows.map(row=><tr key={row.factor} className="border-t border-slate-700"><th scope="row" className="sticky left-0 bg-[#102139] px-2 py-3 text-left font-medium">{row.label}</th>{sorted.map(h=>{const value=conditionSymbol(h,row.factor);return <td key={h.number} className="border-l border-slate-800 p-1"><button type="button" aria-label={`${h.number} ${h.name}・${row.label} ${value.symbol}の根拠`} aria-pressed={detail?.number===h.number&&detail.factor===row.factor} onClick={()=>setDetail({number:h.number,factor:row.factor})} className={`min-h-11 w-full rounded text-2xl font-bold ${tone[value.symbol]}`}>{value.symbol}{value.confidence === "reference" && <span className="block text-[9px] font-normal leading-3">少数参考</span>}</button></td>})}</tr>)}</tbody>
      </table>
    </div>
    {horse && cell && detail && <p role="status" className="m-3 rounded-lg bg-cyan-300/10 p-3 text-xs leading-6"><strong>{horse.number} {horse.name}・{CONDITION_ROWS.find(r=>r.factor===detail.factor)?.label}：{cell.symbol}</strong><br />{cell.detail}</p>}
    {!rows.length && <p className="p-4 text-xs text-slate-400">条件別実績を取得できていません。未取得の項目は評価しません。</p>}
    <p className="px-4 py-2 text-[11px] leading-5 text-slate-400">全頭未取得の項目は非表示。現在未掲載：{CONDITION_ROWS.filter(row => !rows.some(r => r.factor === row.factor)).map(row => row.label).join("・") || "なし"}。取得のない馬の欄は—です。</p>
    <details className="border-t border-slate-700 p-4 text-xs leading-6 text-slate-400"><summary className="min-h-8 cursor-pointer font-semibold text-slate-300">判定基準・集計対象</summary><p>条件別3着内率の通算差が+15pt以上で◎、+5pt以上で○、−5pt以上で△、それ未満で×。1〜4走は通算差を「走数÷5」で弱めて参考判定します。5走以上は通常表示です。通算との比較ができない項目は3着内率を5走分の中立値（33.3%）で補正し、60%以上◎・40%以上○・20%以上△・それ未満×。記号は的中確率ではありません。</p><p>距離は履歴の距離区分です。血統・馬場状態・馬×騎手の未取得項目を、騎手全体など別の成績では代用しません。</p></details>
  </section>;
}
