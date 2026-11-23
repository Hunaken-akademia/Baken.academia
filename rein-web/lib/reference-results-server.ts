import { NextResponse } from "next/server";
import { getCache } from "@vercel/functions";
import { dateJst, serverData, storedSnapshot } from "./server-snapshots";
import { mapWithConcurrency } from "./rein-live";
import { venueOfRace } from "./odds-trend-board";
import { referenceResults, type ReferenceBoard, type ReferenceRace } from "./reference-results";
const cache = getCache({ namespace: "rein-reference-results-v1" });
const pending = new Map<string, Promise<ReferenceBoard>>();
async function build(league: "jra" | "nar"): Promise<ReferenceBoard> {
  const { snapshots } = await serverData<{ snapshots: Array<{ race_id: string; slot: string }> }>("metas", { date: dateJst() });
  const ids = [...new Set(snapshots.filter(s => s.slot === "live" && (s.race_id.length === 12) === (league === "nar")).map(s => s.race_id))];
  const races = await mapWithConcurrency(ids, 6, async (raceId): Promise<ReferenceRace | null> => {
    const live = (await storedSnapshot(raceId, "live")).snapshot?.payload;
    if (!live?.race) return null;
    const finished = live.review?.isFinished === true;
    const started = finished || typeof live.race.startsAt === "number" && Date.now() >= live.race.startsAt;
    const body = started ? (await storedSnapshot(raceId, "prestart")).snapshot?.payload : live;
    const time = Date.parse(body?.prediction?.generatedAt ?? "");
    const saved = !!body && body.race?.raceId === raceId && Number.isFinite(time) && typeof body.race?.startsAt === "number" && time < body.race.startsAt && body.prediction?.phase === "prestart" && body.evaluation?.tickets !== "held" && Array.isArray(body.tickets) && body.tickets.length > 0;
    return { raceId, title: live.race.title ?? "", venue: venueOfRace(raceId, league) ?? "", number: live.race.number ?? Number(raceId.slice(-2)), start: live.race.start ?? (typeof live.race.startsAt === "number" ? new Date(live.race.startsAt).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }) : "--:--"), startsAt: live.race.startsAt ?? null, saved, finished, lines: saved ? referenceResults(body.tickets, finished, live.review?.payouts ?? [], (live.scratched?.length ?? 0) > 0) : [] };
  });
  return { races: races.filter((r): r is ReferenceRace => !!r).sort((a,b) => (a.startsAt ?? Infinity)-(b.startsAt ?? Infinity) || a.raceId.localeCompare(b.raceId)) };
}
export async function referenceResultsResponse(league: "jra" | "nar") {
  try {
    const key = `${league}:${dateJst()}`;
    const saved = await cache.get(key).catch(() => null) as ReferenceBoard | null;
    if (saved) return NextResponse.json(saved, { headers: { "cache-control": "private, no-store" } });
    let job = pending.get(key);
    if (!job) { job = build(league).then(async board => { await cache.set(key, board, { ttl: 60 }).catch(() => {}); return board; }).finally(() => pending.delete(key)); pending.set(key, job); }
    return NextResponse.json(await job, { headers: { "cache-control": "private, no-store" } });
  } catch { return NextResponse.json({ error: "参考買い目の結果を取得できませんでした" }, { status: 503 }); }
}
