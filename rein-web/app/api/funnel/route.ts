// REIN の入口の計測（lib/funnel.mjs）。数えるのに失敗しても、移動と画面表示は止めない。
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_URL } from "@/lib/supabase/config";
import { bumpFunnel, handleFunnel } from "@/lib/funnel.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
  const result = await handleFunnel(
    {
      search: request.nextUrl.search,
      cookieSrc: request.cookies.get("rein_src")?.value || null,
      referer: request.headers.get("referer"),
      ownHost: request.nextUrl.hostname,
    },
    { bump: (row: { event: string; src: string; detail: string }) => (key ? bumpFunnel(row, { url: SUPABASE_URL, key }) : Promise.resolve(false)) },
  );
  const headers = { "cache-control": "no-store" };
  if (result.status === 302 && result.location) return NextResponse.redirect(result.location, { status: 302, headers });
  return new NextResponse(null, { status: 204, headers });
}
