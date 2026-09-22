import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { canAccessReinArea, hasActiveReinAccess, type ReinArea } from "@/lib/rein-access";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";

function authError(
  request: NextRequest,
  status: 401 | 403,
  message: string,
  requiredArea?: ReinArea,
) {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({
      error: message,
      requiredPlan: requiredArea ?? null,
    }, {
      status,
      headers: { "cache-control": "private, no-store" },
    });
  }

  const url = request.nextUrl.clone();
  url.pathname = status === 401 ? "/login" : "/access";
  url.search = requiredArea ? `?required=${requiredArea}` : "";
  return NextResponse.redirect(url);
}

function requiredAreaForPath(pathname: string): ReinArea | null {
  if (
    pathname === "/jra" ||
    pathname.startsWith("/jra/") ||
    pathname === "/api/races" ||
    pathname.startsWith("/api/races/") ||
    pathname === "/api/analyze" ||
    pathname.startsWith("/api/analyze/")
  ) return "jra";

  if (
    pathname === "/nar" ||
    pathname.startsWith("/nar/") ||
    pathname === "/api/nar" ||
    pathname.startsWith("/api/nar/")
  ) return "nar";

  return null;
}

export async function updateSessionAndAuthorize(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
          Object.entries(headers).forEach(([key, value]) => {
            response.headers.set(key, value);
          });
        },
      },
    },
  );

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  if (claimsError || !claimsData?.claims?.sub) {
    return authError(request, 401, "Googleログインが必要です");
  }

  const { data: membership, error: membershipError } = await supabase
    .from("rein_memberships")
    .select("member_key,google_email,plan,status,access_starts_at,access_ends_at,free_period_ends_at")
    .maybeSingle();

  if (membershipError || !hasActiveReinAccess(membership)) {
    return authError(request, 403, "REINの利用権を確認できません");
  }

  const requiredArea = requiredAreaForPath(request.nextUrl.pathname);
  if (requiredArea && !canAccessReinArea(membership, requiredArea)) {
    return authError(
      request,
      403,
      requiredArea === "jra"
        ? "中央競馬プランの利用権が必要です"
        : "地方競馬プランの利用権が必要です",
      requiredArea,
    );
  }

  response.headers.set("cache-control", "private, no-store");
  return response;
}
