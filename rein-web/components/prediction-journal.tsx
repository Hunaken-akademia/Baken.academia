"use client";

import { useEffect, useState } from "react";
import { useReinCloudData } from "@/components/rein-cloud-provider";
import type { JournalInput, SharedJournal } from "@/lib/prediction-journal";

const stamp = (value: string) => new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function PredictionJournal({ data }: { data: JournalInput }) {
  const [history, setHistory] = useState<SharedJournal | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  // The shared history is only fetched when opened; the main race snapshot paints first.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError(""); setHistory(null);
    fetch(`${data.race.raceId.length === 12 ? "/api/nar" : "/api"}/race-history?raceId=${encodeURIComponent(data.race.raceId)}`, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(); return response.json() as Promise<SharedJournal>; })
      .then(setHistory)
      .catch(() => { if (!controller.signal.aborted) setError("保存履歴を読み込めませんでした。"); });
    return () => controller.abort();
  }, [open, data.race.raceId, data.prediction?.generatedAt, data.review?.isFinished, revision]);
  const entries = history?.entries ?? [];
  const first = entries[0], last = entries[entries.length - 1];
  const distinctOdds = first && last && first.oddsAt && last.oddsAt && Date.parse(first.oddsAt) < Date.parse(last.oddsAt);
  const changes = distinctOdds ? last.horses.flatMap(h => {
    const before = first.horses.find(x => x.number === h.number);
    return before?.odds && h.odds && before.odds !== h.odds ? [{ number: h.number, name: h.name, before: before.odds, after: h.odds }] : [];
  }) : [];
  return <section className="mb-5 rounded-2xl border border-slate-700 bg-[#0c192a] p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-bold text-white">自動保存・答え合わせ</h2><span className="rounded-full bg-cyan-300/10 px-3 py-1 text-xs font-semibold text-cyan-200">全レースをサーバーで記録</span></div>
    <p className="mt-2 text-xs leading-5 text-slate-400">画面を開かなくても定期取得で予想と結果を保存します。記録した発走前予想は残し、結果と照合します。</p>
    <details className="mt-4 border-t border-slate-700 pt-3" onToggle={e => setOpen(e.currentTarget.open)}><summary className="min-h-8 cursor-pointer text-sm font-semibold text-slate-200">全レースの成績と、このレースの保存履歴</summary>
      {error ? <div className="mt-3 text-xs text-amber-200" role="status">{error}<button type="button" onClick={() => setRevision(x => x + 1)} className="ml-2 min-h-11 underline">再読み込み</button></div> : !history ? <p className="mt-3 text-xs text-slate-400" role="status">サーバーの記録を読み込み中…</p> : <>
      <p className="mt-3 text-xs leading-5 text-slate-400">{data.race.raceId.length === 12 ? "地方競馬のみ" : "中央競馬のみ"}・自動記録を開始した後の照合済み {history.races} レース{history.fromDate ? `（${history.fromDate}〜${history.throughDate}）` : ""}を集計。同一レースは最後に記録した発走前予想を使用し、人気もその時点の順位です。</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">{history.summary.map(b => <div key={b.minPopularity} className="rounded-lg bg-black/15 p-3"><p className="text-sm font-semibold text-white">{b.minPopularity === 1 ? "全体" : `${b.minPopularity}番人気以下が来た場合`}</p><div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-400">{b.roles.map(r => <span key={r.target}>{r.target}着適性Top5 <strong className="text-cyan-200">{r.races ? `${r.hits}/${r.races}（${Math.round(r.hits / r.races * 100)}%）` : "未集計"}</strong></span>)}</div></div>)}</div>
      <p className="mt-2 text-[11px] leading-5 text-slate-500">人気別の分母は、その人気帯の馬が該当着順に入ったレース数です。分子は、その馬を同じ着順の適性Top5に含めた数です。取消で出走馬が変わったレース、上位同着、発走後の再計算は除外します。</p>
      <h3 className="mt-4 text-sm font-semibold text-white">このレースの記録（{entries.length}件）</h3>
      <div className="mt-2 max-h-60 space-y-2 overflow-y-auto">{entries.length ? [...entries].reverse().map(e => <p key={e.id} className="break-words text-xs leading-5 text-slate-400">{stamp(e.generatedAt)}・{e.title}・{e.finishers ? "結果照合済み" : "結果待ち"}</p>) : <p className="text-xs leading-5 text-slate-400">集計対象となる発走前予想はまだありません。記録開始前の予想は後から作成しません。</p>}</div>
      <div className="mt-3 rounded-lg border border-slate-700 p-3"><p className="text-sm font-semibold text-white">記録時点のオッズ比較</p>{distinctOdds ? <><p className="mt-1 text-xs text-slate-400">{stamp(first.oddsAt!)} → {stamp(last.oddsAt!)}</p>{changes.length ? changes.map(c => <p key={c.number} className="mt-1 break-words text-xs text-slate-300">{c.number} {c.name}：{c.before} → {c.after}倍</p>) : <p className="mt-2 text-xs text-slate-400">変化はありません。</p>}</> : <p className="mt-2 text-xs leading-5 text-slate-400">取得時刻の異なるオッズが蓄積されると比較できます。</p>}</div>
      </>}
    </details>
  </section>;
}

export function HorseNotebook({ horseId, name }: { horseId?: string; name: string }) {
  const cloud = useReinCloudData();
  const key = horseId && /^\d+$/.test(horseId) && Number(horseId) > 0 ? horseId : null;
  const saved = key ? cloud.notes[key] : undefined;
  const [note, setNote] = useState(""); const [watched, setWatched] = useState(false);
  useEffect(() => { setNote(saved?.note ?? "");setWatched(saved?.watched ?? false); }, [key, saved?.note, saved?.watched]);
  if (!key) return null;
  function save() { cloud.saveNote(key!, { name, note, watched }); }
  return <section className="mt-4 rounded-xl border border-slate-700 bg-black/10 p-4"><h3 className="font-bold text-white">注目馬・次走メモ</h3><label className="mt-3 flex min-h-11 items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={watched} onChange={e=>setWatched(e.target.checked)} />次走も注目する</label><textarea aria-label={`${name}の次走メモ`} maxLength={1200} value={note} onChange={e=>setNote(e.target.value)} placeholder="気になった点、次走で見直したい条件など" className="mt-2 min-h-24 w-full resize-y rounded-lg border border-slate-600 bg-[#071220] p-3 text-sm text-slate-200" /><button type="button" disabled={!cloud.ready || !cloud.userId} onClick={save} className="mt-2 min-h-11 rounded-lg border border-cyan-300/40 px-4 text-sm text-cyan-200">メモを保存</button><p className="mt-2 text-xs leading-5 text-slate-400" role="status">{cloud.status || "アカウントに保存し、別の端末にも同期します。通知機能はありません。"}</p></section>;
}
