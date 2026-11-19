// BOOKERS の合言葉を毎月1日（日本時間）に作り直し、会員限定記事を書き換える。
// 毎時動くが、今月の合言葉があり記事にも反映済みなら何もしない（失敗しても次の時間にやり直す）。
import { NextResponse, type NextRequest } from "next/server";
import { hasBearerSecret } from "@/lib/internal-auth";
import { SUPABASE_URL } from "@/lib/supabase/config";
import { createServiceDb, ensureMonthlyCodes } from "@/lib/bookers-access.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!hasBearerSecret(request.headers.get("authorization"), process.env.CRON_SECRET || "")) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!key) return NextResponse.json({ ok: false, error: "service key missing" }, { status: 503 });
  try {
    const result = await ensureMonthlyCodes({ db: createServiceDb({ url: SUPABASE_URL, key }) });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("rein bookers codes cron", error);
    return NextResponse.json({ ok: false, error: String((error as Error)?.message || error).slice(0, 200) }, { status: 500 });
  }
}
