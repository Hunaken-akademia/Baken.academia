import { NextResponse } from "next/server";
import { getCache } from "@vercel/functions";
import { dateJst,serverData } from "./server-snapshots";
import { getOddsTrends } from "./odds-trends-server";
import { mapWithConcurrency } from "./rein-live";
import { TREND_VERSION } from "./odds-trends";
import { needsLookup,scheduledBoardRaces,type BoardRace,type OddsTrendBoard } from "./odds-trend-board";

type Venue = { races?: Array<{ number?: number; start?: string; raceId?: string; title?: string; course?: string }> };
const cache = getCache({ namespace: "rein-odds-trend-board-v1" });
const pending = new Map<string,Promise<OddsTrendBoard>>();
const headers = { "cache-control": "private, no-store" };

async function build(league:"jra"|"nar",date:string):Promise<OddsTrendBoard> {
  const { schedule } = await serverData<{ schedule: { payload: { venues?: Venue[] } } | null }>("schedule",{ date,league });
  const now = Date.now();
  const scheduled = scheduledBoardRaces(date,league,(schedule?.payload.venues ?? []).flatMap(venue => venue.races ?? []));
  // Races far from post time cannot have tickets yet; reuse the per-race lookup (and its cache) for the rest.
  const races = await mapWithConcurrency(scheduled,3,async ({ startsAt,rules,...race }):Promise<BoardRace> => {
    if (!needsLookup(startsAt,now)) return { ...race,phase:"scheduled",items:rules.map(rule => ({ ruleId:rule.id,state:"waiting",selections:[],fetchedAt:null,note:"発走75分前から照合します" })) };
    const data = await getOddsTrends(race.raceId,league).catch(() => null);
    return data ? { ...race,phase:data.phase,items:data.items } : { ...race,phase:"unavailable",items:[] };
  });
  return { date,league,version:TREND_VERSION,generatedAt:new Date(now).toISOString(),races,...(schedule ? {} : { error:"開催情報を準備中です" }) };
}
export async function getOddsTrendBoard(league:"jra"|"nar") {
  const date = dateJst(), key = `${TREND_VERSION}:${league}:${date}`;
  const saved = await cache.get(key).catch(() => null) as OddsTrendBoard | null;
  if (saved?.races) return saved;
  let job = pending.get(key);
  if (!job) {
    job = build(league,date).then(async board => { await cache.set(key,board,{ ttl:60 }).catch(() => {}); return board; }).finally(() => pending.delete(key));
    pending.set(key,job);
  }
  return job;
}
export async function oddsTrendBoardResponse(league:"jra"|"nar") {
  try { return NextResponse.json(await getOddsTrendBoard(league),{ headers }); }
  catch { return NextResponse.json({ error:"条件該当レースを取得できませんでした" },{ status:503,headers }); }
}
