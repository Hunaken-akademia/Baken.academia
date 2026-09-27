"use client";

import { useEffect, useState } from "react";
import { isSnapshotFresh, metaFromBody } from "@/lib/analysis-cache";

type StatusData = {
  race: { startsAt?: number | null; dataTimes?: { odds?: string | null; card?: string | null } };
  prediction?: { phase: string; source: string; generatedAt: string };
  horses: Array<{ historySamples?: number }>;
  review?: { isFinished: boolean };
  model?: { dateTo?: string };
};
const timestamp = (value?: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "未取得";

export function PredictionDataStatus({ data }: { data: StatusData }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { setNow(Date.now()); const timer=setInterval(()=>setNow(Date.now()),60_000);return ()=>clearInterval(timer); }, []);
  const meta=metaFromBody(data, data.prediction?.phase === "preview");
  const stale=now !== null && meta && !isSnapshotFresh(meta, now);
  const frozen=data.prediction?.source === "prestart";
  const unknown=data.horses.filter(h=>h.historySamples === undefined).length;
  const zero=data.horses.filter(h=>h.historySamples === 0).length;
  const few=data.horses.filter(h=>h.historySamples !== undefined && h.historySamples > 0 && h.historySamples < 5).length;
  return <div className="mt-3 border-t border-slate-700 pt-3 text-xs leading-5 text-slate-400">
    <p className={stale ? "font-semibold text-amber-200" : "text-cyan-200"}>{frozen ? "発走前の保存予想" : stale ? "予想の取得から時間が経っています" : meta ? "予想時点を確認できます" : "予想時刻を確認できません"}</p>
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1"><dt>予想作成</dt><dd className="min-w-0 break-words">{timestamp(data.prediction?.generatedAt)}</dd><dt>オッズ取得</dt><dd className="min-w-0 break-words">{timestamp(data.race.dataTimes?.odds || data.race.dataTimes?.card)}</dd><dt>履歴収録</dt><dd className="min-w-0 break-words">{data.model?.dateTo || "未取得"}まで</dd></dl>
    <p className="mt-2">履歴なし {zero}頭・1〜4走 {few}頭{unknown ? `・履歴数不明 ${unknown}頭` : ""}</p>
    <p className="mt-1 text-[11px] text-slate-500">時刻は日本時間。履歴の少なさは参考表示で、信頼度の確率ではありません。</p>
  </div>;
}
