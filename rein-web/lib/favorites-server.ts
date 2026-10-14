import { NextRequest, NextResponse } from "next/server";
import { getCache } from "@vercel/functions";
import { createClient } from "./supabase/server";
import { dateJst, serverData } from "./server-snapshots";
import { FAVORITE_JOCKEY_LIMIT, cleanJockeyName, favoriteMatches, validJockeyKey, type EntryRace, type FavoriteJockey, type League } from "./favorites";

const entriesCache = getCache({ namespace: "rein-favorite-entries-v1" });
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } });

async function account() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === "string" ? data.claims.sub : "";
  return error || !userId ? null : { supabase, userId };
}

async function favorites(supabase: Awaited<ReturnType<typeof createClient>>, userId: string, league: League) {
  const [jockeys, horses] = await Promise.all([
    supabase.from("rein_favorite_jockeys").select("jockey_key,name").eq("user_id", userId).like("jockey_key", `${league}:%`).order("created_at"),
    supabase.from("rein_horse_notes").select("horse_id,note_data").eq("user_id", userId),
  ]);
  if (jockeys.error || horses.error) throw new Error("Favorites could not be read");
  return {
    jockeys: (jockeys.data ?? []).map((row) => ({ key: row.jockey_key, name: row.name }) satisfies FavoriteJockey),
    horses: (horses.data ?? []).filter((row) => (row.note_data as { watched?: unknown })?.watched === true).map((row) => ({ horseId: row.horse_id, name: typeof (row.note_data as { name?: unknown })?.name === "string" ? (row.note_data as { name: string }).name : "" })),
  };
}

async function entries(league: League, date: string) {
  const key = `${league}:${date}`;
  const cached = await entriesCache.get(key).catch(() => null);
  if (cached && typeof cached === "object") return cached as EntryRace[];
  const { races } = await serverData<{ races: EntryRace[] }>("entries", { league, date });
  await entriesCache.set(key, races, { ttl: 300 }).catch(() => {});
  return races;
}

export async function favoritesGet(request: NextRequest, league: League) {
  const user = await account();
  if (!user) return json({ error: "ログインしてください" }, 401);
  const day = request.nextUrl.searchParams.get("day");
  try {
    const saved = await favorites(user.supabase, user.userId, league);
    if (day !== "today" && day !== "tomorrow") return json(saved);
    const date = dateJst(day === "tomorrow" ? 1 : 0);
    const matches = saved.jockeys.length || saved.horses.length
      ? favoriteMatches(league, await entries(league, date), saved.horses.map((horse) => horse.horseId), saved.jockeys.map((jockey) => jockey.key))
      : [];
    return json({ ...saved, date, matches });
  } catch {
    return json({ error: "お気に入りを読み込めませんでした" }, 503);
  }
}

export async function favoritesPost(request: NextRequest, league: League) {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) return json({ error: "許可されていない送信元です" }, 403);
  const user = await account();
  if (!user) return json({ error: "ログインしてください" }, 401);
  let body: { action?: unknown; key?: unknown; name?: unknown };
  try { body = await request.json(); } catch { return json({ error: "不正なJSONです" }, 400); }
  const key = body?.key, name = cleanJockeyName(body?.name);
  if (!validJockeyKey(key) || !key.startsWith(`${league}:`) || (body.action !== "add" && body.action !== "remove") || (body.action === "add" && !name)) return json({ error: "騎手の指定が正しくありません" }, 400);
  try {
    if (body.action === "add") {
      const { count, error } = await user.supabase.from("rein_favorite_jockeys").select("jockey_key", { count: "exact", head: true }).eq("user_id", user.userId);
      if (error) throw error;
      if ((count ?? 0) >= FAVORITE_JOCKEY_LIMIT) return json({ error: `お気に入り騎手は${FAVORITE_JOCKEY_LIMIT}人までです` }, 400);
      const insert = await user.supabase.from("rein_favorite_jockeys").upsert({ user_id: user.userId, jockey_key: key, name }, { onConflict: "user_id,jockey_key", ignoreDuplicates: true });
      if (insert.error) throw insert.error;
    } else {
      const removal = await user.supabase.from("rein_favorite_jockeys").delete().eq("user_id", user.userId).eq("jockey_key", key);
      if (removal.error) throw removal.error;
    }
    return json(await favorites(user.supabase, user.userId, league));
  } catch {
    return json({ error: "お気に入り騎手を保存できませんでした" }, 500);
  }
}
