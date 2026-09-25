import { NextRequest, NextResponse } from "next/server";
import { getCache } from "@vercel/functions";
import { responseCache } from "@/lib/response-cache";
import { raceProgress } from "@/lib/race-progress";
import { fetchSource } from "@/lib/source-fetch";
import { failureCacheHeaders, readFailure, writeFailure } from "@/lib/failure-cache";

const cachedSchedule = responseCache(120_000, 1);
const sharedSchedule = getCache({ namespace: "rein-schedule-v1" });
const publicCache = { "Cache-Control": "public, max-age=0, s-maxage=120, stale-while-revalidate=300" };

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const BASE = "https://sports.yahoo.co.jp/keiba";
const headers = { "user-agent": "Mozilla/5.0 (compatible; REIN/0.3; personal analysis)" };
const decode = (value: string) => value.replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

type VenueSeed = { name: string; eventId: string; nextRace: number; nextStart: string };

type ScheduleDay = "today" | "tomorrow";

function jstDate(day: ScheduleDay) {
  const now = new Date(Date.now() + 9 * 3600_000 + (day === "tomorrow" ? 24 * 3600_000 : 0));
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, date: now.getUTCDate() };
}

export function monthlyVenueSeeds(html: string, targetDate: number): VenueSeed[] {
  const venues = new Set(["札幌", "函館", "福島", "新潟", "東京", "中山", "中京", "京都", "阪神", "小倉"]);
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap((row) => {
    const text = decode(row[1]);
    if (!new RegExp(`(?:^|\\s)${targetDate}日[（(]`).test(text)) return [];
    return [...row[1].matchAll(/href=["']\/keiba\/race\/list\/(\d{8})["'][^>]*>([\s\S]*?)<\/a>/gi)].flatMap((match) => {
      const label = decode(match[2]);
      const name = [...venues].find((venue) => label.includes(venue));
      return name ? [{ name, eventId: match[1], nextRace: 1, nextStart: "--:--" }] : [];
    });
  });
}

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

export async function GET(request: NextRequest) {
  const day: ScheduleDay = request.nextUrl.searchParams.get("day") === "tomorrow" ? "tomorrow" : "today";
  const cacheKey = day;
  try {
    const shared = await sharedSchedule.get(cacheKey);
    if (typeof shared === "string") {
      return new NextResponse(shared, {
        status: 200,
        headers: {
          ...publicCache,
          "content-type": "application/json; charset=utf-8",
          "x-rein-shared-cache": "1",
        },
      });
    }
  } catch (error) {
    console.error("REIN schedule cache read failed", error instanceof Error ? error.message : "unknown");
  }

  // Expected failures are cached too, so an upstream outage does not fan out with audience size.
  const failure = await readFailure(`schedule:${day}`);
  if (failure) {
    return new NextResponse(failure.body, {
      status: failure.status,
      headers: { ...failureCacheHeaders, "content-type": "application/json; charset=utf-8", "x-rein-failure-cache": "1" },
    });
  }
  const response = await cachedSchedule(`schedule:${day}`, () => loadSchedule(day));
  if (response.ok) {
    try {
      await sharedSchedule.set(cacheKey, await response.clone().text(), {
        ttl: day === "tomorrow" ? 900 : 120,
        tags: ["rein-live", "rein-schedule"],
        name: "REIN schedule",
      });
    } catch (error) {
      console.error("REIN schedule cache write failed", error instanceof Error ? error.message : "unknown");
    }
  } else {
    await writeFailure(`schedule:${day}`, { status: response.status, body: await response.clone().text() }, ["rein-live"]);
  }
  return response;
}

async function loadSchedule(day: ScheduleDay) {
  try {
    const target = jstDate(day);
    const source = day === "today"
      ? await fetchSource(`${BASE}/`, "開催情報")
      : await fetchSource(`${BASE}/schedule/monthly?month=${target.month}&year=${target.year}`, "翌日の開催情報");
    const seeds = day === "today" ? venueSeeds(source) : monthlyVenueSeeds(source, target.date);
    const emptyLabel = day === "today" ? "本日の開催" : `${target.year}年${target.month}月${target.date}日の開催`;
    if (!seeds.length) return NextResponse.json({ dateLabel: emptyLabel, updatedAt: new Date().toISOString(), venues: [] }, { headers: publicCache });
    const venues = await Promise.all(seeds.map(async (seed) => {
      const html = await fetchSource(`${BASE}/race/list/${seed.eventId}`, `${seed.name}のレース一覧`);
      const parsed = races(html, 0);
      if (day === "tomorrow") {
        const first = parsed[0];
        return { ...seed, nextRace: first?.number ?? 1, nextStart: first?.start ?? "--:--", races: parsed.map((race) => ({ ...race, status: "発売前" })) };
      }
      return { ...seed, ...raceProgress(parsed) };
    }));
    const dateLabel = day === "today"
      ? decode(source.match(/<section[^>]*id="raceflash"[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1] || "本日の開催")
      : `${target.year}年${target.month}月${target.date}日の開催（暫定）`;
    return NextResponse.json({ dateLabel, updatedAt: new Date().toISOString(), venues }, { headers: publicCache });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "開催情報を取得できませんでした" },
      { status: 502, headers: failureCacheHeaders },
    );
  }
}
