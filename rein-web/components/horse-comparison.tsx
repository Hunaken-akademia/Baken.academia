"use client";

import { useMemo, useRef, useState } from "react";
import { Check, Search, SlidersHorizontal, X } from "lucide-react";
import type { Horse } from "@/lib/horse-types";
import type { RoleKey } from "@/lib/marks";
import { filterHorses, finite, historyFactors, historyRate, percent, ROLE_LABELS, roleRanks, type HorseFilter, type HorseSort } from "@/lib/horse-research";

const control = "min-h-11 min-w-0 rounded-lg border border-slate-600 bg-[#101f32] px-3 text-sm text-slate-100";
const roles = ["first", "second", "third"] as const;
const rankText = (rank: number | undefined) => rank ? `${rank}位` : "保留";
const weightText = (horse: Horse) => finite(horse.weight) && horse.weight > 0
  ? `${horse.weight}kg${finite(horse.weightChange) ? `（${horse.weightChange > 0 ? "+" : ""}${horse.weightChange}）` : ""}` : "未発表";

export function HorseComparison({ horses, rolesReady, overallReady, onHorse, dateFrom, dateTo, league }: {
  horses: Horse[]; rolesReady: boolean; overallReady: boolean; onHorse: (horse: Horse) => void;
  dateFrom?: string; dateTo?: string; league?: "jra" | "nar";
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HorseFilter>("all");
  const [sort, setSort] = useState<HorseSort>("number");
  const [role, setRole] = useState<RoleKey>("first");
  const [selected, setSelected] = useState<number[]>([]);
  const comparisonTable = useRef<HTMLElement>(null);
  const selectedHorses = selected.flatMap(number => horses.find(h => h.number === number) ?? []);
  const columnWidth = selectedHorses.length <= 2 ? 112 : 144;
  const ranks = useMemo(() => ({
    first: roleRanks(horses, "first", rolesReady), second: roleRanks(horses, "second", rolesReady), third: roleRanks(horses, "third", rolesReady),
  }), [horses, rolesReady]);
  const visible = useMemo(() => filterHorses(horses, { query, filter, sort, role, selected, rolesReady, overallReady }), [horses, query, filter, sort, role, selected, rolesReady, overallReady]);
  const toggle = (number: number) => setSelected(current => {
    const valid = current.filter(n => horses.some(horse => horse.number === n));
    return valid.includes(number) ? valid.filter(n => n !== number) : valid.length < 4 ? [...valid, number] : valid;
  });
  const factor = (horse: Horse, label: string) => historyFactors(horse).find(item => item.label === label);
  const conditionText = (horse: Horse, label: string) => {
    const item = factor(horse, label);
    return item?.samples && item.samples > 0 ? `${percent(historyRate(item, "top3"))} / ${item.samples}走${item.samples < 10 ? "（少数）" : ""}` : "実績未取得";
  };
  const rows: Array<{ label: string; read: (horse: Horse) => string }> = [
    { label: "人気 / 単勝", read: h => `${h.popularity > 0 ? `${h.popularity}人気` : "人気未発表"} / ${finite(h.odds) && h.odds > 0 ? `${h.odds}倍` : "未取得"}` },
    { label: "総合順位", read: h => overallReady ? `${horses.findIndex(item => item.number === h.number) + 1}位 / ${finite(h.score) ? `${h.score}pt` : "点数未取得"}` : "保留" },
    ...roles.map(key => ({ label: `${ROLE_LABELS[key]}適性順位`, read: (h: Horse) => rankText(ranks[key].get(h.number)) })),
    { label: "脚質", read: h => h.style || "未取得" },
    { label: "馬体重 / 増減", read: weightText },
    { label: "斤量", read: h => finite(h.weightCarried) && h.weightCarried > 0 ? `${h.weightCarried}kg` : "未取得" },
    { label: "枠 / 性齢", read: h => `${h.gate ? `${h.gate}枠` : "枠未取得"} / ${h.sex || "―"}${h.age || "―"}` },
    { label: "通算 3着内率", read: h => conditionText(h, "通算成績") },
    { label: "近5走 3着内率", read: h => conditionText(h, "近5走") },
    { label: "芝ダ 3着内率", read: h => conditionText(h, "芝ダ適性") },
    { label: "距離 3着内率", read: h => conditionText(h, "距離適性") },
    { label: "競馬場 3着内率", read: h => conditionText(h, "競馬場適性") },
    { label: "騎手", read: h => h.jockey || "未取得" },
    { label: "厩舎", read: h => h.trainer || "未取得" },
    { label: "直近の通過順位", read: h => h.recentPositions?.join(" / ") || "未取得" },
    { label: "プラス材料", read: h => h.positives.length ? h.positives.join(" / ") : "目立った材料なし" },
    { label: "注意材料", read: h => h.cautions.length ? h.cautions.join(" / ") : "目立った材料なし" },
  ];

  return <section aria-label="気になる馬を比較" className="min-w-0 space-y-4">
    <div className="rounded-2xl border border-cyan-400/25 bg-gradient-to-br from-[#10263a] to-[#0c192a] p-4 sm:p-5">
      <h2 className="text-lg font-bold">気になる馬を最大4頭で比較</h2>
      <p className="mt-1 text-xs leading-5 text-slate-300">着順適性・当日情報・条件別実績を並べて確認。</p>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="比較する着順適性">{roles.map(key => <button key={key} type="button" aria-pressed={role === key} onClick={() => { setRole(key); if (roles.includes(sort as RoleKey)) setSort(key); }} className={`min-h-11 rounded-lg border px-5 text-sm font-semibold ${role === key ? "border-cyan-300/60 bg-cyan-300/15 text-cyan-200" : "border-slate-600 bg-black/10 text-slate-300"}`}>{ROLE_LABELS[key]}適性</button>)}</div>
      <p className="mt-2 text-xs text-slate-400">1〜3着を切り替えて、上位馬を絞り込めます。</p>
    </div>

    <div className="rounded-2xl border border-slate-700 bg-[#0c192a] p-3 sm:p-4" data-no-swipe>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="relative"><Search aria-hidden="true" className="absolute left-3 top-3.5 size-4 text-slate-400" /><input type="search" aria-label="比較する馬を検索" value={query} onChange={event => setQuery(event.target.value)} placeholder="馬番・馬名・騎手名で検索" className={`${control} w-full pl-9`} /></label>
        <label className="flex items-center gap-2 text-xs text-slate-300"><SlidersHorizontal aria-hidden="true" className="size-4 shrink-0" />並び順<select aria-label="馬比較の並び順" className={`${control} flex-1`} value={sort} onChange={event => setSort(event.target.value as HorseSort)}><option value="number">馬番順</option><option value="popularity">人気順</option><option value="overall" disabled={!overallReady}>総合評価順</option>{roles.map(key => <option key={key} value={key} disabled={!ranks[key].size}>{ROLE_LABELS[key]}適性順</option>)}</select></label>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="馬比較の絞り込み">{([["all", "全頭"], ["top5", "適性上位5頭"], ["longshot", "人気薄×上位5頭"], ["selected", `選択中 ${selectedHorses.length}頭`]] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} className={`min-h-11 rounded-lg border px-2 text-xs font-semibold ${filter === key ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-700 text-slate-300"}`}>{label}</button>)}</div>
      <p className="mt-3 text-xs leading-5 text-slate-400">人気薄＝4番人気以下。適性順位は全出走馬の中での順位です。{!ranks[role].size ? "この着順の評価が揃っていないため、適性順・上位抽出は保留です。" : ""}</p>
      <div className="mt-3 flex items-center justify-between gap-2"><p role="status" className="text-xs text-slate-300">表示 {visible.length} / {horses.length}頭・比較 {selectedHorses.length} / 4頭</p>{selected.length > 0 && <button type="button" onClick={() => setSelected([])} className="min-h-10 px-2 text-xs text-slate-300 underline">選択をクリア</button>}</div>
      {selectedHorses.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{selectedHorses.map(horse => <button key={horse.number} type="button" aria-label={`${horse.number} ${horse.name}を比較から外す`} onClick={() => toggle(horse.number)} className="flex min-h-10 max-w-[calc(50%-4px)] items-center gap-2 rounded-lg bg-cyan-400/10 px-3 text-xs text-cyan-200"><span className="truncate">{horse.number} {horse.name}</span><X aria-hidden="true" className="size-3 shrink-0" /></button>)}</div>}
      {selectedHorses.length === 4 && <p className="mb-2 text-xs text-amber-200">4頭選択中です。入れ替える場合は1頭外してください。</p>}
      <div className="grid gap-2 lg:grid-cols-2">{visible.map(horse => {
        const checked = selected.includes(horse.number), rank = ranks[role].get(horse.number);
        return <article key={horse.number} className={`min-w-0 rounded-xl border p-3 ${checked ? "border-cyan-400/40 bg-cyan-400/5" : "border-slate-700 bg-black/10"}`}>
          <div className="flex min-w-0 items-start gap-3"><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-sm font-bold text-slate-900">{horse.number}</span><div className="min-w-0 flex-1"><h3 className="break-words text-sm font-bold">{horse.name}</h3><p className="mt-1 text-xs leading-5 text-slate-400">{horse.popularity > 0 ? `${horse.popularity}人気` : "人気未発表"}・{finite(horse.odds) && horse.odds > 0 ? `${horse.odds}倍` : "オッズ未取得"}・{horse.style || "脚質未取得"}</p></div><div className="shrink-0 text-right"><p className="text-[10px] text-slate-400">{ROLE_LABELS[role]}適性</p><p className="text-lg font-bold text-cyan-200">{rankText(rank)}</p></div></div>
          <div className="mt-3 grid grid-cols-3 gap-2">{roles.map(key => <p key={key} className="rounded bg-black/15 p-2 text-center text-xs text-slate-300">{ROLE_LABELS[key]} <span className="font-semibold text-white">{rankText(ranks[key].get(horse.number))}</span></p>)}</div>
          <p className="mt-2 text-xs leading-5 text-slate-400">{horse.jockey || "騎手未取得"} / {weightText(horse)}</p>
          <div className="mt-3 grid grid-cols-2 gap-2"><button type="button" onClick={() => toggle(horse.number)} aria-pressed={checked} disabled={!checked && selectedHorses.length >= 4} aria-label={`${horse.number} ${horse.name}を比較${checked ? "から外す" : "に追加"}`} className={`flex min-h-11 items-center justify-center gap-1 rounded-lg border text-xs font-semibold disabled:opacity-40 ${checked ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-600 text-slate-200"}`}>{checked && <Check aria-hidden="true" className="size-4" />}{checked ? "比較中" : "比較に追加"}</button><button type="button" onClick={() => onHorse(horse)} className="min-h-11 rounded-lg border border-slate-700 text-xs text-slate-300" aria-label={`${horse.number} ${horse.name}の詳細を見る`}>詳細を見る</button></div>
        </article>;
      })}</div>
      {!visible.length && <p className="py-6 text-center text-sm text-slate-400">条件に合う馬がいません。検索や絞り込みを変更してください。</p>}
    </div>

    <section ref={comparisonTable} tabIndex={-1} aria-label="選んだ馬の比較表" className="min-w-0 scroll-mt-28 overflow-hidden rounded-2xl border border-slate-700 bg-[#0c192a] outline-none sm:scroll-mt-16">
      <div className="p-4"><h3 className="font-bold">選んだ馬を並べて比較</h3><p className="mt-1 text-xs leading-5 text-slate-400">{selectedHorses.length >= 2 ? "横にスクロールできます。項目名は左端に固定しています。" : "上の「比較に追加」で2〜4頭を選んでください。"}</p></div>
      {selectedHorses.length >= 1 && <div data-no-swipe tabIndex={0} role="region" aria-label="選択馬の比較表・横スクロール" className="max-h-[70vh] overflow-auto overscroll-x-contain" style={{ touchAction: "pan-x pan-y pinch-zoom" }}>
        <table className="w-full table-fixed border-collapse text-left text-xs" style={{ minWidth: 96 + selectedHorses.length * columnWidth }}>
          <caption className="sr-only">選択した{selectedHorses.length}頭の着順適性と条件別成績</caption>
          <colgroup><col style={{ width: 96 }} />{selectedHorses.map(horse => <col key={horse.number} style={{ width: columnWidth }} />)}</colgroup>
          <thead className="sticky top-0 z-10"><tr><th scope="col" className="sticky left-0 z-20 bg-[#102139] p-3">比較項目</th>{selectedHorses.map(horse => <th key={horse.number} scope="col" className="bg-[#102139] p-3 align-top"><span className="text-cyan-200">{horse.number}</span> {horse.name}</th>)}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.label} className="border-t border-slate-800"><th scope="row" className="sticky left-0 bg-[#102139] p-3 font-medium text-slate-300">{row.label}</th>{selectedHorses.map(horse => <td key={horse.number} className="break-words p-3 align-top leading-5 text-slate-100">{row.read(horse)}</td>)}</tr>)}</tbody>
        </table>
      </div>}
      <p className="border-t border-slate-800 p-4 text-[11px] leading-5 text-slate-400">{dateFrom && dateTo ? `保存予想の履歴集計期間：${dateFrom}〜${dateTo}。` : "集計期間は未取得。"}実績率は過去の成績です。{league === "nar" ? "地方の着順適性はレース内の相対評価です。" : "適性順位・評価点は勝率ではありません。"}件数の少ない条件は参考に留めてください。</p>
    </section>
    {selectedHorses.length > 0 && <div className="sticky bottom-3 z-10 flex items-center justify-between gap-3 rounded-xl border border-cyan-400/40 bg-[#102139] px-4 py-3 shadow-lg"><span className="text-sm font-semibold text-cyan-100">{selectedHorses.length}頭を選択中</span><button type="button" onClick={() => { comparisonTable.current?.scrollIntoView({ block: "start" }); comparisonTable.current?.focus({ preventScroll: true }); }} className="min-h-11 rounded-lg bg-cyan-300 px-4 text-sm font-bold text-slate-950">比較表を見る</button></div>}
  </section>;
}
