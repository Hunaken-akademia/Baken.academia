import { NextResponse } from "next/server";
import { responseCache } from "@/lib/response-cache";
import { raceProgress } from "@/lib/race-progress";
import { fetchSource } from "@/lib/source-fetch";
import { failureCacheHeaders, readFailure, writeFailure } from "@/lib/failure-cache";

const cachedSchedule = responseCache(30_000, 1);
const publicCache = { "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=30" };

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const BASE = "https://sports.yahoo.co.jp/keiba";
const headers = { "user-agent": "Mozilla/5.0 (compatible; REIN/0.3; personal analysis)" };
const decode = (value: string) => value.replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

type VenueSeed = { name: string; eventId: string; nextRace: number; nextStart: string };

function venueSeeds(html: string): VenueSeed[] {
  const section = html.match(/<section[^>]*id="raceflash"[\s\S]*?<\/section>/i)?.[0] || "";
  return [...section.matchAll(/<li[^>]*hr-raceProgress__item[^>]*>([\s\S]*?)<\/li>/gi)].flatMap((match) => {
    const item = match[1];
    const raceId = item.match(/\/keiba\/race\/(?:index|list)\/(\d{8,12})/)?.[1];
    const name = decode(item.match(/hr-raceProgress__title[^>]*>([\s\S]*?)<\/h3>/i)?.[1] || "");
    const itemText = decode(item);
    const raceNumber = +(decode(item.match(/hr-raceProgress__raceTitle[^>]*>([\s\S]*?)<\/span>/i)?.[1] || "0").replace("R", ""));
    const finished = itemText.includes("開催終了");
    const nextRace = finished ? 13 : raceNumber;
    const nextStart = itemText.match(/(\d{1,2}:\d{2})/)?.[1] || "--:--";
    const eventId = raceId?.length === 8 ? raceId : raceId?.slice(0, -2);
    return eventId && name ? [{ name, eventId, nextRace, nextStart }] : [];
  });
}

function races(html: string, nextRace: number) {
  const pattern = /<td[^>]*hr-tableSchedule__data--date[^>]*[^>]*>\s*(\d+)R\s*<p>([^<]+)<\/p>[\s\S]*?<a[^>]*hr-tableSchedule__link[^>]*href="\/keiba\/race\/index\/(\d{10,12})"[^>]*>[\s\S]*?<span[^>]*hr-tableSchedule__title[^>]*>([\s\S]*?)<\/span>[\s\S]*?<span[^>]*hr-tableSchedule__statusText[^>]*>([\s\S]*?)<\/span>/gi;
  return [...html.matchAll(pattern)].map((match) => {
    const number = +match[1];
    return {
      number,
      start: decode(match[2]),
      raceId: match[3],
      title: decode(match[4]),
      course: decode(match[5]),
      status: number < nextRace ? "確定" : number === nextRace ? "次レース" : "発売前",
    };
  });
}

export async function GET() {
  // Every visible client polls this once a minute, so an unreusable failure is the
  // one response that scales with the audience instead of being collapsed by the CDN.
  const failure = await readFailure("schedule");
  if (failure) {
    return new NextResponse(failure.body, {
      status: failure.status,
      headers: { ...failureCacheHeaders, "content-type": "application/json; charset=utf-8", "x-rein-failure-cache": "1" },
    });
  }
  const response = await cachedSchedule("schedule", loadSchedule);
  if (!response.ok) {
    await writeFailure("schedule", { status: response.status, body: await response.clone().text() }, ["rein-live"]);
  }
  return response;
}

async function loadSchedule() {
  try {
    const home = await fetchSource(`${BASE}/`, "開催情報");
    const seeds = venueSeeds(home);
    if (!seeds.length) return NextResponse.json({ dateLabel: "本日の開催", venues: [] }, { headers: publicCache });
    const venues = await Promise.all(seeds.map(async (seed) => {
      const html = await fetchSource(`${BASE}/race/list/${seed.eventId}`, `${seed.name}のレース一覧`);
      const parsed = races(html, 0);
      return { ...seed, ...raceProgress(parsed) };
    }));
    const dateLabel = decode(home.match(/<section[^>]*id="raceflash"[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1] || "本日の開催");
    return NextResponse.json({ dateLabel, updatedAt: new Date().toISOString(), venues }, { headers: publicCache });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "開催情報を取得できませんでした" },
      { status: 502, headers: failureCacheHeaders },
    );
  }
}
