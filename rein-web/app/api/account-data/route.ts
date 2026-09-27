import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { readJournal, JOURNAL_LIMIT, type JournalEntry } from "@/lib/prediction-journal";
import type { HorseNote } from "@/lib/account-data";

export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } });

async function readAccountData(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const [predictionResult, noteResult] = await Promise.all([
    supabase.from("rein_saved_predictions").select("entry_id,prediction,result,saved_at").eq("user_id", userId).order("saved_at", { ascending: false }).limit(JOURNAL_LIMIT),
    supabase.from("rein_horse_notes").select("horse_id,note_data,updated_at").eq("user_id", userId),
  ]);
  if (predictionResult.error || noteResult.error) throw new Error("Account data could not be read");
  const entries = (predictionResult.data ?? []).map(row => ({ ...(row.prediction as JournalEntry), ...(row.result ? { finishers: row.result } : {}) }));
  const validEntries = readJournal(JSON.stringify(entries)).sort((a,b) => a.generatedAt.localeCompare(b.generatedAt));
  const notes: Record<string, HorseNote> = {};
  for (const row of noteResult.data ?? []) {
    const note = row.note_data as Partial<HorseNote>;
    if (/^\d{1,16}$/.test(row.horse_id) && typeof note?.note === "string" && typeof note.watched === "boolean") notes[row.horse_id] = { name: typeof note.name === "string" ? note.name : "", note: note.note, watched: note.watched, updatedAt: row.updated_at };
  }
  return { userId, entries: validEntries, notes };
}

export async function GET() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === "string" ? data.claims.sub : "";
  if (error || !userId) return json({ error: "ログインしてください" }, 401);
  try { return json(await readAccountData(supabase, userId)); }
  catch { return json({ error: "保存データを取得できませんでした" }, 500); }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === "string" ? data.claims.sub : "";
  if (error || !userId) return json({ error: "ログインしてください" }, 401);
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 1_000_000) return json({ error: "保存データが大きすぎます" }, 413);
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "不正なJSONです" }, 400); }
  if (!body || typeof body !== "object" || !Array.isArray((body as { entries?: unknown }).entries) || !Array.isArray((body as { notes?: unknown }).notes)) return json({ error: "保存データの形式が正しくありません" }, 400);
  const incoming = body as { entries: unknown[]; notes: unknown[] };
  if (incoming.entries.length > JOURNAL_LIMIT || incoming.notes.length > 500) return json({ error: "保存件数が上限を超えています" }, 400);
  const parsedEntries = readJournal(JSON.stringify(incoming.entries.map(item => item && typeof item === "object" ? (item as { prediction?: unknown }).prediction : null)));
  if (parsedEntries.length !== incoming.entries.length) return json({ error: "予想データが正しくありません" }, 400);
  const entryItems = incoming.entries as Array<{ prediction: JournalEntry; result?: unknown }>;
  const rpcEntries = entryItems.map(item => {
    const result = item.result == null ? null : readJournal(JSON.stringify([{ ...item.prediction, finishers: item.result }]))[0]?.finishers ?? null;
    return { prediction: item.prediction, result };
  });
  const notesByHorse = new Map<string, { user_id: string; horse_id: string; note_data: HorseNote }>();
  for (const item of incoming.notes) {
    if (!item || typeof item !== "object") return json({ error: "馬メモの形式が正しくありません" }, 400);
    const note = item as Partial<HorseNote> & { horseId?: unknown };
    if (typeof note.horseId !== "string" || !/^\d{1,16}$/.test(note.horseId) || typeof note.name !== "string" || note.name.length > 100 || typeof note.note !== "string" || note.note.length > 1200 || typeof note.watched !== "boolean") return json({ error: "馬メモの形式が正しくありません" }, 400);
    notesByHorse.set(note.horseId, { user_id: userId, horse_id: note.horseId, note_data: { name: note.name, note: note.note, watched: note.watched, updatedAt: typeof note.updatedAt === "string" ? note.updatedAt : new Date().toISOString() } });
  }
  const { error: predictionError } = await supabase.rpc("rein_sync_saved_predictions", { p_entries: rpcEntries });
  if (predictionError) return json({ error: "予想をサーバーに保存できませんでした" }, 500);
  if (notesByHorse.size) {
    const { error: noteError } = await supabase.from("rein_horse_notes").upsert([...notesByHorse.values()], { onConflict: "user_id,horse_id" });
    if (noteError) return json({ error: "馬メモをサーバーに保存できませんでした" }, 500);
  }
  try { return json(await readAccountData(supabase, userId)); }
  catch { return json({ error: "保存後データを取得できませんでした" }, 500); }
}
