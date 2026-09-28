import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { REIN_PLANS, type ReinMembership } from "@/lib/rein-access";
import { serverData } from "@/lib/server-snapshots";

export const dynamic = "force-dynamic";

type NarAnalysisReport = {
  coverage: { chunks: number; date_from: string; date_to: string; races: number; runners: number; racecourses: number };
  market_baseline: { pop1_win_rate?: number; pop1_top3_rate?: number; top3_contains_winner_rate?: number; top3_two_or_more_placed_rate?: number; top3_all_placed_rate?: number };
};
type NarAnalysisSnapshot = { report: NarAnalysisReport; updated_at: string };
const percent = (value?: number) => typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "—";


export default async function NarPage() {
  const supabase = await createClient();
  const [membershipResult, analysisResult] = await Promise.all([
    supabase
      .from("rein_memberships")
      .select("member_key,google_email,plan,status,access_starts_at,access_ends_at,free_period_ends_at")
      .maybeSingle(),
    serverData<{ analysis: NarAnalysisSnapshot | null }>("nar-analysis").catch(() => ({ analysis: null })),
  ]);
  const membership = membershipResult.data as ReinMembership | null;
  const analysis = analysisResult.analysis;
  const plan = membership ? REIN_PLANS[membership.plan] : REIN_PLANS.nar;

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-4xl">
        <header className="mb-8 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-xl bg-amber-300 text-xl font-black text-[#07111f]">R</div>
            <div>
              <p className="text-lg font-black tracking-[.12em]">REIN</p>
              <p className="text-xs text-slate-400">地方競馬</p>
            </div>
          </Link>
          <div className="rounded-full border border-amber-300/25 bg-amber-300/10 px-3 py-1.5 text-xs font-semibold text-amber-200">
            {plan.name}
          </div>
        </header>

        <section className="rounded-3xl border border-slate-700 bg-gradient-to-br from-[#251d10] to-[#0b1727] p-6 sm:p-8">
          <p className="text-sm font-semibold tracking-widest text-amber-300">NAR</p>
          <h1 className="mt-2 text-3xl font-black">地方競馬 REIN</h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-300">
            地方競馬版は、現在取得中の8年分データ・全券種最終オッズ・払戻を接続する土台まで完成しています。
            10月1日の公開に向けて、中央競馬版と同じ全頭評価・着順適性・買い目UIへ接続します。
          </p>

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {["全頭評価","1〜3着適性","買い目生成"].map((label) => (
              <div key={label} className="rounded-2xl border border-amber-300/15 bg-black/15 p-4">
                <p className="text-xs text-slate-500">公開機能</p>
                <p className="mt-1 font-bold text-amber-200">{label}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-5 rounded-3xl border border-slate-700 bg-[#0b1727] p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold tracking-widest text-amber-300">取得済みデータ</p>
              <h2 className="mt-2 text-xl font-black">地方競馬の暫定分析</h2>
            </div>
            <span className="rounded-full border border-amber-300/25 bg-amber-300/10 px-3 py-1.5 text-xs font-semibold text-amber-200">
              取得済み範囲
            </span>
          </div>
          {analysis ? (
            <>
              <p className="mt-3 text-sm text-slate-300">
                {analysis.report.coverage.date_from}〜{analysis.report.coverage.date_to}・{analysis.report.coverage.chunks.toLocaleString("ja-JP")}チャンク
                <span className="mx-2 text-slate-600">/</span>
                {analysis.report.coverage.races.toLocaleString("ja-JP")}レース
                <span className="mx-2 text-slate-600">/</span>
                {analysis.report.coverage.runners.toLocaleString("ja-JP")}頭分
              </p>
              <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {[
                  ["1番人気の勝率", percent(analysis.report.market_baseline.pop1_win_rate)],
                  ["1番人気の3着内率", percent(analysis.report.market_baseline.pop1_top3_rate)],
                  ["人気上位3頭に勝ち馬が含まれる率", percent(analysis.report.market_baseline.top3_contains_winner_rate)],
                  ["上位3頭から2頭以上が3着内", percent(analysis.report.market_baseline.top3_two_or_more_placed_rate)],
                  ["上位3頭が全て3着内", percent(analysis.report.market_baseline.top3_all_placed_rate)],
                  ["競馬場数", analysis.report.coverage.racecourses.toLocaleString("ja-JP")],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-2xl border border-slate-700 bg-black/15 p-4">
                    <p className="text-xs text-slate-400">{label}</p>
                    <p className="mt-2 text-lg font-bold text-slate-100">{value}</p>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs leading-6 text-slate-400">
                取得・分析が完了したチャンクだけの集計です。バックフィルの進行に合わせて更新します。予想モデルへの適用とは分けて表示しています。
              </p>
              <p className="mt-1 text-xs text-slate-500">
                最終更新：{new Date(analysis.updated_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
              </p>
            </>
          ) : (
            <p className="mt-3 text-sm leading-7 text-slate-300">
              取得済みデータの初回分析を待っています。分析が完了すると、対象期間と成績をここに表示します。
            </p>
          )}
        </section>

        <div className="mt-5 flex flex-wrap gap-3">
          {membership?.plan === "all" ? (
            <Link href="/jra" className="rounded-xl border border-slate-600 px-4 py-2.5 text-sm font-semibold hover:bg-white/5">
              中央競馬へ
            </Link>
          ) : null}
          <form action="/auth/signout" method="post">
            <button className="rounded-xl border border-slate-700 px-4 py-2.5 text-sm text-slate-400 hover:bg-white/5">
              ログアウト
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
