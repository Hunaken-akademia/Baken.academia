import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasActiveReinAccess } from "@/lib/rein-access";
import { cookies } from "next/headers";
import { ADMIN_MEMBERS_PATH, LOGIN_DESTINATION_COOKIE, loginDestination } from "@/lib/rein-auth-navigation.mjs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const cookieStore = await cookies();
  const next = loginDestination(url.searchParams.get("next"), cookieStore.get(LOGIN_DESTINATION_COOKIE)?.value);
  cookieStore.delete(LOGIN_DESTINATION_COOKIE);
  const loginPath = next === ADMIN_MEMBERS_PATH ? ADMIN_MEMBERS_PATH : "/login";

  if (!code) {
    return NextResponse.redirect(new URL(`${loginPath}?error=missing_code`, url.origin));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL(`${loginPath}?error=oauth`, url.origin));
  }

  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims?.sub) {
    return NextResponse.redirect(new URL(`${loginPath}?error=session`, url.origin));
  }

  // This page validates REIN_ADMIN_EMAILS, independently of paid membership.
  if (next === ADMIN_MEMBERS_PATH) {
    const response = NextResponse.redirect(new URL(ADMIN_MEMBERS_PATH, url.origin));
    response.headers.set("cache-control", "private, no-store");
    return response;
  }

  const { data: membership } = await supabase
    .from("rein_memberships")
    .select("member_key,google_email,plan,status,access_starts_at,access_ends_at,free_period_ends_at")
    .maybeSingle();

  const destination = hasActiveReinAccess(membership) ? next : "/access";
  const response = NextResponse.redirect(new URL(destination, url.origin));
  response.headers.set("cache-control", "private, no-store");
  return response;
}
