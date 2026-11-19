"use client";

import { useState } from "react";

type Result = { ok: boolean; error?: string; status?: string; planLabel?: string };

export function BookersCodeForm() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/bookers/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = (await response.json().catch(() => ({ ok: false }))) as Result;
      if (!response.ok || !data.ok) {
        setMessage({ ok: false, text: data.error || "合言葉の確認に失敗しました。時間をおいてもう一度お試しください。" });
        return;
      }
      setMessage({
        ok: true,
        text: data.status === "already"
          ? "すでに利用権があります。REINを開きます。"
          : `${data.planLabel ?? "REIN"}の利用を開始しました。REINを開きます。`,
      });
      window.location.assign("/");
    } catch {
      setMessage({ ok: false, text: "通信に失敗しました。もう一度お試しください。" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 rounded-2xl border border-cyan-400/25 bg-cyan-400/[.05] p-4">
      <p className="font-bold text-cyan-200">BOOKERSでご加入の方</p>
      <p className="mt-1 text-sm leading-6 text-slate-300">
        BOOKERSの会員限定記事に載っている今月の合言葉を入れてください。合言葉は毎月1日に新しくなります。
      </p>
      <label htmlFor="bookers-code" className="sr-only">合言葉</label>
      <input
        id="bookers-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="例：ABCD-EFGH"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={32}
        className="mt-3 w-full rounded-xl border border-slate-600 bg-black/20 px-4 py-3 text-center font-mono text-lg tracking-[.2em] text-slate-100 placeholder:text-slate-600 focus:border-cyan-400 focus:outline-none"
      />
      <button
        disabled={busy || !code.trim()}
        className="mt-3 w-full rounded-xl bg-cyan-400 px-4 py-3 font-bold text-[#07111f] transition hover:bg-cyan-300 disabled:opacity-50"
      >
        {busy ? "確認中…" : "合言葉で利用開始"}
      </button>
      {message ? (
        <p className={`mt-3 text-sm ${message.ok ? "text-emerald-300" : "text-rose-300"}`} role="status">{message.text}</p>
      ) : null}
    </form>
  );
}
