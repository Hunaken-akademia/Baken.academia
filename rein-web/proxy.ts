import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { updateSessionAndAuthorize } from "@/lib/supabase/proxy";
import { protectApiRequest } from "@/lib/api-budget";

export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith('/api/')) {
    const blocked = await protectApiRequest(request);
    if (blocked) return blocked;
    // Internal routes and public calendars retain their existing route-level
    // authorization. Expanding rate-limit coverage must not require member cookies
    // on signed cron/OIDC requests.
    if (!/^\/api\/(?:races|analyze|account-data|update-notice|race-history|nar)(?:\/|$)/.test(request.nextUrl.pathname)) {
      return NextResponse.next();
    }
  }
  return updateSessionAndAuthorize(request);
}

export const config = {
  matcher: [
    "/api/:path*",
    "/",
    "/dictionary/:path*",
    "/jra/:path*",
    "/nar/:path*",
    "/api/races/:path*",
    "/api/analyze/:path*",
    "/api/account-data/:path*",
    "/api/update-notice/:path*",
    "/api/race-history/:path*",
    "/api/nar/:path*",
  ],
};
