import type { NextRequest } from "next/server";
import { updateSessionAndAuthorize } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSessionAndAuthorize(request);
}

export const config = {
  matcher: [
    "/",
    "/api/races/:path*",
    "/api/analyze/:path*",
  ],
};
