"use client";

import { useState } from "react";

type ImportResult = {
  mode?: "preview" | "apply";
  total?: number;
  imported?: number;
  counts?: { nar: number; jra: number; all: number; active: number; paused: number; cancelled: number };
  error?: string;
  issues?: string[];
};

const planNames = { nar: "地方", jra: "中央", all: "オール" } as const;

export function MemberImportForm() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(mode: "preview" | "apply") {
    if (!file) {
      setResult({ error: "先にCampfireのCSVファイルを選択してください。" });
      return;
    }
    if (mode === "apply" && !window.confirm("解析した会員情報をREINに反映します。続けますか？")) return;

    setBusy(true);
    setResult(null);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("mode", mode);
      const response = await fetch("/api/admin/members/import", { method: "POST", body, cache: "no-store" });
      const data = (await response.json()) as ImportResult;
      setResult(data);
    } catch {
      setResult({ error: "通信に失敗しました。時間をおいて再度お試しください。" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6">
      <label className="block text-sm font-semibold text-slate-200" htmlFor="campfire-csv">会員一覧CSV</label>
      <input
        id="campfire-csv"
        type="file"
        accept=".csv,text/csv,text/plain"
        disabled={busy}
        onChange={(event) => { setFile(event.target.files?.[0] ?? null); setResult(null); }}
        className="mt-2 block w-full rounded-xl border border-slate-700 bg-black/20 p-3 text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-cyan-400 file:px-3 file:py-2 file:font-bold file:text-slate-950"
      />

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <button type="button" disabled={busy || !file} onClick={() => submit("preview")} className="rounded-xl border border-slate-600 px-4 py-3 font-semibold hover:bg-white/5 disabled:opacity-50">
          {busy ? "処理中…" : "内容を確認"}
        </button>
        <button type="button" disabled={busy || !file} onClick={() => submit("apply")} className="rounded-xl bg-cyan-400 px-4 py-3 font-bold text-slate-950 hover:bg-cyan-300 disabled:opacity-50">
          会員情報を反映
        </button>
      </div>

      <div className="mt-5 rounded-2xl border border-amber-400/20 bg-amber-400/[.06] p-4 text-sm leading-6 text-amber-100/90">
        <p className="font-bold">プランと反映内容</p>
        <p className="mt-1">地方競馬1,000円、中央競馬1,000円、オール1,500円の3プランを判定します。</p>
        <p>CSVに載っている会員だけを追加・更新します。CSVにない会員の権利は変更しません。退会者は状態列に「退会」「解約」などがある場合に停止します。</p>
      </div>

      {result?.error ? (
        <div role="alert" className="mt-4 rounded-xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-200">
          <p>{result.error}</p>
          {result.issues?.length ? <ul className="mt-2 list-disc space-y-1 pl-5">{result.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul> : null}
        </div>
      ) : null}

      {result?.counts ? (
        <div role="status" className="mt-4 rounded-xl border border-emerald-400/25 bg-emerald-400/[.06] p-4 text-sm">
          <p className="font-bold text-emerald-200">
            {result.mode === "apply" ? `${result.imported}人分を反映しました。` : `${result.total}人分を読み取りました。`}
          </p>
          <p className="mt-2 text-slate-300">
            {Object.entries(planNames).map(([plan, name]) => `${name} ${result.counts?.[plan as keyof typeof planNames] ?? 0}人`).join(" ／ ")}
          </p>
          <p className="mt-1 text-slate-400">
            有効 {result.counts.active}人 ／ 一時停止 {result.counts.paused}人 ／ 退会・解約 {result.counts.cancelled}人
          </p>
        </div>
      ) : null}
    </div>
  );
}
