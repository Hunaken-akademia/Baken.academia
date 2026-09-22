import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasActiveReinAccess } from "@/lib/rein-access";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const requestedNext = url.searchParams.get("next") || "/";
  const next = requestedNext.startsWith("/") && !requestedNext.startsWith("//")
    ? requestedNext
    : "/";

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing_code", url.origin));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL("/login?error=oauth", url.origin));
  }

  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims?.sub) {
    return NextResponse.redirect(new URL("/login?error=session", url.origin));
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
