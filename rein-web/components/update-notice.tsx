"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { UPDATE_NOTICE } from "@/lib/update-notice";

type Receipt = { userId: string; noticeId: string; acknowledged: boolean };
function receipt(value: unknown): Receipt {
  const result = value as Receipt;
  if (!result || typeof result.userId !== "string" || !result.userId || result.noticeId !== UPDATE_NOTICE.id || typeof result.acknowledged !== "boolean") throw new Error("Invalid notice receipt");
  return result;
}

export function UpdateNotice() {
  const [data, setData] = useState<Receipt | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const saveInFlight = useRef(false);
  const load = useCallback(async () => {
    const run = ++generation.current;
    try {
      const response = await fetch("/api/update-notice", { cache: "no-store" });
      if (!response.ok) throw new Error("Notice load failed");
      const result = receipt(await response.json());
      if (run === generation.current) { setData(result); setError(""); }
    } catch {
      if (run === generation.current) setError("お知らせの確認状況を読み込めませんでした。");
    }
  }, []);
  useEffect(() => {
    void load();
    const { data: auth } = createClient().auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT" || event === "SIGNED_IN") { ++generation.current; setData(null); setError(""); setSaving(false); void load(); }
    });
    const refresh = () => { if (!saveInFlight.current) void load(); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => { ++generation.current; auth.subscription.unsubscribe(); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [load]);

  async function acknowledge() {
    if (!data || saveInFlight.current) return;
    const run = ++generation.current;
    const owner = data.userId;
    saveInFlight.current = true; setSaving(true); setError("");
    try {
      const response = await fetch("/api/update-notice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ noticeId: UPDATE_NOTICE.id }), cache: "no-store" });
      if (!response.ok) throw new Error("Notice save failed");
      const result = receipt(await response.json());
      if (result.userId !== owner || !result.acknowledged) throw new Error("Account changed");
      if (run === generation.current) setData(result);
    } catch {
      if (run === generation.current) setError("確認記録を保存できませんでした。通信を確認して、もう一度押してください。");
    } finally { saveInFlight.current = false; if (run === generation.current) setSaving(false); }
  }

  if (data?.acknowledged || (!data && !error)) return null;
  if (!data) return <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-900/40 px-3 py-1.5 text-xs text-slate-400"><p role="alert" className="min-w-0">{error}</p><button type="button" onClick={() => void load()} className="min-h-9 shrink-0 rounded-md px-2 font-semibold text-cyan-200 underline">再読み込み</button></div>;
  return (
    <section aria-labelledby="rein-update-title" className="mb-5 rounded-2xl border border-cyan-400/30 bg-cyan-400/5 p-4 sm:p-5">
      <p className="mb-2 text-xs font-bold text-cyan-300">アップデートのお知らせ · {UPDATE_NOTICE.date}</p>
      <h2 id="rein-update-title" className="text-base font-bold sm:text-lg">{UPDATE_NOTICE.title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-slate-200">{UPDATE_NOTICE.summary}</p>
      <details className="mt-3 text-sm text-slate-300">
        <summary className="cursor-pointer py-1 font-semibold text-cyan-200">{UPDATE_NOTICE.detailsLabel}</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">{UPDATE_NOTICE.patterns.map(pattern => <li key={pattern}>{pattern}</li>)}</ul>
        <p className="mt-3 leading-relaxed">{UPDATE_NOTICE.detailsNote}</p>
      </details>
      <p className="mt-3 text-xs leading-relaxed text-slate-400">{UPDATE_NOTICE.caution}</p>
      {error && <p role="alert" className="mt-3 text-sm text-rose-300">{error}</p>}
      <button type="button" disabled={saving} onClick={() => void acknowledge()} className="mt-4 min-h-11 w-full rounded-xl bg-cyan-300 px-5 py-2.5 text-sm font-bold text-slate-950 hover:bg-cyan-200 disabled:opacity-60 sm:w-auto">{saving ? "保存中…" : "確認しました"}</button>
    </section>
  );
}
