"use client";

import { useEffect, useState } from "react";
import { useReinCloudData } from "@/components/rein-cloud-provider";
import { addJournalEntry, attachJournalResult, JOURNAL_KEY, JOURNAL_LIMIT, journalSummary, makeJournalEntry, readJournal, type JournalEntry, type JournalInput } from "@/lib/prediction-journal";

const stamp = (value: string) => new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function PredictionJournal({ data }: { data: JournalInput }) {
  const cloud = useReinCloudData();
  const entries = cloud.entries;
  const message = cloud.status;
  useEffect(() => {
    if (!cloud.ready) return;
    const updated = attachJournalResult(entries, data);
    if (JSON.stringify(entries) !== JSON.stringify(updated)) cloud.saveEntries(updated);
  }, [cloud.ready, data]);
  const candidate = makeJournalEntry(data);
  const saved = candidate && entries.some(e => e.id === candidate.id);
  const current = entries.filter(e => e.raceId === data.race.raceId);
  const first = current[0], last = current[current.length-1];
  const distinctOdds = first && last && first.oddsAt && last.oddsAt && Date.parse(first.oddsAt) < Date.parse(last.oddsAt);
  const changes = distinctOdds ? last.horses.flatMap(h => {
    const before = first.horses.find(x => x.number === h.number);
    return before?.odds && h.odds && before.odds !== h.odds ? [{ number: h.number, name: h.name, before: before.odds, after: h.odds }] : [];
  }) : [];
  function save() {
    if (!candidate) return;
    const next = attachJournalResult(addJournalEntry(entries, candidate), data);
    cloud.saveEntries(next);
  }
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), entries }, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "rein-prediction-journal.json"; a.click(); URL.revokeObjectURL(url);
  }
  return <section className="mb-5 rounded-2xl border border-slate-700 bg-[#0c192a] p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-bold text-white">予想の記録・答え合わせ</h2><p className="mt-1 text-xs leading-5 text-slate-400">アカウントに最大{JOURNAL_LIMIT}件保存。端末を替えても同期し、予想は固定して結果だけ追記します。</p></div><button type="button" disabled={!candidate || !!saved || !cloud.ready || !cloud.userId} onClick={save} className="min-h-11 rounded-lg bg-cyan-300 px-4 py-2 text-sm font-bold text-slate-950 disabled:cursor-default disabled:bg-slate-700 disabled:text-slate-400">{saved ? "この予想は保存済み" : !cloud.ready ? "同期準備中…" : "この予想を保存"}</button></div>
    {!candidate && <p className="mt-2 text-xs leading-5 text-amber-200">発走前の時刻・適性が揃った予想だけを保存できます。発走後の再計算は実績に含めません。</p>}
    {message && <p className="mt-2 text-xs text-cyan-200" role="status">{message}</p>}
    <details className="mt-4 border-t border-slate-700 pt-3"><summary className="cursor-pointer text-sm font-semibold text-slate-200">保存履歴と人気薄の成績（{entries.length}件）</summary>
      <p className="mt-3 text-xs leading-5 text-slate-400">保存した予想のうち、結果ページを開いて照合できたレースだけを集計。同一レースは最後に保存した発走前予想を使用。人気は保存時点です。</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">{journalSummary(entries).map(b => <div key={b.minPopularity} className="rounded-lg bg-black/15 p-3"><p className="text-sm font-semibold text-white">{b.minPopularity === 1 ? "全体" : `${b.minPopularity}番人気以下が来たレース`}</p><div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-400">{b.roles.map(r => <span key={r.target}>{r.target}着適性Top5 <strong className="text-cyan-200">{r.races ? `${r.hits}/${r.races}（${Math.round(r.hits/r.races*100)}%）` : "未集計"}</strong></span>)}</div></div>)}</div>
      <div className="mt-3 max-h-60 space-y-2 overflow-y-auto">{[...entries].reverse().map(e => <p key={e.id} className="break-words text-xs leading-5 text-slate-400">{stamp(e.generatedAt)}保存・{e.title}・{e.finishers ? "結果照合済み" : "結果待ち"}</p>)}</div>
      <div className="mt-3 rounded-lg border border-slate-700 p-3"><p className="text-sm font-semibold text-white">保存した時点のオッズ比較</p>{distinctOdds ? <><p className="mt-1 text-xs text-slate-400">{stamp(first.oddsAt!)} → {stamp(last.oddsAt!)}</p>{changes.length ? changes.map(c => <p key={c.number} className="mt-1 break-words text-xs text-slate-300">{c.number} {c.name}：{c.before} → {c.after}倍</p>) : <p className="mt-2 text-xs text-slate-400">変化はありません。</p>}</> : <p className="mt-2 text-xs leading-5 text-slate-400">オッズの取得時刻が異なる予想を2回保存すると表示します。過去の朝オッズは補完しません。</p>}</div>
      <button type="button" disabled={!entries.length} onClick={download} className="mt-3 min-h-11 rounded-lg border border-slate-600 px-3 text-xs text-slate-200 disabled:opacity-40">記録をファイルに出力</button>
      <p className="mt-3 text-[11px] leading-5 text-slate-500">REIN全体の公式成績ではなく、このアカウントで保存・照合したレースの集計です。取消で出走馬が変わったレース・同着は除外します。</p>
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
  return <section className="mt-4 rounded-xl border border-slate-700 bg-black/10 p-4"><h3 className="font-bold text-white">注目馬・次走メモ</h3><label className="mt-3 flex min-h-11 items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={watched} onChange={e=>setWatched(e.target.checked)} />次走も注目する</label><textarea aria-label={`${name}の次走メモ`} maxLength={1200} value={note} onChange={e=>setNote(e.target.value)} placeholder="気になった点、次走で見直したい条件など" className="mt-2 min-h-24 w-full resize-y rounded-lg border border-slate-600 bg-[#071220] p-3 text-sm text-slate-200" /><button type="button" onClick={save} className="mt-2 min-h-11 rounded-lg border border-cyan-300/40 px-4 text-sm text-cyan-200">メモを保存</button><p className="mt-2 text-xs leading-5 text-slate-400" role="status">{cloud.status || "アカウントに保存し、別の端末にも同期します。通知機能はありません。"}</p></section>;
}
