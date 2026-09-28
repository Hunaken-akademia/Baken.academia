import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SUPABASE_URL } from "@/lib/supabase/config";
import { CampfireCsvError, parseCampfireMembers } from "@/lib/campfire-members.mjs";
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
  try {
    parsed = parseCampfireMembers(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    if (error instanceof CampfireCsvError) {
      return json({ error: error.message, issues: error.issues }, 400);
    }
    return json({ error: "CSVを解析できませんでした。" }, 400);
  }

  if (mode === "preview") {
    return json({ mode, total: parsed.members.length, counts: parsed.counts });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!serviceKey) {
    return json({ error: "管理用Supabaseキーが未設定です。Vercel環境変数を確認してください。" }, 503);
  }

  const admin = createSupabaseAdminClient(SUPABASE_URL, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const importedAt = new Date().toISOString();
  const records = parsed.members.map((member) => ({
    ...member,
    last_imported_at: importedAt,
    updated_at: importedAt,
  }));
  const { error } = await admin
    .from("rein_memberships")
    .upsert(records, { onConflict: "normalized_email" });

  if (error) {
    return json({ error: "会員情報を反映できませんでした。列の重複やDB設定を確認してください。" }, 500);
  }

  return json({ mode, imported: records.length, counts: parsed.counts });
}
