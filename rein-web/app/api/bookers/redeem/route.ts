// BOOKERS 会員が REIN で合言葉を入れて利用権を受け取る。Googleログイン必須（会員でなくても呼べる）。
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SUPABASE_URL } from "@/lib/supabase/config";
import { createServiceDb, redeemCode } from "@/lib/bookers-access.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } });

export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin) return json({ ok: false, error: "不正なリクエストです。" }, 403);

  const auth = await createClient();
  const { data: claimsData, error: claimsError } = await auth.auth.getClaims();
  const claims = claimsData?.claims;
  if (claimsError || typeof claims?.sub !== "string" || typeof claims.email !== "string") {
    return json({ ok: false, error: "Googleでログインしてください。" }, 401);
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!key) return json({ ok: false, error: "合言葉の確認に失敗しました。時間をおいてもう一度お試しください。" }, 503);

  let code = "";
  try {
    const body = await request.json();
    code = typeof body?.code === "string" ? body.code.slice(0, 64) : "";
  } catch {
    return json({ ok: false, error: "合言葉を入力してください。" }, 400);
  }

  try {
    const result = await redeemCode(
      { user: { id: claims.sub, email: claims.email }, code },
      { db: createServiceDb({ url: SUPABASE_URL, key }) },
    );
    if (result.status === "limited") return json({ ok: false, error: "続けて間違えたため、1時間ほどあけてもう一度お試しください。" }, 429);
    if (result.status === "invalid") return json({ ok: false, error: "合言葉が違うか、期限が切れています。BOOKERSの会員限定記事で今月の合言葉をご確認ください。" }, 400);
    return json({ ok: true, ...result });
  } catch (error) {
    console.error("bookers redeem error", error);
    return json({ ok: false, error: "合言葉の確認に失敗しました。時間をおいてもう一度お試しください。" }, 500);
  }
}
