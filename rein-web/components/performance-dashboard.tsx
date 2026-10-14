"use client";

import { useEffect, useState } from "react";
import { BarChart3 } from "lucide-react";
import { PERFORMANCE_PERIODS, TICKET_GROUPS, rate, type PerformancePeriod, type PerformanceSummary, type TicketStats } from "@/lib/performance";

type Response = PerformanceSummary & { days: PerformancePeriod; range: { from: string; to: string }; generatedAt: string };
const pct = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
const roiClass = (value: number | null) => (value === null ? "text-slate-500" : value >= 1 ? "text-emerald-300" : "text-slate-100");
const yen = (value: number) => `${value.toLocaleString()}円`;

export function PerformanceDashboard({ league }: { league: "jra" | "nar" }) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<PerformancePeriod>(30);
  const [group, setGroup] = useState<"合計" | (typeof TICKET_GROUPS)[number]>("合計");
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setData(null); setError("");
    fetch(`${league === "nar" ? "/api/nar" : "/api/analyze"}/performance?days=${days}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || "成績を読み込めませんでした"); return body as Response; })
      .then(setData)
      .catch((value) => { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : "成績を読み込めませんでした"); });
    return () => controller.abort();
  }, [open, days, league, retry]);
  return (
    <section aria-label="REINの成績" data-testid="performance-dashboard" className="mt-5 rounded-2xl border border-emerald-300/25 bg-[#0c192a] text-white">
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="flex min-h-14 cursor-pointer items-center gap-2 p-4 sm:px-5">
          <BarChart3 aria-hidden="true" className="size-5 text-emerald-300" />
          <span className="min-w-0"><span className="block font-bold">REINの成績</span><span className="block text-xs text-slate-400">発走前に保存した予想の答え合わせ（印・券種別の的中率と回収率）</span></span>
        </summary>
        <div className="px-4 pb-5 sm:px-5">
          <div className="flex gap-2" role="group" aria-label="集計期間" data-no-swipe>
            {PERFORMANCE_PERIODS.map((value) => (
              <button key={value} type="button" aria-pressed={days === value} onClick={() => setDays(value)}
                className={`min-h-11 flex-1 rounded-lg border text-sm font-semibold ${days === value ? "border-emerald-300 bg-emerald-300/15 text-emerald-100" : "border-slate-700 text-slate-400"}`}>
                直近{value}日
              </button>
            ))}
          </div>
          {error ? <p role="status" className="mt-4 text-sm text-amber-200">{error}<button type="button" onClick={() => setRetry((value) => value + 1)} className="ml-2 min-h-11 underline">再読み込み</button></p>
            : !data ? <p role="status" className="mt-4 text-sm text-slate-400">集計中…</p>
            : <>
              <p className="mt-3 text-xs leading-5 text-slate-400">
                {data.range.from}〜{data.range.to}・保存した発走前予想 {data.saved}レースのうち <strong className="text-white">{data.counted}レース</strong>を集計
                {data.saved > data.counted && `（結果待ち${data.excluded.pending}・取消/除外あり${data.excluded.scratched}・払戻未取得${data.excluded.noPayout}は除外）`}
              </p>
              {!data.counted ? <p className="mt-4 rounded-xl border border-dashed border-slate-600 p-4 text-sm text-slate-400">この期間に集計できるレースはまだありません。</p> : <>
              <h3 className="mt-5 text-sm font-bold">印の成績（1点100円）</h3>
              <div className="mt-2 overflow-hidden rounded-xl border border-slate-700">
                <table className="w-full table-fixed text-right text-xs">
                  <thead className="bg-[#142038] text-slate-300"><tr><th scope="col" className="w-[22%] p-2 text-left">印</th><th scope="col" className="p-2">勝率</th><th scope="col" className="p-2">複勝率</th><th scope="col" className="p-2">単勝<br />回収率</th><th scope="col" className="p-2">複勝<br />回収率</th></tr></thead>
                  <tbody>{data.marks.map((mark) => {
                    const winRoi = rate(mark.winReturn, mark.races * 100), placeRoi = rate(mark.placeReturn, mark.races * 100);
                    return <tr key={mark.key} className="border-t border-slate-800"><th scope="row" className="p-2 text-left font-semibold">{mark.label}<span className="block text-[10px] font-normal text-slate-500">{mark.races}R・連対{pct(rate(mark.top2, mark.races))}</span></th><td className="p-2">{pct(rate(mark.wins, mark.races))}</td><td className="p-2">{pct(rate(mark.top3, mark.races))}</td><td className={`p-2 font-bold ${roiClass(winRoi)}`}>{pct(winRoi)}</td><td className={`p-2 font-bold ${roiClass(placeRoi)}`}>{pct(placeRoi)}</td></tr>;
                  })}</tbody>
                </table>
              </div>
              {data.tickets.length ? <>
                <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold">参考買い目の成績</h3>
                  <div className="flex gap-1" role="group" aria-label="買い目の区分" data-no-swipe>
                    {(["合計", ...TICKET_GROUPS] as const).map((value) => <button key={value} type="button" aria-pressed={group === value} onClick={() => setGroup(value)} className={`min-h-9 rounded-md border px-2.5 text-xs ${group === value ? "border-emerald-300 bg-emerald-300/15 text-emerald-100" : "border-slate-700 text-slate-400"}`}>{value}</button>)}
                  </div>
                </div>
                <div className="mt-2 overflow-hidden rounded-xl border border-slate-700">
                  <table className="w-full table-fixed text-right text-xs">
                    <thead className="bg-[#142038] text-slate-300"><tr><th scope="col" className="w-[24%] p-2 text-left">券種</th><th scope="col" className="p-2">的中率</th><th scope="col" className="w-[34%] p-2">払戻／投資</th><th scope="col" className="p-2">回収率</th></tr></thead>
                    <tbody>{data.tickets.map((ticket) => {
                      const stats: TicketStats = group === "合計" ? ticket.total : ticket.tiers[group];
                      const roi = rate(stats.returned, stats.stake);
                      return <tr key={ticket.type} className="border-t border-slate-800"><th scope="row" className="p-2 text-left font-semibold">{ticket.type}<span className="block text-[10px] font-normal text-slate-500">{stats.races}R・{stats.points}点</span></th><td className="p-2">{pct(rate(stats.hitRaces, stats.races))}</td><td className="p-2 text-[11px] text-slate-300">{yen(stats.returned)}<span className="block text-slate-500">{yen(stats.stake)}</span></td><td className={`p-2 font-bold ${roiClass(roi)}`}>{pct(roi)}</td></tr>;
                    })}</tbody>
                  </table>
                </div>
              </> : <p className="mt-4 text-xs text-slate-400">{league === "nar" ? "地方の参考買い目は保留中のため、印の成績のみ集計しています。" : "この期間の参考買い目はまだ集計できません。"}</p>}
              </>}
              <p className="mt-3 text-[11px] leading-5 text-slate-500">各レースで最後に保存した発走前予想を、確定結果・払戻と照合しています。発走後の再計算や後から作った予想は含みません。的中率は1点でも当たったレースの割合です。取消・除外のあったレースは返還の扱いが異なるため除外しています。過去の成績は将来の結果を保証しません。</p>
            </>}
        </div>
      </details>
    </section>
  );
}
