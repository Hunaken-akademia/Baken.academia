import { createClient } from "@/lib/supabase/server";
import { isReinAdmin } from "@/lib/rein-admin";
import { GoogleSignInButton } from "@/app/login/google-sign-in-button";
import { MemberImportForm } from "./member-import-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "REIN 会員登録管理", robots: { index: false, follow: false } };

export default async function ReinMemberAdminPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const [supabase, params] = await Promise.all([createClient(), searchParams]);
  const { data, error } = await supabase.auth.getClaims();
  const claims = !error && typeof data?.claims?.sub === "string" ? data.claims : null;
  const email = typeof claims?.email === "string" ? claims.email : "";
  const allowed = Boolean(claims) && isReinAdmin(email);
  const missing = allowed ? [
    !(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY) && "会員登録用の設定",
    !process.env.RESEND_API_KEY && "メール送信用の設定",
  ].filter(Boolean) : [];

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-10 text-slate-100">
      <div className="mx-auto max-w-2xl">
        <a href="/" className="text-sm text-cyan-300 hover:text-cyan-200">← REINへ戻る</a>
        <section className="mt-5 rounded-3xl border border-slate-700 bg-[#0c192a] p-6 sm:p-8">
          <p className="text-xs font-semibold tracking-widest text-cyan-300">REIN 管理者専用</p>
          <h1 className="mt-2 text-2xl font-black">CAMPFIRE会員登録</h1>
          <p className="mt-3 leading-7 text-slate-300">CSVを選択し、メールアドレスとプランを確認して登録します。登録後、プラン別の完了メールを自動送信します。</p>
          {!claims ? (
            <div className="mt-6 space-y-4">
              <h2 className="font-bold">管理者Googleログイン</h2>
              <p className="text-sm leading-6 text-slate-400">管理者に設定したGoogleアカウントでログインしてください。ログイン後、この管理画面に戻ります。</p>
              {params.error ? <p role="alert" className="text-sm text-rose-300">ログインを完了できませんでした。もう一度お試しください。</p> : null}
              <GoogleSignInButton admin />
            </div>
          ) : (
            <>
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-black/20 p-3 text-sm">
                <span className="break-all text-slate-300">{email}</span>
                <form action="/auth/signout?next=/admin/members" method="post">
                  <button className="text-cyan-300 underline">別のアカウントでログイン</button>
                </form>
              </div>
              {allowed ? <>
                {missing.length ? <p role="alert" className="mt-4 rounded-xl bg-amber-400/10 p-4 text-sm text-amber-200">{missing.join("・")}が未完了です。設定後、もう一度この画面を開いてください。</p> : null}
                <MemberImportForm />
              </> : <p role="alert" className="mt-5 rounded-xl bg-rose-400/10 p-4 text-sm text-rose-200">このアカウントには管理者権限がありません。管理者に設定したGoogleアカウントに切り替えてください。</p>}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
