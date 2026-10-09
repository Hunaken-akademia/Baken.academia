"use client";
import { useEffect, useState } from "react";
import type { Horse } from "@/lib/horse-types";
import type { RaceContextData } from "@/lib/race-context-types";
import { daysBetween } from "@/lib/previous-run";
import { raceSurface, type TrendGroup } from "@/lib/race-day-trends";

type Race = { raceId: string; league?: "jra" | "nar"; title: string; course: string; condition: string };
const cached = new Map<string, { until: number; promise: Promise<RaceContextData> }>();
function requestContext(url: string) {
  const hit = cached.get(url);
  if (hit && hit.until > Date.now()) return hit.promise;
  if (cached.size >= 40) cached.delete(cached.keys().next().value!);
  const promise = fetch(url, { cache: "no-store" }).then(async response => {
    if (!response.ok) throw new Error("比較用データを取得できませんでした。");
    const body = await response.json() as RaceContextData;
    if (!body.trends || !body.previousRuns) throw new Error("比較用データを確認できませんでした。");
    return body;
  }).catch(error => { cached.delete(url); throw error; });
  cached.set(url, { until: Date.now() + 300000, promise });
  return promise;
}
function useRaceContext(race: Race): { data?: RaceContextData; error?: string; loading: boolean; retry: () => void } {
  const url = `${race.league === "nar" ? "/api/nar" : "/api"}/analyze/context?raceId=${encodeURIComponent(race.raceId)}`;
  const [attempt, setAttempt] = useState(0), [state, setState] = useState<{ url: string; data?: RaceContextData; error?: string; loading: boolean }>({ url, loading: true });
  useEffect(() => {
    let active = true;
    setState({ url, loading: true });
    requestContext(url).then(data => { if (active) setState({ url, data, loading: false }); }).catch(error => { if (active) setState({ url, error: error.message, loading: false }); });
    return () => { active = false; };
  }, [url, attempt]);
  return { ...(state.url === url ? state : { loading: true }), retry: () => { cached.delete(url); setAttempt(n => n + 1); } };
}
const time = (value: string) => new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const signed = (value: number) => `${value > 0 ? "+" : ""}${Math.round(value * 10) / 10}`;
const known = (value?: string) => !!value && !/未取得|未発表|取得中|不明/.test(value);
const change = (before?: string, current?: string) => known(before) && known(current) ? before!.replace(/[\s◇△▲☆★]/g, "") === current!.replace(/[\s◇△▲☆★]/g, "") ? "同じ" : "変更" : "比較保留";
const weight = (value?: number) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
function Pending({ loading, error, retry }: { loading: boolean; error?: string; retry: () => void }) {
  return <div className="mt-3 text-sm text-slate-300" role="status">{loading ? "比較用データを確認しています…" : error || "データを確認できませんでした。"}{!loading && <button type="button" onClick={retry} className="ml-2 min-h-11 text-cyan-200 underline">再取得</button>}</div>;
}

export function PreviousRaceComparison({ horse, race }: { horse: Horse; race: Race }) {
  const state = useRaceContext(race), previous = state.data?.previousRuns[horse.number];
  const venue = race.title.match(/^(.*?)(?:\s*\d+R)/)?.[1]?.trim();
  const distance = Number(race.course.match(/(\d{3,4})m/)?.[1]) || undefined;
  const currentCarried = weight(horse.weightCarried), currentWeight = weight(horse.weight);
  const interval = previous && state.data ? daysBetween(previous.date, state.data.date) : null;
  const rows = previous ? [
    ["距離", previous.distanceM ? `${previous.distanceM}m` : "未取得", distance ? `${distance}m` : "未取得", distance && previous.distanceM ? distance === previous.distanceM ? "同距離" : `${signed(distance - previous.distanceM)}m ${distance > previous.distanceM ? "延長" : "短縮"}` : "比較保留"],
    ["芝・ダート", previous.surface || "未取得", raceSurface(race.course) || "未取得", change(previous.surface, raceSurface(race.course) ?? undefined)],
    ["競馬場", previous.venue || "未取得", venue || "未取得", change(previous.venue, venue)],
    ["馬場状態", previous.going || "未取得", race.condition || "未発表", change(previous.going, race.condition)],
    ["負担重量", previous.weightCarried ? `${previous.weightCarried}kg` : "未取得", currentCarried ? `${currentCarried}kg` : "未発表", currentCarried && previous.weightCarried ? `${signed(currentCarried - previous.weightCarried)}kg` : "比較保留"],
    ["騎手", previous.jockey || "未取得", horse.jockey || "未取得", change(previous.jockey, horse.jockey) === "変更" ? "乗り替わり" : change(previous.jockey, horse.jockey)],
    ["馬体重", previous.bodyWeight ? `${previous.bodyWeight}kg` : "未取得", currentWeight ? `${currentWeight}kg` : "未発表", currentWeight && previous.bodyWeight ? `${signed(currentWeight - previous.bodyWeight)}kg` : "比較保留"],
  ] : [];
  return <section aria-label="前走との条件比較" className="mt-4 rounded-xl border border-cyan-300/25 bg-cyan-300/[.04] p-3 sm:p-4">
    <h3 className="text-base font-bold">前走との条件比較</h3>
    {!state.data ? <Pending {...state} /> : state.data.previousError ? <Pending loading={false} error={state.data.previousError} retry={state.retry} /> : !previous ? <p className="mt-3 text-sm text-slate-400">この馬の前走欄を確認できません。初出走・履歴未掲載・照合できない場合は比較を保留します。</p> : <>
      <p className="mt-2 text-sm text-slate-200">{previous.date.replaceAll("-", "/")} {previous.venue} {previous.raceName || ""}　{previous.finish ? `${previous.finish}着` : previous.result || "着順未取得"}{previous.fieldSize ? ` / ${previous.fieldSize}頭` : ""}</p>
      <p className="mt-1 text-xs text-cyan-200">{interval === null ? "間隔未確認" : `掲載前走から${interval}日（${Math.floor(interval / 7)}週${interval % 7}日）`}</p>
      <div className="mt-3 space-y-2">{rows.map(([label, before, current, diff]) => <div key={label} className="rounded-lg bg-slate-950/50 p-3">
        <div className="flex flex-wrap justify-between gap-1 text-xs"><span className="font-bold text-slate-300">{label}</span><span className={diff === "比較保留" ? "text-slate-500" : "text-cyan-200"}>{diff}</span></div>
        <div className="mt-2 grid grid-cols-2 gap-3 text-sm"><p className="min-w-0 break-words"><span className="mb-1 block text-[10px] text-slate-500">前走</span>{before}</p><p className="min-w-0 break-words"><span className="mb-1 block text-[10px] text-slate-500">今回</span>{current}</p></div>
      </div>)}</div>
      <p className="mt-3 text-xs leading-5 text-slate-400">出走表の前走欄との事実比較です。条件変更の有利・不利を断定するものではありません。今回の値は画面に表示中の出走表・保存予想に合わせています。</p>
      {state.data.previousFetchedAt && <p className="mt-1 text-[11px] text-slate-500">前走データ：{time(state.data.previousFetchedAt)}取得</p>}
    </>}
  </section>;
}

function TrendTable({ title, groups }: { title: string; groups: TrendGroup[] }) {
  return <div className="min-w-0 rounded-xl border border-slate-700 p-3"><h4 className="text-sm font-bold">{title}</h4><div className="mt-3 space-y-3">{groups.map(g => <div key={g.label}>
    <p className="text-sm font-semibold text-slate-200">{g.label}<span className="ml-2 text-xs font-normal text-slate-400">{g.runners}頭</span></p>
    <div className="mt-1 grid grid-cols-2 gap-2 text-xs leading-5"><p>勝率 <strong className="text-cyan-200">{g.winRate === null ? "—" : `${g.winRate.toFixed(1)}%`}</strong><span className="block text-slate-400">{g.wins}勝 / {g.runners}頭</span></p><p>3着内率 <strong className="text-cyan-200">{g.top3Rate === null ? "—" : `${g.top3Rate.toFixed(1)}%`}</strong><span className="block text-slate-400">{g.top3}頭 / {g.runners}頭</span></p></div>
  </div>)}</div></div>;
}
export function RaceDayTrends({ race }: { race: Race }) {
  const state = useRaceContext(race), trends = state.data?.trends;
  return <section aria-label="当日の結果傾向" className="mb-5 rounded-2xl border border-cyan-300/25 bg-[#111b30] p-4 text-white sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-xl font-bold">当日の結果傾向</h2><span className="rounded-full bg-cyan-300/10 px-3 py-1 text-xs text-cyan-200">馬場を考える参考</span></div>
    <p className="mt-2 text-sm leading-6 text-slate-300">同じ競馬場・同じ芝／ダートで、このレースより前に保存できた確定結果を集計します。</p>
    {!trends ? <Pending {...state} /> : !trends.supported ? <p className="mt-3 text-sm text-slate-400">ばんえい・障害など、平地の芝／ダート以外は集計対象外です。</p> : <>
      <div className="mt-4 grid grid-cols-3 gap-2">{[["対象レース", `${trends.raceCount}レース`], ["出走頭数", `${trends.runnerCount}頭`], ["馬場種別", trends.surface || "不明"]].map(([label, value]) => <div key={label} className="min-w-0 rounded-xl bg-black/25 p-3"><p className="text-[10px] text-slate-400">{label}</p><p className="mt-1 text-sm font-bold text-cyan-200 sm:text-lg">{value}</p></div>)}</div>
      <p className="mt-3 text-xs text-slate-400">集計期限：{trends.cutoff ? `${time(trends.cutoff)}より前` : "発走時刻を確認できず保留"}。選択中・後続のレースは含みません。</p>
      {trends.raceCount ? <><p className="mt-3 rounded-lg bg-amber-300/10 p-3 text-xs leading-5 text-amber-100">{trends.raceCount < 3 ? "まだ少数の結果です。" : "1日分の少数集計です。"}距離・出走馬の能力・馬場状態の違いは補正していません。馬場の有利・不利や次のレースの的中率を示す数値ではありません。</p><div className="mt-4 grid gap-3 lg:grid-cols-2"><TrendTable title="枠ごとの結果" groups={trends.gates} /><TrendTable title="近走から分類した脚質ごとの結果" groups={trends.styles} /></div><p className="mt-3 text-xs leading-5 text-slate-400">脚質は各馬の近走からの分類です。当日の実際の通過順ではありません。分類不明は分母から除外（枠{trends.unknownGate}頭・脚質{trends.unknownStyle}頭）。</p></> : <p className="mt-4 rounded-xl bg-black/20 p-4 text-sm leading-6 text-slate-300">{trends.priorCount === 0 ? "最初のレースのため、先行する結果はまだありません。" : "集計条件を満たす確定結果がまだありません。確認できない数値は表示を保留しています。"}</p>}
      <details className="mt-4 rounded-xl border border-slate-700 p-3"><summary className="min-h-8 cursor-pointer text-sm font-semibold">集計したレース・対象外の内訳</summary><ul className="mt-2 space-y-2 text-xs leading-5">{trends.races.map(r => <li key={r.raceId}>{r.title}・{r.course}・{r.condition}・{r.runners}頭<span className="block text-slate-400">結果保存 {time(r.capturedAt)}</span></li>)}</ul><p className="mt-3 text-xs leading-5 text-slate-400">同場の先行{trends.priorCount}レース中、未保存{trends.excluded.missing}・未確定{trends.excluded.pending}・期限前の結果保存を確認できず{trends.excluded.afterCutoff}・別馬場{trends.excluded.otherSurface}・結果不整合{trends.excluded.invalid}レースを除外。後日取得や上書きで保存時刻が期限以後の結果も除外します。</p></details>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400"><span>{state.data && time(state.data.generatedAt)}集計・最大5分間隔で更新</span><button type="button" onClick={state.retry} disabled={state.loading} className="min-h-11 text-cyan-200 underline">データを再取得</button></div>
    </>}
  </section>;
}
