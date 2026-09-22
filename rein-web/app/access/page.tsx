import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hasActiveReinAccess, type ReinMembership } from "@/lib/rein-access";

export const dynamic = "force-dynamic";

function messageFor(membership: ReinMembership | null, now: Date) {
  if (!membership) {
    return {
      title: "CAMPFIRE会員情報を確認できません",
      body: "CAMPFIREで登録したGoogleアドレスと、現在ログインしているGoogleアカウントが一致しているか確認してください。",
    };
  }
  if (membership.status === "cancelled") {
    return {
      title: "利用期間が終了しています",
      body: "CAMPFIREの会員状態をご確認ください。再加入後は登録情報の反映後に利用できます。",
    };
  }
  if (membership.status === "paused") {
    return {
      title: "利用権を一時停止しています",
      body: "会員情報の確認中です。登録内容が反映されるまでお待ちください。",
    };
  }
  const starts = new Date(membership.access_starts_at);
  if (now < starts) {
    return {
      title: "REINは10月1日公開予定です",
      body: "Google認証と会員照合は完了しています。公開日時以降、このアカウントでそのまま利用できます。",
    };
  }
  if (membership.access_ends_at && now >= new Date(membership.access_ends_at)) {
    return {
      title: "利用期間が終了しています",
      body: "CAMPFIREの会員状態をご確認ください。",
    };
  }
  return {
    title: "利用権を確認中です",
    body: "CAMPFIRE側の登録情報とGoogleアカウントの照合をご確認ください。",
  };
}

export default async function AccessPage() {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const claims = claimsData?.claims;

  if (!claims?.sub) redirect("/login");

  const { data: membership } = await supabase
    .from("rein_memberships")
    .select("member_key,google_email,plan,status,access_starts_at,access_ends_at,free_period_ends_at")
    .maybeSingle();

  const now = new Date();
  if (hasActiveReinAccess(membership, now)) redirect("/");

  const message = messageFor(membership, now);
  const email = typeof claims.email === "string" ? claims.email : "Googleアカウント";

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-10 text-slate-100">
      <div className="mx-auto flex min-h-[80vh] max-w-lg items-center">
        <section className="w-full rounded-3xl border border-slate-700 bg-[#0c192a] p-6 sm:p-8">
          <div className="mb-6 flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-xl bg-cyan-400 text-xl font-black text-[#07111f]">R</div>
            <div>
              <p className="font-black tracking-[.12em]">REIN</p>
              <p className="text-xs text-slate-500">会員認証</p>
            </div>
          </div>

          <p className="text-xs font-semibold text-cyan-300">SIGNED IN</p>
          <p className="mt-1 break-all text-sm text-slate-400">{email}</p>

          <h1 className="mt-6 text-2xl font-black">{message.title}</h1>
          <p className="mt-3 leading-7 text-slate-300">{message.body}</p>

          <div className="mt-6 rounded-2xl border border-slate-700 bg-black/15 p-4 text-sm text-slate-400">
            <p>公開予定：2026年10月1日</p>
            <p className="mt-1">CAMPFIRE特典：初月無料（参加した最初の月の参加費が無料）</p>
          </div>

          <form action="/auth/signout" method="post" className="mt-6">
            <button className="w-full rounded-xl border border-slate-600 px-4 py-3 font-semibold text-slate-200 transition hover:bg-white/5">
              別のGoogleアカウントでログイン
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
