"use client";
import { useEffect, useState } from "react";
import { FINDER_REFERENCE, KIND_ORDER, RACE_KINDS, finderHit, type FinderRow, type League, type RaceFinder as Finder, type RaceKind } from "@/lib/race-finder";

const pct = (n: number, d: number) => d ? `${Math.round(n / d * 1000) / 10}%` : "—";
const yen = (n: number) => `${n.toLocaleString()}円`;
const timeJst = (iso: string | null) => iso && Number.isFinite(Date.parse(iso)) ? new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(11, 16) : null;
const tone: Record<RaceKind, string> = { solid: "bg-sky-300 text-[#07111f]", middle: "bg-amber-300 text-[#07111f]", rough: "bg-rose-400 text-[#07111f]" };
const closed = (row: FinderRow, now: number) => row.startsAt !== null && row.startsAt <= now;
const judged = (row: FinderRow, now: number) => closed(row, now) && row.verified && row.kind && row.result ? finderHit(row.kind, row.result.payout) : null;

export function RaceFinder({ league, onOpen }: { league: League; onOpen: (raceId: string) => void }) {
  const [finder, setFinder] = useState<Finder | null>(null), [error, setError] = useState("");
  const [kind, setKind] = useState<RaceKind>("rough"), [ended, setEnded] = useState(false), [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const controller = new AbortController(); setFinder(null); setError("");
    async function load() {
      try {
        const response = await fetch(`${league === "nar" ? "/api/nar" : "/api/analyze"}/race-finder`, { cache: "no-store", signal: controller.signal });
        const body = await response.json().catch(() => ({})) as Finder & { error?: string };
        if (!response.ok || !Array.isArray(body.rows)) throw new Error(body.error || "レースの区分を取得できませんでした");
        setFinder(body); setError(""); setNow(Date.now());
      } catch (value) { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : "レースの区分を取得できませんでした"); }
    }
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [league]);
  const reference = FINDER_REFERENCE[league], ref = reference.kinds[kind], meta = RACE_KINDS[kind];
  const all = finder?.rows ?? [], pendingOdds = all.filter(row => !row.kind && !closed(row, now)).length;
  const rows = all.filter(row => row.kind === kind && (ended || !closed(row, now)));
  const results = ended ? rows.map(row => judged(row, now)).filter((v): v is boolean => v !== null) : [];
  return <section aria-label="条件でレースを探す" data-testid="race-finder" className="mt-5 rounded-2xl border border-rose-400/30 bg-[#0c192a] p-4 sm:p-5">
    <h2 className="font-bold text-rose-100">🎯 条件でレースを探す</h2>
    <p className="mt-1 text-xs leading-5 text-slate-400">単勝オッズの割れ具合から、本日のレースを固め・中穴・荒れそうに分けます。</p>
    <div role="group" aria-label="レースの区分" className="mt-3 grid grid-cols-3 gap-1 rounded-lg bg-black/20 p-1 text-sm" data-no-swipe>
      {KIND_ORDER.map(k => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={`rounded-md px-2 py-2 font-bold ${kind === k ? tone[k] : "text-slate-300"}`}>
        {RACE_KINDS[k].label}<span className="ml-1 text-[11px] font-normal">{finder ? all.filter(row => row.kind === k && !closed(row, now)).length : ""}</span>
      </button>)}
    </div>
    <p className="mt-3 text-xs leading-5 text-slate-300">{meta.description}</p>
    <div data-testid="finder-reference" className="mt-2 rounded-lg bg-black/20 p-3 text-xs leading-6 text-slate-300">
      検証 {reference.period}（発走約5分前のオッズ）<br />
      {meta.label}に分類 {ref.races}R：{meta.hitLabel} <strong className="text-white">{pct(ref.hits, ref.races)}</strong>（{ref.hits}/{ref.races}R）<br />
      万馬券 {pct(ref.jackpots, ref.races)}・30倍未満 {pct(ref.cheap, ref.races)}・配当中央値 {yen(ref.median)}<br />
      <span className="text-slate-400">参考：全{reference.total}Rの万馬券 {pct(reference.jackpots, reference.total)}{league === "jra" ? "。中央は検証レース数が少なく、検証中です" : ""}</span>
    </div>
    <div className="mt-3 flex items-center justify-between gap-2 text-xs">
      <label className="flex items-center gap-1.5 text-slate-300"><input type="checkbox" checked={ended} onChange={e => setEnded(e.target.checked)} />終了したレースも見る</label>
      {finder && <span className="text-slate-500">{timeJst(finder.generatedAt)}更新</span>}
    </div>
    {error ? <p role="status" className="mt-3 text-sm text-amber-200">{error}</p>
      : !finder ? <p role="status" className="mt-3 text-sm text-slate-400">確認中…</p>
      : <>
        {ended && results.length > 0 && <p data-testid="finder-review" className="mt-3 rounded-lg bg-black/20 px-3 py-2 text-sm font-bold">終了したレースの結果　<span className="text-emerald-300">○{results.filter(Boolean).length}</span>　<span className="text-rose-300">✕{results.filter(v => !v).length}</span>（{pct(results.filter(Boolean).length, results.length)}）</p>}
        {rows.length ? <ul className="mt-2 divide-y divide-slate-800">{rows.map(row => {
          const done = closed(row, now), hit = judged(row, now);
          return <li key={row.raceId}><button type="button" onClick={() => onOpen(row.raceId)} className="flex w-full items-center gap-3 py-3 text-left hover:bg-white/[.03]">
            <span className="w-12 shrink-0 text-center"><span className="block text-sm font-semibold text-cyan-200">{row.start || "--:--"}</span><span className="text-[10px] text-slate-500">{done ? "締切済" : `あと${Math.max(1, Math.ceil(((row.startsAt ?? now) - now) / 60_000))}分`}</span></span>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold">{row.venue}{row.number}R <span className="font-normal text-slate-300">{row.title.replace(/^\S+\s*\d+R\s*/, "")}</span></span>
              <span className="block text-[11px] text-slate-400">{row.field}頭・人気の割れ {row.effective?.toFixed(1)}頭分{row.favorite ? `・1番人気 ${row.favorite.odds.toFixed(1)}倍` : ""}{!done && timeJst(row.oddsAt) ? `（${timeJst(row.oddsAt)}のオッズ）` : ""}</span></span>
            <span className="shrink-0 text-right">{row.result && done ? <>
              {hit !== null ? <b data-finder-hit={hit ? "hit" : "miss"} className={`mr-1 text-xl ${hit ? "text-emerald-300" : "text-rose-300"}`}>{hit ? "○" : "✕"}</b> : <span className="mr-1 text-[10px] text-slate-500">参考外</span>}
              <span className="text-sm font-bold">{yen(row.result.payout)}</span>{row.result.payout >= 10_000 && <span className="ml-1 rounded bg-amber-300 px-1 text-[10px] font-bold text-[#07111f]">万馬券</span>}
              <span className="block text-[11px] text-slate-400">{row.result.selection}{row.result.popularity ? `（${row.result.popularity}番人気）` : ""}</span>
            </> : <span className={`rounded px-2 py-1 text-xs font-bold ${tone[kind]}`}>{meta.label}</span>}</span>
          </button></li>;
        })}</ul> : <p className="mt-3 text-sm text-slate-400">{ended ? `本日、${meta.label}に分類されたレースはまだありません。` : `これから発走のレースに、${meta.label}に分類されたレースはありません。「終了したレースも見る」で今日の結果を振り返れます。`}</p>}
        {pendingOdds > 0 && <p className="mt-2 text-[11px] text-slate-500">オッズ未取得などで未分類：{pendingOdds}R</p>}
      </>}
    <details className="mt-3 text-xs leading-6 text-slate-400"><summary className="cursor-pointer font-semibold text-slate-300">判定の仕組み</summary>
      <p>単勝オッズを人気の割れ具合に換算し、何頭分に人気が分かれているかで分類します（1頭に集中＝1、全頭同じ＝出走頭数）。区切りは発走約5分前に保存したオッズの前半2週間で決め、後半2週間で上の成績を確かめました。</p>
      <p>表示中の区分は、その時点の最新オッズによるものです。朝や前日のオッズでは区分が変わることがあります。終了したレースの○✕は、発走前に保存したオッズで分類したレースだけを対象にしています。的中や利益を保証するものではありません。</p>
    </details>
  </section>;
}
