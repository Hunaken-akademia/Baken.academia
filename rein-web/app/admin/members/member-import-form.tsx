"use client";

import { useState } from "react";

type ImportResult = {
  mode?: "preview" | "apply";
  rows?: { rowNumber: number; memberKey: string; name: string | null; email: string;
    plan: "nar" | "jra" | "all"; status: string; action: "new" | "update" | "protected";
    accessEndsAt: string | null; emailStatus: "pending" | "sending" | "sent" | "failed" | "not_applicable" }[];
  total?: number;
  imported?: number;
  emailSent?: number;
  emailFailed?: number;
  emailSkipped?: number;
  counts?: { nar: number; jra: number; all: number; active: number; cancelled: number };
  previewToken?: string;
  protectedMembers?: number;
  deadlines?: { at: string; count: number }[];
  error?: string;
  issues?: string[];
};

const planNames = { nar: "地方競馬", jra: "中央競馬", all: "オール（地方＋中央）" } as const;
const actionNames = { new: "新規登録", update: "登録済み・更新", protected: "手動登録済み・変更なし" } as const;
const mailNames = { pending: "登録後に送信", sending: "送信処理中", sent: "送信済み（再送しません）", failed: "未送信・再試行対象", not_applicable: "送信対象外" } as const;

export function MemberImportForm() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);

  async function submit(mode: "preview" | "apply") {
    if (!file) {
      setResult({ error: "先にCampfireのCSVファイルを選択してください。" });
      return;
    }
    if (mode === "apply" && !result?.previewToken) return;
    const previewToken = result?.previewToken;

    setBusy(mode);
    setResult(null);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("mode", mode);
      if (previewToken) body.set("previewToken", previewToken);
      const response = await fetch("/api/admin/members/import", { method: "POST", body, cache: "no-store" });
      const data = (await response.json()) as ImportResult;
      setResult(response.ok ? data : { error: data.error || "処理に失敗しました。もう一度内容を確認してください。", issues: data.issues });
    } catch {
      setResult({ error: "通信に失敗しました。時間をおいて再度お試しください。" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-6">
      <label className="block text-sm font-semibold text-slate-200" htmlFor="campfire-csv">1. CAMPFIRE会員CSVを選択</label>
      <input
        id="campfire-csv"
        type="file"
        accept=".csv,text/csv,text/plain"
        disabled={Boolean(busy)}
        onChange={(event) => { setFile(event.target.files?.[0] ?? null); setResult(null); }}
        className="mt-2 block w-full rounded-xl border border-slate-700 bg-black/20 p-3 text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-cyan-400 file:px-3 file:py-2 file:font-bold file:text-slate-950"
      />

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <button type="button" disabled={Boolean(busy) || !file} onClick={() => submit("preview")} className="rounded-xl border border-slate-600 px-4 py-3 font-semibold hover:bg-white/5 disabled:opacity-50">
          {busy === "preview" ? "確認中…" : "2. 内容を確認"}
        </button>
        <button type="button" disabled={Boolean(busy) || !file || !result?.previewToken} onClick={() => submit("apply")} className="rounded-xl bg-cyan-400 px-4 py-3 font-bold text-slate-950 hover:bg-cyan-300 disabled:opacity-50">
          {busy === "apply" ? "登録・メール送信中…" : "3. 登録してメール送信"}
        </button>
      </div>

      <p className="mt-3 text-sm leading-6 text-slate-400">備考欄のメールアドレスに、プラン別の利用範囲・REINのリンク・オープンチャットの案内を送ります。同じCSVを取り込んでも、送信済みメールは再送しません。</p>
      {busy === "apply" ? <p role="status" className="mt-3 text-sm text-cyan-200">登録とメール送信が完了するまで、この画面を開いたままお待ちください。</p> : null}
      <div className="mt-5 rounded-2xl border border-amber-400/20 bg-amber-400/[.06] p-4 text-sm leading-6 text-amber-100/90">
        <p className="font-bold">プランと反映内容</p>
        <p className="mt-1">地方競馬1,000円、中央競馬1,000円、オール1,500円の3プランを判定します。</p>
        <p>CSVに載っている会員だけを追加・更新します。CSVにない会員の権利は変更しません。退会・解約・停止は最終決済月の翌月1日0:00（日本時間）に利用終了となります。期限を判定できない行がある場合は反映しません。</p>
      </div>

      {result?.error ? (
        <div role="alert" className="mt-4 rounded-xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-200">
          <p>{result.error}</p>
          {result.issues?.length ? <ul className="mt-2 list-disc space-y-1 pl-5">{result.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul> : null}
        </div>
      ) : null}

      {result?.rows?.length ? (
        <section className="mt-5" aria-label="登録内容とメール送信状況">
          <h2 className="font-bold">{result.mode === "apply" ? "登録結果" : "メールアドレスとプランを確認してください"}</h2>
          <div className="mt-3 max-h-[32rem] space-y-3 overflow-y-auto">
            {result.rows.map(row => (
              <article key={row.rowNumber} className="rounded-xl border border-slate-700 bg-black/15 p-4 text-sm">
                <p className="font-bold">{row.rowNumber}行目　{row.name || "名前なし"}</p>
                <p className="mt-1 break-all text-cyan-200">{row.email}</p>
                <p className="mt-1">{planNames[row.plan]} ／ {row.status === "active" ? "有効" : "退会・停止予定"}</p>
                <p className="mt-1 text-slate-400">{actionNames[row.action]}</p>
                <p className={`mt-2 ${row.emailStatus === "failed" ? "text-amber-200" : "text-slate-300"}`}>登録完了メール：{mailNames[row.emailStatus]}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {result?.counts ? (
        <div role="status" className="mt-4 rounded-xl border border-emerald-400/25 bg-emerald-400/[.06] p-4 text-sm">
          <p className="font-bold text-emerald-200">
            {result.mode === "apply" ? `${result.imported}人分を反映しました。` : `${result.total}人分を読み取りました。`}
          </p>
          {result.mode === "apply" ? <p className="mt-1 text-slate-300">登録完了メール：{result.emailSent ?? 0}件送信 ／ {result.emailFailed ?? 0}件失敗{(result.emailSkipped ?? 0) > 0 ? ` ／ ${result.emailSkipped}件送信済み・処理中` : ""}</p> : null}
          {result.mode === "apply" && (result.emailFailed ?? 0) > 0 ? <p className="mt-1 text-amber-200">登録は完了しています。メール失敗分は「内容を確認」→「登録してメール送信」で再試行できます。</p> : null}
          <p className="mt-2 text-slate-300">
            {Object.entries(planNames).map(([plan, name]) => `${name} ${result.counts?.[plan as keyof typeof planNames] ?? 0}人`).join(" ／ ")}
          </p>
          {result.total === 0 ? <p className="mt-2 text-slate-300">会員はまだいません。反映操作は不要です。</p> : null}
          <p className="mt-1 text-slate-400">
            継続 {result.counts.active}人 ／ 退会・停止予定（期限後停止を含む） {result.counts.cancelled}人
          </p>
          <p className="mt-2">手動登録の保護対象：{result.protectedMembers ?? 0}人（更新対象外）</p>
          {result.deadlines?.map(item => <p key={item.at} className="mt-1">
            利用終了：{new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short", hourCycle: "h23" }).format(new Date(item.at))} 日本時間 ／ {item.count}人
          </p>)}
        </div>
      ) : null}
    </div>
  );
}
