"use client";
import { useEffect, useState } from "react";
import { cushionImpact, cushionDescription, displayTrackEntries, JRA_TRACK_VENUES, safeTrackSource, validTrackDate, type TrackReferenceData, type TrackRecord } from "@/lib/track-reference";
import { NAR_COURSES } from "@/lib/nar-source";

type Race = { raceId: string; title: string; course: string; startsAt?: number | null; league?: "jra" | "nar" };
const moisture = (value: number | null) => typeof value === "number" ? `${value.toFixed(1)}%` : "未取得";
function Source({ href }: { href: string }) { return safeTrackSource(href) ? <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-cyan-200 underline">公式資料を見る ↗</a> : null; }
function CushionImpact({ value, turf, venue }: { value: number | null; turf: boolean; venue?: string }) {
  const impact = cushionImpact(value);
  if (!impact) return null;
  return <div aria-label="クッション値による影響の参考" className="mt-3 space-y-2 rounded-lg bg-slate-800/70 p-3 text-xs leading-5">
    <h3 className="font-semibold text-cyan-100">走りへの影響・見るポイント（{impact.label}）</h3>
    <p><strong className="text-slate-200">馬場の特徴：</strong>{impact.effect}</p>
    {turf ? <><p><strong className="text-slate-200">予想での見方：</strong>{impact.check}</p><p><strong className="text-slate-200">展開への影響：</strong>逃げ・先行・差しの有利不利は、この数値だけでは判定できません。当日の同じ芝コースの結果・ペースと合わせて確認してください。</p></> : <p>これは芝の測定値です。このダートレースの時計や脚質の有利不利には当てはめません。</p>}
    {(venue === "札幌" || venue === "函館") && <p>札幌・函館の洋芝は、野芝の競馬場より値が低く出る傾向があります。他場の同じ数値と単純比較せず、同じ競馬場で確認してください。</p>}
    <p className="text-slate-400">掲載された測定値に対する一般的な解説です。今回の的中率・各馬の適性を示すものではありません。</p>
    <a href="https://www.jra.go.jp/keiba/baba/cushion/" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-cyan-200 underline">解説の根拠：JRA クッション値の基礎知識 ↗</a>
  </div>;
}
function Measurement({ record, turf, explain = false, venue }: { record: TrackRecord; turf: boolean; explain?: boolean; venue?: string }) {
  if (record.payload.kind !== "measurement") return null;
  const p = record.payload;
  return <div className="space-y-1">
    <p>{record.reference_date} 測定{p.cushion_time ? ` ${p.cushion_time}` : "（時刻未取得）"}{p.course ? ` ／ ${p.course}コース` : ""}</p>
    <p>芝クッション値：<strong className="text-lg text-cyan-100">{typeof p.cushion === "number" ? `${p.cushion.toFixed(1)}（${cushionDescription(p.cushion)}）` : "未取得"}</strong></p>
    <p>{turf ? "芝" : "ダート"}含水率：ゴール前 {moisture(turf ? p.turf_moisture_goal : p.dirt_moisture_goal)} ／ 4コーナー {moisture(turf ? p.turf_moisture_turn4 : p.dirt_moisture_turn4)}{p.moisture_time ? `（${p.moisture_time}）` : ""}</p>
    {explain && <CushionImpact value={p.cushion} turf={turf} venue={venue} />}
    <Source href={record.source_url} />
  </div>;
}
function SandMeasurement({ record }: { record: TrackRecord }) {
  if (record.payload.kind !== "sand_measurement") return null;
  const p = record.payload, labels: Record<string,string> = { turn12: "1・2コーナー", back: "向正面", turn34: "3・4コーナー", home: "正面" };
  return <div className="space-y-2"><p>{record.reference_date} 測定 ／ {new Date(p.measured_at).toLocaleTimeString("ja-JP",{timeZone:"Asia/Tokyo",hour:"2-digit",minute:"2-digit"})}（日本時間）</p><p>測定時の馬場状態：{p.going_at_measurement}</p><ul className="space-y-1 text-xs leading-5">{Object.entries(p.sand_cm_by_segment).map(([key,values]) => <li key={key}>{labels[key] ?? key}：{Math.min(...values)}〜{Math.max(...values)}cm（{values.length}地点）</li>)}</ul><p className="text-xs text-slate-400">測定地点ごとの範囲。内側・外側を含む全地点の数値は公式資料で確認できます。</p><Source href={record.source_url}/></div>;
}
export function TrackReferencePanel({ race }: { race: Race }) {
  const league = race.league ?? "jra";
  const venue = league === "nar" ? NAR_COURSES[race.raceId.slice(8,10)] : JRA_TRACK_VENUES[Number(race.raceId.slice(2,4))-1];
  const date = league === "nar" ? `${race.raceId.slice(0,4)}-${race.raceId.slice(4,6)}-${race.raceId.slice(6,8)}` : typeof race.startsAt === "number" && Number.isFinite(race.startsAt) ? new Date(race.startsAt + 9*3600_000).toISOString().slice(0,10) : "";
  const key = `${league}:${venue}:${date}`;
  const [state, setState] = useState<{ key: string; data?: TrackReferenceData; error?: string }>({ key: "" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!venue || !validTrackDate(date)) return;
    const controller = new AbortController();
    setState({ key });
    fetch(`${league === "nar" ? "/api/nar" : "/api/races"}/track-reference?${new URLSearchParams({venue,date})}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error || "参考情報を取得できませんでした"); if (body.venue !== venue || body.date !== date) throw new Error("参考情報の照合に失敗しました"); return body as TrackReferenceData; })
      .then(data => { if (!controller.signal.aborted) setState({ key, data }); })
      .catch(error => { if (!controller.signal.aborted) setState({ key, error: error instanceof Error ? error.message : "参考情報を取得できませんでした" }); });
    return () => controller.abort();
  }, [key, league, venue, date, attempt]);
  const data = state.key === key ? state.data : undefined;
  const latest = data?.records[0], turf = /芝|障/.test(race.course);
  return <section aria-label="馬場の参考情報" className="mb-4 min-w-0 rounded-2xl border border-cyan-300/25 bg-[#0c192a] p-4 text-sm text-slate-300">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold text-white">馬場の参考情報{venue ? ` ・ ${venue}` : ""}</h2><span className="rounded bg-slate-700/60 px-2 py-1 text-xs">参考表示</span></div>
    {league === "jra" ? <p className="mt-2 text-xs leading-5 text-slate-400">クッション値は芝の表面の硬さの目安です。ダートの評価や、逃げ・差しの有利不利をこの値だけで判断するものではありません。</p> : <p className="mt-2 text-xs leading-5 text-slate-400">地方のクッション値は取得できていません。取得済みの砂厚の測定記録・整備告知を表示します。砂厚はクッション値とは別の指標です。</p>}
    {!venue || !validTrackDate(date) ? <p className="mt-3">対象の競馬場・開催日を確認できません。</p> : !data ? <p role="status" className="mt-3">{state.key === key && state.error ? <>{state.error}<button type="button" onClick={() => setAttempt(n => n+1)} className="ml-2 min-h-11 text-cyan-200 underline">再取得</button></> : "公式の参考情報を確認中…"}</p> : <>
      {data.live && <div className="mt-3 rounded-xl border border-cyan-300/20 bg-cyan-300/5 p-3">
        <p className="text-xs text-cyan-200">公式の直近掲載（対象日の値とは未照合）</p>
        <p className="mt-1 font-bold text-white">芝クッション値 <span className="text-2xl">{data.live.value.toFixed(1)}</span> ・ {cushionDescription(data.live.value)}</p>
        <p className="mt-1">{data.live.observedTime}</p>
        <CushionImpact value={data.live.value} turf={turf} venue={venue} />
        <p className="mt-1 text-xs leading-5 text-slate-400">原文に年の記載がないため、対象日の測定値としては扱っていません。取得：{new Date(data.live.fetchedAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})}（日本時間）</p><Source href={data.live.sourceUrl} />
      </div>}
      {data.liveError && <p className="mt-3 text-xs text-amber-200">公式の直近掲載値を取得できませんでした。取得済みの過去資料を表示します。</p>}
      {latest ? <div className="mt-3 rounded-xl border border-slate-700 p-3">
        <p className="mb-2 text-xs font-semibold text-amber-100">{(latest.payload.kind === "measurement" || latest.payload.kind === "sand_measurement") ? latest.reference_date === date ? "対象日と同日の測定記録" : "過去の測定記録（対象日の値ではありません）" : "取得済みの直近告知（当日の実測ではありません）"}</p>
        {latest.payload.kind === "measurement" ? <Measurement record={latest} turf={turf} explain={!data.live} venue={venue} /> : latest.payload.kind === "sand_measurement" ? <SandMeasurement record={latest} /> : <><p>{latest.reference_date} 公表</p><ul className="mt-2 space-y-2 text-xs leading-5">{displayTrackEntries(latest.payload.entries).slice(0,5).map(text => <li key={text}>{text}</li>)}</ul>{latest.payload.entries.length > 5 && <details className="mt-2"><summary className="min-h-11 cursor-pointer py-2 text-cyan-200">地点別の砂厚・告知の全文</summary><ul className="space-y-2 text-xs leading-5">{displayTrackEntries(latest.payload.entries).map(text => <li key={text}>{text}</li>)}</ul></details>}<Source href={latest.source_url} /></>}
        {data.records.length > 1 && <details className="mt-2 border-t border-slate-700 pt-2"><summary className="min-h-11 cursor-pointer py-2 text-cyan-200">それ以前の取得済み資料（{data.records.length-1}件）</summary><div className="space-y-4 pt-2">{data.records.slice(1).map(record => <div key={`${record.reference_date}:${record.source_url}`} className="border-t border-slate-700 pt-3">{record.payload.kind === "measurement" ? <Measurement record={record} turf={turf} /> : record.payload.kind === "sand_measurement" ? <SandMeasurement record={record} /> : <><p>{record.reference_date} 公表</p><ul className="mt-1 space-y-1 text-xs">{displayTrackEntries(record.payload.entries).map(text => <li key={text}>{text}</li>)}</ul><Source href={record.source_url} /></>}</div>)}</div></details>}
      </div> : <p className="mt-3">対象日以前の日付を確認できる資料は未取得です。</p>}
    </>}
    <p className="mt-3 text-xs leading-5 text-slate-400">過去資料・告知は現在の状態を保証しません。予想スコア・買い目への加点は行っていません。</p>
  </section>;
}
