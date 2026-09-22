import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { REIN_PLANS, type ReinMembership } from "@/lib/rein-access";

export const dynamic = "force-dynamic";

export default async function NarPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("rein_memberships")
    .select("member_key,google_email,plan,status,access_starts_at,access_ends_at,free_period_ends_at")
    .maybeSingle();
  const membership = data as ReinMembership | null;
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
