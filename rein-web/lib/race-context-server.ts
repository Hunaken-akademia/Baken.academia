import { NextRequest, NextResponse } from "next/server";
import { getCache } from "@vercel/functions";
import { serverData } from "./server-snapshots";
import { fetchSource } from "./source-fetch";
import { narRaceKey, narUrl, parseNarCard } from "./nar-source";
import { matchPreviousRuns, parseJraPreviousRuns, parseNarPreviousRuns } from "./previous-run";
import { buildDayTrends, type TrendRace } from "./race-day-trends";
import type { RaceContextData } from "./race-context-types";
import { createHash } from "node:crypto";

const cache = getCache({ namespace: "rein-race-context-v1" });
const jraSourceCache = getCache({ namespace: "rein-analysis-v1" });
const headers = { "cache-control": "private, no-store" };
type StoredContext = { target: { raceId: string; date: string; course: string; startsAt: number | null; horses: Array<{ number: number; name: string; horseId?: string }> }; races: TrendRace[] };
const inFlight = new Map<string, Promise<RaceContextData>>();

async function buildContext(raceId: string, league: "jra" | "nar") {
  // Broker accepts only existing snapshots and returns earlier races from this meeting.
  const { target, races } = await serverData<StoredContext>("race-context", { raceId, league });
  if (!target || target.raceId !== raceId) throw new Error("対象レースの保存情報がまだありません");
  const key = league === "nar" ? narRaceKey(raceId) : null;
  const url = key ? narUrl("DebaTable", key.date, key.code, key.number) : `https://sports.yahoo.co.jp/keiba/race/denma/${raceId}?detail=1`;
  let previousRuns: RaceContextData["previousRuns"] = {}, previousFetchedAt: string | null = null, previousError: string | null = null;
  try {
    const sourceKey = `previous:${raceId}`;
    let source = await cache.get(sourceKey).catch(() => null) as { body: string; fetchedAt: string } | null;
    if (!source && league === "jra") {
      // Reuse the detail already fetched by the scheduled analyzer.
      const saved = await jraSourceCache.get("source-v2:" + createHash("sha256").update(url).digest("hex")).catch(() => null);
      if (typeof saved === "string") source = JSON.parse(saved);
    }
    if (!source?.body) source = { body: await fetchSource(url, "前走データ"), fetchedAt: new Date().toISOString() };
    if (league === "nar") parseNarCard(source.body, raceId); // validates the card's date, venue and race number
    else {
      const canonical = source.body.match(/<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)/i)?.[1];
      if (!canonical || new URL(canonical).pathname !== `/keiba/race/denma/${raceId}`) throw new Error("出走表のレース照合に失敗しました");
    }
    const parsed = league === "jra" ? parseJraPreviousRuns(source.body, target.date) : parseNarPreviousRuns(source.body, target.date);
    if (!parsed.length) throw new Error("前走欄を確認できませんでした");
    previousRuns = matchPreviousRuns(parsed, target.horses);
    previousFetchedAt = source.fetchedAt;
    await cache.set(sourceKey, source, { ttl: 12 * 3600 }).catch(() => {});
  } catch { previousError = "前走データを取得できませんでした。時間をおいて再取得してください。"; }
  return { raceId, date: target.date, generatedAt: new Date().toISOString(), previousFetchedAt, previousRuns, previousError, trends: buildDayTrends(target, races) } satisfies RaceContextData;
}

export async function raceContextResponse(request: NextRequest, league: "jra" | "nar") {
  const raceId = request.nextUrl.searchParams.get("raceId") ?? "";
  if (league === "jra" ? !/^\d{8}(?:0[1-9]|1[0-2])$/.test(raceId) : !narRaceKey(raceId)) return NextResponse.json({ error: "レースIDが不正です" }, { status: 400, headers });
  try {
    const key = `${league}:${raceId}`;
    const saved = await cache.get(key).catch(() => null);
    if (saved && typeof saved === "object") return NextResponse.json(saved, { headers });
    let pending = inFlight.get(key);
    if (!pending) {
      if (inFlight.size >= 8) return NextResponse.json({ error: "アクセスが集中しています。少し待って再取得してください。" }, { status: 503, headers: { ...headers, "Retry-After": "5" } });
      pending = buildContext(raceId, league).then(async body => { await cache.set(key, body, { ttl: body.previousError ? 60 : 300 }).catch(() => {}); return body; }).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return NextResponse.json(await pending, { headers });
  } catch (error) {
    console.error("REIN race context", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "比較用データの取得を一時的に見合わせています。時間をおいて再取得してください。" }, { status: 503, headers });
  }
}
