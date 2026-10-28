import { NextResponse } from "next/server";
import { getCache } from "@vercel/functions";
import { dateJst, serverData, storedSnapshot } from "./server-snapshots";
import { mapWithConcurrency } from "./rein-live";
import { venueOfRace } from "./odds-trend-board";
import { finderRow, type FinderRow, type League, type RaceFinder } from "./race-finder";

// Reads the cron-refreshed live snapshots; no source site is fetched here.
const cache = getCache({ namespace: "rein-race-finder-v1" });
const pending = new Map<string, Promise<RaceFinder>>();
const headers = { "cache-control": "private, no-store" };

async function build(league: League, date: string): Promise<RaceFinder> {
  const { snapshots } = await serverData<{ snapshots: Array<{ race_id: string; slot: string; generated_at: string }> }>("metas", { date });
  const live = snapshots.filter(s => s.slot === "live" && (s.race_id.length === 12) === (league === "nar"));
  const rows = await mapWithConcurrency(live, 6, async (meta): Promise<FinderRow | null> => {
    // A snapshot only changes when the cron or a viewer refreshes it, so rows are reused per version.
    const key = `row:${meta.race_id}:${meta.generated_at}`;
    const saved = await cache.get(key).catch(() => null) as FinderRow | null;
    if (saved?.raceId) return saved;
    const payload = (await storedSnapshot(meta.race_id, "live").catch(() => ({ snapshot: null }))).snapshot?.payload;
    if (!payload?.race || payload.race.raceId !== meta.race_id) return null;
    const row = finderRow(meta.race_id, league, venueOfRace(meta.race_id, league) ?? "", payload);
    await cache.set(key, row, { ttl: 86_400 }).catch(() => {});
    return row;
  });
  return {
    date, league, generatedAt: new Date().toISOString(),
    rows: rows.filter((row): row is FinderRow => !!row).sort((a, b) => (a.startsAt ?? Infinity) - (b.startsAt ?? Infinity) || a.raceId.localeCompare(b.raceId)),
  };
}

export async function getRaceFinder(league: League) {
  const date = dateJst(), key = `day:${league}:${date}`;
  const saved = await cache.get(key).catch(() => null) as RaceFinder | null;
  if (saved?.rows) return saved;
  let job = pending.get(key);
  if (!job) {
    job = build(league, date).then(async finder => { await cache.set(key, finder, { ttl: 60 }).catch(() => {}); return finder; }).finally(() => pending.delete(key));
    pending.set(key, job);
  }
  return job;
}

export async function raceFinderResponse(league: League) {
  try { return NextResponse.json(await getRaceFinder(league), { headers }); }
  catch { return NextResponse.json({ error: "レースの区分を取得できませんでした" }, { status: 503, headers }); }
}
