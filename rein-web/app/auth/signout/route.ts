import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const next = new URL(request.url).searchParams.get("next") === "/admin/members" ? "/admin/members" : "/login";
  const response = NextResponse.redirect(new URL(next, request.url), 303);
  response.headers.set("cache-control", "private, no-store");
  return response;
}
