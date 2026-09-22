import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hasActiveReinAccess, REIN_PLANS, type ReinMembership } from "@/lib/rein-access";

export const dynamic = "force-dynamic";

export default async function ReinHome() {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims?.sub) redirect("/login");

  const { data } = await supabase
    .from("rein_memberships")
    .select("member_key,google_email,plan,status,access_starts_at,access_ends_at,free_period_ends_at")
    .maybeSingle();

  const membership = data as ReinMembership | null;
  if (!hasActiveReinAccess(membership)) redirect("/access");

  if (membership!.plan === "jra") redirect("/jra");
  if (membership!.plan === "nar") redirect("/nar");

  const plan = REIN_PLANS[membership!.plan];

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-4xl">
        <header className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-xl bg-cyan-400 text-xl font-black text-[#07111f]">R</div>
            <div>
              <p className="text-lg font-black tracking-[.12em]">REIN</p>
              <p className="text-xs text-slate-400">馬券アカデミア</p>
            </div>
          </div>
          <div className="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-3 py-1.5 text-xs font-semibold text-cyan-300">
            {plan.name}
          </div>
        </header>

        <section className="mb-6 rounded-3xl border border-slate-700 bg-gradient-to-br from-[#10233a] to-[#0b1727] p-6 sm:p-8">
          <p className="text-sm font-semibold text-cyan-300">REIN ALL PLAN</p>
          <h1 className="mt-2 text-3xl font-black">競馬種別を選択</h1>
          <p className="mt-3 text-sm text-slate-400">オールプランでは中央競馬・地方競馬の両方を利用できます。</p>
        </section>

        <div className="grid gap-4 sm:grid-cols-2">
          <Link href="/jra" className="group rounded-3xl border border-slate-700 bg-[#0c192a] p-6 transition hover:-translate-y-0.5 hover:border-cyan-400/60">
            <p className="text-xs font-semibold tracking-widest text-cyan-300">JRA</p>
            <h2 className="mt-2 text-2xl font-black">中央競馬</h2>
            <p className="mt-3 text-sm leading-6 text-slate-400">REINの全頭評価・着順適性・買い目を中央競馬で利用します。</p>
            <p className="mt-6 font-semibold text-cyan-300">中央競馬を開く →</p>
          </Link>

          <Link href="/nar" className="group rounded-3xl border border-slate-700 bg-[#0c192a] p-6 transition hover:-translate-y-0.5 hover:border-amber-400/60">
            <p className="text-xs font-semibold tracking-widest text-amber-300">NAR</p>
            <h2 className="mt-2 text-2xl font-black">地方競馬</h2>
            <p className="mt-3 text-sm leading-6 text-slate-400">地方競馬向けのREIN予想・着順適性・買い目を利用します。</p>
            <p className="mt-6 font-semibold text-amber-300">地方競馬を開く →</p>
          </Link>
        </div>

        <form action="/auth/signout" method="post" className="mt-8 text-center">
          <button className="text-sm text-slate-500 underline underline-offset-4 hover:text-slate-300">ログアウト</button>
        </form>
      </div>
    </main>
  );
}
