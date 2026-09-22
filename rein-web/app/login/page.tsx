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

          <p className="text-sm font-semibold text-cyan-300">CAMPFIRE MEMBERS ONLY</p>
          <h1 className="mt-2 text-2xl font-black">Googleログイン</h1>
          <p className="mt-3 text-sm leading-6 text-slate-400">
            CAMPFIRE登録時に申請したGoogleアドレスと、同じGoogleアカウントでログインしてください。
          </p>

          <div className="my-6 rounded-2xl border border-cyan-400/20 bg-cyan-400/[.06] p-4 text-sm">
            <p className="font-bold text-cyan-200">2026年10月1日 公開予定</p>
            <p className="mt-1 text-slate-300">10月は1か月無料期間として運用予定です。</p>
          </div>

          {oauthError ? (
            <p className="mb-4 rounded-xl border border-rose-400/20 bg-rose-400/10 p-3 text-sm text-rose-200">
              {oauthError}
            </p>
          ) : null}

          <GoogleSignInButton />

          <p className="mt-5 text-xs leading-5 text-slate-500">
            ログイン後、GoogleアドレスとCAMPFIRE会員情報を照合して利用権を確認します。
          </p>
        </section>
      </div>
    </main>
  );
}
