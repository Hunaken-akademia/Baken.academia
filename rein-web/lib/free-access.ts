// REIN 無料版のサーバー側の制限。ログイン無しのリクエストは「本日・無料公開場」のレースだけ通す。
import { NextRequest, NextResponse } from "next/server";
import { getCache } from "@vercel/functions";
import { dateJst } from "@/lib/server-snapshots";
import { freeLeagueOf, pickFreeVenue, venueHasRace } from "@/lib/free-day.mjs";
import { GET as jraSchedule } from "@/app/api/races/route";
import { GET as narSchedule } from "@/app/api/nar/races/route";

export type FreeLeague = "jra" | "nar";
type FreeRace = { raceId: string; number: number; title: string; start: string; course: string; status: string };
type FreeVenue = { eventId: string; name: string; nextRace: number; nextStart: string; races: FreeRace[] };
type Schedule = { dateLabel?: string; updatedAt?: string; venues?: FreeVenue[] };

export const freeHeaders = { "cache-control": "private, no-store" };
const chosen = getCache({ namespace: "rein-free-day-v1" });

async function todaySchedule(league: FreeLeague, origin: string): Promise<Schedule> {
  const url = new URL(league === "nar" ? "/api/nar/races" : "/api/races", origin);
  url.searchParams.set("day", "today");
  const response = await (league === "nar" ? narSchedule : jraSchedule)(new NextRequest(url));
  if (!response.ok) throw new Error(`schedule ${response.status}`);
  return await response.json() as Schedule;
}

// 本日の無料公開場。一度選んだ場はその日のうち変えない（開催一覧が後から増えても同じ場のまま）。
export async function freeVenueToday(league: FreeLeague, origin: string) {
  const date = dateJst();
  const schedule = await todaySchedule(league, origin);
  const venues = schedule.venues ?? [];
  const key = `${league}:${date}`;
  const saved = await chosen.get(key).catch(() => null);
  let venue = typeof saved === "string" ? venues.find((item) => item.eventId === saved) : undefined;
  if (!venue) {
    venue = (pickFreeVenue(venues, date, league) as FreeVenue | null) ?? undefined;
    if (venue) await chosen.set(key, venue.eventId, { ttl: 36 * 3600 }).catch(() => {});
  }
  return { date, schedule, venue: venue ?? null };
}

// raceId が本日の無料公開レースか確かめる。通らなければエラーの返答を返す。
export async function checkFreeRace(request: NextRequest): Promise<{ league: FreeLeague; raceId: string } | NextResponse> {
  const raceId = request.nextUrl.searchParams.get("raceId") ?? "";
  const league = freeLeagueOf(raceId) as FreeLeague | null;
  if (!league) return NextResponse.json({ error: "レースIDが不正です" }, { status: 400, headers: freeHeaders });
  try {
    const { venue } = await freeVenueToday(league, request.nextUrl.origin);
    if (!venueHasRace(venue, raceId)) {
      return NextResponse.json({ error: "無料版で見られるのは本日の無料公開場のレースだけです。ほかの場は会員版でご覧ください。", requiredPlan: league }, { status: 403, headers: freeHeaders });
    }
    return { league, raceId };
  } catch (error) {
    console.error("REIN free venue", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "本日の無料公開場を確認できませんでした。少し待って再読み込みしてください。" }, { status: 503, headers: freeHeaders });
  }
}

// 会員版の API と同じ処理を、確認済みの raceId だけを載せた新しいリクエストで呼ぶ（日付指定・明日・強制更新は付けない）。
export function memberRequest(request: NextRequest, path: string, raceId: string) {
  const url = new URL(path, request.nextUrl.origin);
  url.searchParams.set("raceId", raceId);
  return new NextRequest(url);
}
