import { NextRequest, NextResponse } from "next/server";
import { getCache } from "@vercel/functions";
import { serverData } from "./server-snapshots";
import { PERFORMANCE_PERIODS, performanceRange, summarizePerformance, type PerformancePeriod, type PerformanceRace } from "./performance";

const cache = getCache({ namespace: "rein-performance-v1" });
const headers = { "cache-control": "private, no-store" };

export async function performanceResponse(request: NextRequest, league: "jra" | "nar") {
  const days = Number(request.nextUrl.searchParams.get("days") ?? 30) as PerformancePeriod;
  if (!PERFORMANCE_PERIODS.includes(days)) return NextResponse.json({ error: "集計期間を確認してください" }, { status: 400, headers });
  const { from, to } = performanceRange(days);
  const key = `${league}:${from}:${to}`;
  try {
    const cached = await cache.get(key).catch(() => null);
    if (cached && typeof cached === "object") return NextResponse.json(cached, { headers });
    const { races } = await serverData<{ races: PerformanceRace[] }>("performance", { league, from, to });
    const body = { league, days, range: { from, to }, generatedAt: new Date().toISOString(), ...summarizePerformance(races) };
    await cache.set(key, body, { ttl: 600 }).catch(() => {});
    return NextResponse.json(body, { headers });
  } catch {
    return NextResponse.json({ error: "成績を集計できませんでした。時間をおいて再読み込みしてください。" }, { status: 503, headers });
  }
}
