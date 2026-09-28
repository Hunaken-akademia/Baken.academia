import { createHash } from "node:crypto";
import { createPreviewToken, verifyPreviewToken } from "@/lib/campfire-preview.mjs";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SUPABASE_URL } from "@/lib/supabase/config";
import { CampfireCsvError, parseCampfireMembers, prepareCampfireImport } from "@/lib/campfire-members.mjs";
import { isReinAdmin } from "@/lib/rein-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } });

export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin) {
    return json({ error: "不正なリクエストです。" }, 403);
  }

  const auth = await createClient();
  const { data: claimsData, error: claimsError } = await auth.auth.getClaims();
  const claims = claimsData?.claims;
  if (claimsError || typeof claims?.sub !== "string") return json({ error: "ログインしてください。" }, 401);
  const email = typeof claims.email === "string" ? claims.email : "";
  if (!isReinAdmin(email)) return json({ error: "管理者権限がありません。" }, 403);

  if (Number(request.headers.get("content-length") || 0) > MAX_CSV_BYTES + 65536)
    return json({ error: "2MB以下のCSVファイルを選択してください。" }, 413);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "CSVファイルを読み取れませんでした。" }, 400);
  }
  const file = form.get("file");
  const mode = form.get("mode");
  if (!(file instanceof File) || !file.size || file.size > MAX_CSV_BYTES) {
    return json({ error: "2MB以下のCSVファイルを選択してください。" }, 413);
  }
  if (mode !== "preview" && mode !== "apply") return json({ error: "操作を判定できません。" }, 400);

  let parsed;
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    parsed = parseCampfireMembers(bytes);
  } catch (error) {
    if (error instanceof CampfireCsvError) {
      return json({ error: error.message, issues: error.issues }, 400);
    }
    return json({ error: "CSVを解析できませんでした。" }, 400);
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!serviceKey) {
    return json({ error: "管理用Supabaseキーが未設定です。Vercel環境変数を確認してください。" }, 503);
  }

  const admin = createSupabaseAdminClient(SUPABASE_URL, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  try {
    if (parsed.members.length === 0) {
      const { error } = await admin.from("rein_plan_catalog").select("plan").limit(1);
      if (error) return json({ error: "Supabaseの管理用キーを確認できません。反映していません。" }, 503);
      return json({ mode, total: 0, counts: parsed.counts, protectedMembers: 0, deadlines: [], imported: 0 });
    }
    const existing = new Map<string, Record<string, unknown>>();
    for (let offset = 0; offset < parsed.members.length; offset += 100) {
      const batch = parsed.members.slice(offset, offset + 100);
      const columns = "member_key,google_email,normalized_email,status,access_starts_at,access_ends_at,updated_at";
      const results = await Promise.all([
        admin.from("rein_memberships").select(columns).in("member_key", batch.map(m => m.member_key)),
        admin.from("rein_memberships").select(columns).in("normalized_email", batch.map(m => m.google_email)),
      ]);
      for (const result of results) {
        if (result.error) return json({ error: "既存の会員情報を確認できません。反映していません。" }, 503);
        for (const row of result.data || []) existing.set(row.member_key, row);
      }
    }
    const prepared = prepareCampfireImport(parsed.members, [...existing.values()]);
    const snapshot = JSON.stringify([createHash("sha256").update(bytes).digest("hex"), prepared]);
    const summary = { mode, total: parsed.members.length, counts: parsed.counts,
      protectedMembers: prepared.protectedMembers, deadlines: prepared.deadlines };
    if (mode === "preview") return json({ ...summary,
      previewToken: createPreviewToken(serviceKey, claims.sub, snapshot) });
    if (!verifyPreviewToken(form.get("previewToken"), serviceKey, claims.sub, snapshot))
      return json({ error: "内容確認の期限切れ、または会員情報が変わりました。もう一度「内容を確認」を実行してください。" }, 409);
    const importedAt = new Date().toISOString();
    const records = prepared.records.map(member => ({ ...member, last_imported_at: importedAt, updated_at: importedAt }));
    if (records.length) {
      const { error } = await admin.from("rein_memberships").upsert(records, { onConflict: "member_key" });
      if (error) return json({ error: "会員情報を反映できませんでした。重複やDB設定を確認してください。" }, 500);
    }
    return json({ ...summary, imported: records.length });
  } catch (error) {
    if (error instanceof CampfireCsvError) return json({ error: error.message, issues: error.issues }, 400);
    return json({ error: "会員情報の処理に失敗しました。再度内容を確認してください。" }, 500);
  }
}
