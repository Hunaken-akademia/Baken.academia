"use client";
import { useEffect, useState } from "react";
import { TREND_PAGES, baselineRate, isStrong, recordText, sectionsFor, starts, top3, top3Rate, type GradedTrend, type TrendRecord, type TrendSection } from "@/lib/graded-trends";

const pct = (n: number | null) => n === null ? "—" : `${Math.round(n * 100)}%`;

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`min-w-0 rounded-2xl bg-[#14211f] p-4 ${className}`}>{children}</div>;
}

function Bars({ section, base }: { section: TrendSection; base: number }) {
  return <Card>
    <h3 className="text-base font-bold text-slate-50">{section.title}</h3>
    <p className="mt-0.5 text-[11px] text-slate-400">{section.note ? `${section.note}・` : ""}3着以内に入った割合</p>
    <ul className="mt-3 space-y-2">{section.rows.map(row => {
      const rate = top3Rate(row.record), strong = isStrong(row.record, base);
      return <li key={row.label} className="grid grid-cols-[6.5rem_1fr_3rem_4.6rem] items-center gap-2 text-sm">
        <span className="truncate font-semibold text-slate-100">{row.label}</span>
        <span className="h-3 overflow-hidden rounded bg-black/40"><span className={`block h-full rounded ${strong ? "bg-amber-300" : "bg-emerald-900/80"}`} style={{ width: `${Math.round((rate ?? 0) * 100)}%` }} /></span>
        <span className={`text-right font-bold ${strong ? "text-amber-300" : "text-slate-100"}`}>{pct(rate)}</span>
        <span className="text-[11px] text-slate-400">{row.record[0]}勝 {top3(row.record)}/{starts(row.record)}</span>
      </li>;
    })}</ul>
  </Card>;
}

function Lineage({ title, rows }: { title: string; rows: Array<{ name: string; record: TrendRecord }> }) {
  return <Card>
    <h3 className="text-base font-bold">{title}</h3>
    <p className="mt-0.5 text-[11px] text-slate-400">1着-2着-3着-着外。3着以内の多い順</p>
    {rows.length ? <ul className="mt-3 space-y-1.5">{rows.map(r => <li key={r.name} className="grid grid-cols-[1fr_auto_4.5rem] gap-2 text-sm">
      <span className="truncate font-semibold">{r.name}</span><span className="font-bold tabular-nums">{recordText(r.record)}</span>
      <span className="text-[11px] text-slate-400">3着内 {pct(top3Rate(r.record))}</span>
    </li>)}</ul> : <p className="mt-3 text-xs text-slate-400">血統の記録がありません。</p>}
  </Card>;
}

function Results({ trend }: { trend: GradedTrend }) {
  return <Card className="sm:col-span-2">
    <h3 className="text-base font-bold">過去の1〜3着</h3>
    <p className="mt-0.5 text-[11px] text-slate-400">人気・前走（着順）・4角・上がり順位・父。上がり3位以内を黄色</p>
    <div className="mt-3 space-y-3">{[...trend.results].reverse().map(edition => <div key={edition.year} className="rounded-xl bg-black/20 p-3">
      <p className="text-xs font-bold text-slate-300">{edition.year}年・{edition.going}・{edition.field}頭</p>
      <ul className="mt-2 space-y-2">{edition.rows.map(r => <li key={r.finish + r.name} className="grid grid-cols-[1.5rem_1fr_auto] gap-2 text-sm">
        <span className="font-bold text-amber-300">{r.finish}</span>
        <span className="min-w-0"><span className="font-bold">{r.name}</span> <span className="text-[11px] text-slate-400">{r.sexAge}</span>
          <span className="block truncate text-[11px] text-slate-400">{r.sire ? `父 ${r.sire}` : ""}{r.prior ? `・前走 ${r.prior}` : ""}</span></span>
        <span className="text-right text-xs"><span className="block">{r.popularity ? `${r.popularity}番人気` : "—"}</span>
          <span className="text-slate-400">4角{r.corner4 ?? "—"}・</span><span className={r.last3fRank !== null && r.last3fRank <= 3 ? "font-bold text-amber-300" : "text-slate-400"}>上がり{r.last3fRank ?? "—"}位</span></span>
      </li>)}</ul>
    </div>)}</div>
  </Card>;
}

export function GradedTrends({ race }: { race: { raceId: string; title: string } }) {
  const [trend, setTrend] = useState<GradedTrend | null>(null), [limitations, setLimitations] = useState<string[]>([]), [page, setPage] = useState(TREND_PAGES[0].id);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/analyze/graded-trends?${new URLSearchParams({ raceId: race.raceId, title: race.title })}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() : null).then(body => { if (body?.trend) { setTrend(body.trend); setLimitations(body.limitations ?? []); } }).catch(() => {});
    return () => controller.abort();
  }, [race.raceId, race.title]);
  if (!trend) return null;
  const base = baselineRate(trend), current = TREND_PAGES.find(p => p.id === page)!;
  const fav = trend.summary.favorite, upFirst = trend.sections.find(s => s.title === "上がり3ハロンの順位")?.rows.find(r => r.label === "上がり1位");
  const tiles = [
    ["1番人気の成績", `${fav[0]}勝`, `3着以内 ${top3(fav)}回／${trend.editions}年`],
    ["4番人気以下の勝ち", `${trend.summary.winnersPopularity4Plus}回`, `勝ち馬の最低人気は${trend.summary.maxWinnerPopularity}番人気`],
    ["上がり1位の3着以内", upFirst ? pct(top3Rate(upFirst.record)) : "—", upFirst ? `${top3(upFirst.record)}/${starts(upFirst.record)}頭` : ""],
    ["全体の3着以内", pct(base), "この割合より高い項目を黄色"],
  ];
  return <section aria-label="過去の傾向" data-testid="graded-trends" className="mb-5 rounded-2xl border border-amber-300/30 bg-[#0d1615] p-4 sm:p-5">
    <p className="text-xs font-bold text-amber-300">{trend.grade}・{trend.course}{trend.courseChanged ? "（開催条件の変更年を含む）" : ""}</p>
    <h2 className="mt-1 text-2xl font-black leading-tight">{trend.name}<span className="block text-amber-300">過去{trend.editions}年の傾向</span></h2>
    <p className="mt-1 text-xs text-slate-400">{trend.yearFrom}〜{trend.yearTo}年</p>
    <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">{tiles.map(([label, value, note]) => <Card key={label} className="p-3">
      <p className="text-[11px] text-slate-400">{label}</p><p className="mt-1 text-2xl font-black text-amber-300">{value}</p><p className="text-[11px] text-slate-400">{note}</p>
    </Card>)}</div>
    <div role="tablist" aria-label="傾向のページ" className="mt-4 flex gap-1 overflow-x-auto rounded-xl bg-black/30 p-1 text-sm" data-no-swipe>
      {TREND_PAGES.map((p, i) => <button key={p.id} role="tab" type="button" aria-selected={page === p.id} onClick={() => setPage(p.id)} className={`shrink-0 rounded-lg px-3 py-2 font-bold ${page === p.id ? "bg-amber-300 text-[#0d1615]" : "text-slate-300"}`}>{"①②③④⑤"[i]} {p.label}</button>)}
    </div>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      {current.id === "results" ? <Results trend={trend} /> : <>
        {current.id === "blood" && <><Lineage title="父（種牡馬）" rows={trend.sires} /><Lineage title="母の父" rows={trend.damSires} /></>}
        {sectionsFor(trend, current.sections).map(s => <Bars key={s.title} section={s} base={base} />)}
      </>}
    </div>
    <p className="mt-3 text-[11px] leading-5 text-slate-500">JRAの公式結果を集計。{limitations.join("")}過去の集計で、的中を約束するものではありません。</p>
  </section>;
}
