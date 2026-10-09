"use client";
import { useMemo, useState } from "react";
import { scenarioComparison, type ScenarioHorse, type PaceScenarioId } from "@/lib/pace-scenarios";
const shortLabels = ["基本", "単騎", "控えめ", "激化", "早め", "差し"];
export function PaceRankComparison({ horses, leaders, roleReady, onSelect }: { horses: ScenarioHorse[]; leaders: number[]; roleReady: boolean; onSelect: (id: PaceScenarioId) => void }) {
  const columns = useMemo(() => scenarioComparison(horses, leaders, roleReady), [horses, leaders, roleReady]);
  const [sort, setSort] = useState<"base" | "change">("base");
  const rows = useMemo(() => columns[0].ranking.map(base => {
    const values = columns.map(c => c.ranking.find(r => r.horse.number === base.horse.number)?.rank ?? null);
    const valid = values.filter((n): n is number => n !== null);
    return { ...base, values, range: valid.length ? Math.max(...valid) - Math.min(...valid) : 0 };
  }).sort((a, b) => sort === "change" ? b.range - a.range || a.baseRank - b.baseRank : a.baseRank - b.baseRank), [columns, sort]);
  return <section aria-label="展開6パターンの順位比較" className="mt-5 rounded-xl border border-violet-300/30 p-3 sm:p-4">
    <h3 className="text-base font-bold text-violet-100">展開6パターンの順位比較</h3>
    <p className="mt-2 text-xs leading-5 text-slate-300">1着適性の順位を起点にした参考候補順です。↑は基本より上昇、↓は下降。的中精度は未検証です。</p>
    <div role="group" aria-label="展開比較の並び順" className="mt-3 flex flex-wrap gap-2">{([["base", "基本順位順"], ["change", "変化が大きい順"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={sort === value} onClick={() => setSort(value)} className={`min-h-11 rounded-lg border px-3 text-xs ${sort === value ? "border-violet-300 bg-violet-300/15 text-violet-100" : "border-slate-600 text-slate-300"}`}>{label}</button>)}</div>
    {rows.length ? <div role="region" aria-label="展開順位の比較表・横スクロール" tabIndex={0} data-no-swipe style={{ overscrollBehaviorX: "contain", touchAction: "pan-x pan-y pinch-zoom" }} className="mt-3 max-h-[34rem] overflow-auto rounded-xl border border-slate-700">
      <table className="w-full min-w-[650px] table-fixed text-center text-xs"><caption className="p-3 text-left text-slate-400">左に馬名を固定。見出しを押すとその展開で確認できます。</caption><colgroup><col style={{ width: 126 }} />{columns.map(c => <col key={c.scenario.id} style={{ width: 88 }} />)}</colgroup>
        <thead className="sticky top-0 z-20 bg-[#142038]"><tr><th scope="col" className="sticky left-0 z-30 bg-[#142038] p-3 text-left">馬名・脚質</th>{columns.map((c, i) => <th key={c.scenario.id} scope="col" className="p-2"><button type="button" aria-label={`${c.scenario.label}で確認`} onClick={() => onSelect(c.scenario.id)} className="min-h-11 w-full text-violet-200 underline">{shortLabels[i]}</button><span className="block text-[10px] font-normal text-slate-400">{i === 0 ? "元の順位" : c.leaders.length ? `前：${c.leaders.join("・")}番` : "前の馬未選択"}</span></th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.horse.number} className="border-t border-slate-700"><th scope="row" className="sticky left-0 z-10 bg-[#111b30] p-3 text-left"><span className="block break-words">{row.horse.number} {row.horse.name}</span><span className="mt-1 block font-normal text-slate-400">{row.horse.style}</span></th>{row.values.map((rank, i) => {
          const diff = rank === null ? 0 : row.baseRank - rank;
          return <td key={columns[i].scenario.id} className="p-2"><span className="text-sm font-bold">{rank === null ? "保留" : `${rank}位`}</span><span className={`mt-1 block text-[10px] ${diff > 0 ? "text-cyan-200" : diff < 0 ? "text-amber-200" : "text-slate-500"}`}>{rank === null ? "条件未成立" : i === 0 ? "基準" : diff > 0 ? `↑${diff}` : diff < 0 ? `↓${Math.abs(diff)}` : "±0"}</span></td>;
        })}</tr>)}</tbody>
      </table>
    </div> : <p className="mt-3 text-sm text-amber-200">全頭の1着適性がそろうまで順位比較を保留します。</p>}
    <p className="mt-3 text-xs leading-5 text-slate-400">各列の仮定：単騎は選択順の先頭1頭。激化は2頭未満なら近走の逃げ候補で補います。必要な頭数がそろわない列は保留します。前へ行く馬番は各見出しに表示しています。</p>
    <details className="mt-2 text-xs text-slate-400"><summary className="min-h-9 cursor-pointer py-2">参考順位の計算ルール</summary><p className="leading-5">基本順位に、追い風は−2、注意は＋2を加えて並べ替えます。単騎の逃げ馬は−3、激化の逃げ馬は＋3、差し条件の追い風／注意は−3／＋3。同点は基本順位順です。矢印は並べ替え後の実際の順位差です。元のREIN評価・確率・買い目は変更しません。</p></details>
  </section>;
}
