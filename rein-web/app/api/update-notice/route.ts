import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { UPDATE_NOTICE } from "@/lib/update-notice";

export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } });

export async function GET() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === "string" ? data.claims.sub : "";
  if (error || !userId) return json({ error: "ログインしてください" }, 401);
  const result = await supabase.from("rein_notice_acknowledgements").select("notice_id").eq("user_id", userId).eq("notice_id", UPDATE_NOTICE.id).maybeSingle();
  if (result.error) return json({ error: "お知らせの確認状況を取得できませんでした" }, 500);
  return json({ userId, noticeId: UPDATE_NOTICE.id, acknowledged: !!result.data });
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if ((origin && origin !== request.nextUrl.origin) || request.headers.get("sec-fetch-site") === "cross-site") return json({ error: "許可されていない送信元です" }, 403);
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === "string" ? data.claims.sub : "";
  if (error || !userId) return json({ error: "ログインしてください" }, 401);
  const text = await request.text();
  if (text.length > 1024) return json({ error: "送信データが大きすぎます" }, 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return json({ error: "不正なJSONです" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || (body as { noticeId?: unknown }).noticeId !== UPDATE_NOTICE.id) return json({ error: "お知らせが見つかりません" }, 400);
  // The owner comes exclusively from the verified session. Repeated clicks are idempotent.
  const result = await supabase.from("rein_notice_acknowledgements").upsert({ user_id: userId, notice_id: UPDATE_NOTICE.id }, { onConflict: "user_id,notice_id", ignoreDuplicates: true });
  if (result.error) return json({ error: "確認記録を保存できませんでした。もう一度お試しください。" }, 500);
  return json({ userId, noticeId: UPDATE_NOTICE.id, acknowledged: true });
}
