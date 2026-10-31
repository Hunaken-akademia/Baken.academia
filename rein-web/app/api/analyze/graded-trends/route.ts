import { NextRequest, NextResponse } from "next/server";
import trends from "@/lib/jra-graded-trends.json";
import { jraGradedRaceKey } from "@/lib/jra-reference";
import type { GradedTrend } from "@/lib/graded-trends";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, max-age=600" };
const data = trends as unknown as { version: string; throughYear: number; races: Record<string, GradedTrend>; limitations: string[] };

// One race's cards from the bundled trend file, matched like the existing graded history.
export function GET(request: NextRequest) {
  const title = request.nextUrl.searchParams.get("title") ?? "", raceId = request.nextUrl.searchParams.get("raceId") ?? "";
  if (!/^\d{10}$/.test(raceId) || !title) return NextResponse.json({ error: "レースを確認できません" }, { status: 400, headers });
  const year = 2000 + Number(raceId.slice(0, 2));
  const trend = year > data.throughYear ? data.races[jraGradedRaceKey(title, year)] : undefined;
  return trend ? NextResponse.json({ trend, limitations: data.limitations }, { headers }) : NextResponse.json({ trend: null }, { headers });
}
