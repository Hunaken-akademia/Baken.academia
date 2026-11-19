import { redirect } from "next/navigation";
import { GoogleSignInButton } from "./google-sign-in-button";
import { createClient } from "@/lib/supabase/server";
import { hasActiveReinAccess } from "@/lib/rein-access";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();

  if (claimsData?.claims?.sub) {
    const { data: membership } = await supabase
      .from("rein_memberships")
      .select("member_key,google_email,plan,status,access_starts_at,access_ends_at,free_period_ends_at")
      .maybeSingle();
    redirect(hasActiveReinAccess(membership) ? "/" : "/access");
  }

  const oauthError = params.error
    ? "ログイン処理を完了できませんでした。もう一度お試しください。"
    : "";

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-10 text-slate-100">
      <div className="mx-auto flex min-h-[80vh] max-w-md items-center">
        <section className="w-full rounded-3xl border border-slate-700 bg-gradient-to-br from-[#10233a] to-[#0b1727] p-6 shadow-2xl sm:p-8">
          <div className="mb-7 flex items-center gap-3">
            <div className="grid size-12 place-items-center rounded-2xl bg-cyan-400 text-2xl font-black text-[#07111f]">R</div>
            <div>
              <p className="text-xl font-black tracking-[.14em]">REIN</p>
              <p className="text-xs text-slate-400">馬券アカデミア</p>
            </div>
          </div>

          <p className="text-sm font-semibold text-cyan-300">MEMBERS ONLY</p>
          <h1 className="mt-2 text-2xl font-black">Googleログイン</h1>
          <p className="mt-3 text-sm leading-6 text-slate-400">
            Googleでログインしてください。BOOKERSでご加入の方は、ログイン後に会員限定記事の合言葉を入れると使えるようになります。
          </p>

          <div className="my-6 rounded-2xl border border-cyan-400/20 bg-cyan-400/[.06] p-4 text-sm">
            <p className="font-bold text-cyan-200">中央・地方とも会員向け公開中</p>
          </div>

          <p className="mb-2 text-xs text-slate-400">BOOKERSで加入する（プランを押すと加入ページが開きます）</p>
          <div className="mb-6 grid gap-2 text-sm">
            <a href="https://bookers.tech/magazine/9aee480f-e4f7-4d14-b4b5-8ae381512a8f/" target="_blank" rel="noreferrer" className="flex items-center justify-between transition hover:bg-white/5 rounded-xl border border-slate-700 bg-black/10 px-4 py-3">
              <span className="font-semibold">地方競馬</span><span className="text-amber-300">月額 800円</span>
            </a>
            <a href="https://bookers.tech/magazine/4d1af8db-e934-46fe-b22c-9cfdbeee18b5/" target="_blank" rel="noreferrer" className="flex items-center justify-between transition hover:bg-white/5 rounded-xl border border-slate-700 bg-black/10 px-4 py-3">
              <span className="font-semibold">中央競馬</span><span className="text-cyan-300">月額 800円</span>
            </a>
            <a href="https://bookers.tech/magazine/c9b4b8a8-f00f-4097-8cf4-334ec5ba62bd/" target="_blank" rel="noreferrer" className="flex items-center justify-between transition hover:bg-white/5 rounded-xl border border-cyan-400/25 bg-cyan-400/[.05] px-4 py-3">
              <span className="font-semibold">地方＋中央</span><span className="font-bold text-cyan-200">月額 1,000円</span>
            </a>
          </div>

          {oauthError ? (
            <p className="mb-4 rounded-xl border border-rose-400/20 bg-rose-400/10 p-3 text-sm text-rose-200">
              {oauthError}
            </p>
          ) : null}

          <GoogleSignInButton />

          <a href="/free" className="mt-4 flex min-h-11 items-center justify-center rounded-xl border border-cyan-300/30 text-sm font-bold text-cyan-200 hover:bg-cyan-300/10">
            まずは無料版を見る（ログイン不要・毎日1場）
          </a>

          <p className="mt-5 text-xs leading-5 text-slate-500">
            CAMPFIREでご加入の方は、登録時に申請したGoogleアドレスと同じアカウントでログインしてください。
          </p>
        </section>
      </div>
    </main>
  );
}
