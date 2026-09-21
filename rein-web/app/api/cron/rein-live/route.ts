import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { liveRefreshTargets, mapWithConcurrency, type RaceVenue } from "@/lib/rein-live";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const PRODUCTION_ORIGIN = "https://rein-web.vercel.app";

function authorized(request: NextRequest, secret: string) {
  const supplied = request.headers.get("authorization") || "";
  const expected = `Bearer ${secret}`;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET || "";
  if (!secret || !authorized(request, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const origin = process.env.VERCEL_ENV === "production"
    ? PRODUCTION_ORIGIN
    : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : request.nextUrl.origin;

  try {
    const scheduleResponse = await fetch(`${origin}/api/races`, {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!scheduleResponse.ok) throw new Error(`schedule:${scheduleResponse.status}`);
    const schedule = await scheduleResponse.json() as { venues?: RaceVenue[] };
    const targets = liveRefreshTargets(schedule.venues || [], new Date());

    const results = await mapWithConcurrency(targets, 2, async (race) => {
      try {
        const response = await fetch(`${origin}/api/analyze?raceId=${encodeURIComponent(race.raceId)}&refresh=1`, {
          cache: "no-store",
          headers: { authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(150_000),
        });
        return { raceId: race.raceId, minutesUntilStart: race.minutesUntilStart, ok: response.ok, status: response.status };
      } catch {
        return { raceId: race.raceId, minutesUntilStart: race.minutesUntilStart, ok: false, status: 0 };
      }
    });

    return NextResponse.json({
      ok: results.every((result) => result.ok),
      checkedAt: new Date().toISOString(),
      targeted: targets.length,
      updated: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      results,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("REIN live refresh failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Live refresh failed" }, {
      status: 502,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
