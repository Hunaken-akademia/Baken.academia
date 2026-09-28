import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isReinAdmin } from "@/lib/rein-admin";
import { MemberImportForm } from "./member-import-form";

export const dynamic = "force-dynamic";

export default async function ReinMemberAdminPage() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || typeof claims?.sub !== "string") redirect("/login");
  if (!isReinAdmin(typeof claims.email === "string" ? claims.email : "")) notFound();

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-10 text-slate-100">
      <div className="mx-auto max-w-2xl">
        <a href="/" className="text-sm text-cyan-300 hover:text-cyan-200">← REINへ戻る</a>
        <section className="mt-5 rounded-3xl border border-slate-700 bg-[#0c192a] p-6 sm:p-8">
          <p className="text-xs font-semibold tracking-widest text-cyan-300">ADMINISTRATION</p>
          <h1 className="mt-2 text-2xl font-black">Campfire会員一覧の取込</h1>
          <p className="mt-3 leading-7 text-slate-300">
            Campfireからダウンロードした会員一覧CSVを確認し、REINの利用プランと会員状態へ反映します。
            CSVファイル自体は保存しません。
          </p>
          <MemberImportForm />
        </section>
      </div>
    </main>
  );
}
