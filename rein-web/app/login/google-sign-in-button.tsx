"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function GoogleSignInButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function signIn() {
    setLoading(true);
    setError("");
    const supabase = createClient();
    const redirectTo = `${window.location.origin}/auth/callback`;
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        queryParams: {
          prompt: "select_account",
        },
      },
    });

    if (oauthError) {
      setError("Googleログインを開始できませんでした。時間をおいて再度お試しください。");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={signIn}
        disabled={loading}
        className="flex w-full items-center justify-center gap-3 rounded-xl bg-white px-4 py-3.5 font-bold text-slate-900 transition hover:bg-slate-100 disabled:cursor-wait disabled:opacity-60"
      >
        <span className="grid size-7 place-items-center rounded-full border border-slate-200 text-sm font-black text-blue-600">
          G
        </span>
        {loading ? "Googleへ移動中…" : "Googleアカウントでログイン"}
      </button>
      {error ? <p className="text-sm text-rose-300">{error}</p> : null}
    </div>
  );
}
