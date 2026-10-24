import { NextRequest, NextResponse } from "next/server";
import { getCache } from "@vercel/functions";
import { createClient } from "./supabase/server";
import { JRA_TRACK_VENUES, parseLiveCushion, validTrackDate, type TrackRecord, type TrackReferenceData } from "./track-reference";
import { NAR_COURSES } from "./nar-source";

const cache = getCache({ namespace: "rein-track-reference-v1" });
const headers = { "cache-control": "private, no-store" };
const liveUrl = "https://www.jra.go.jp/keiba/baba/_data_cushion.html";
let livePending: Promise<{ html: string; fetchedAt: string } | null> | null = null;
async function liveSource() {
  const saved = await cache.get("jra-live").catch(() => null) as { html: string; fetchedAt: string; failed?: boolean } | null;
  if (saved) return saved.failed ? null : saved;
  if (!livePending) livePending = (async () => {
    try {
      const response = await fetch(liveUrl, { signal: AbortSignal.timeout(8000), cache: "no-store", headers: { "user-agent": "Mozilla/5.0 (compatible; REIN track reference)" } });
      if (!response.ok) throw new Error("Official source unavailable");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 200_000) throw new Error("Official source too large");
      const html = new TextDecoder("shift_jis").decode(bytes);
      if (!html.includes('id="cushion_data_list"')) throw new Error("Official source changed");
      const result = { html, fetchedAt: new Date().toISOString() };
      await cache.set("jra-live", result, { ttl: 3600 }).catch(() => {});
      return result;
    } catch {
      await cache.set("jra-live", { failed: true }, { ttl: 300 }).catch(() => {});
      return null;
    }
  })().finally(() => { livePending = null; });
  return livePending;
}

export async function trackReferenceResponse(request: NextRequest, league: "jra" | "nar") {
  const venue = request.nextUrl.searchParams.get("venue") ?? "", date = request.nextUrl.searchParams.get("date") ?? "";
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0,10);
  const tomorrow = new Date(Date.now() + 9 * 3600_000 + 86400_000).toISOString().slice(0,10);
  if (!(league === "jra" ? JRA_TRACK_VENUES : Object.values(NAR_COURSES)).includes(venue) || !validTrackDate(date) || date < "2018-01-01" || date > tomorrow) {
    return NextResponse.json({ error: "競馬場・日付を確認してください" }, { status: 400, headers });
  }
  // These routes live below /api/races and /api/nar: the shared proxy verifies
  // membership and the matching league before either the cache or source is read.
  try {
    const key = `${league}:${venue}:${date}`;
    let records = await cache.get(key).catch(() => null) as TrackRecord[] | null;
    if (!records) {
      const supabase = await createClient();
      const { data, error } = await supabase.from("rein_track_references")
        .select("reference_date,source_url,payload").eq("league", league).eq("venue", venue)
        .lte("reference_date", date).order("reference_date", { ascending: false }).limit(6);
      if (error) throw error;
      records = data as TrackRecord[];
      await cache.set(key, records, { ttl: 3600 }).catch(() => {});
    }
    const source = league === "jra" && date >= today ? await liveSource() : null;
    const parsed = source ? parseLiveCushion(source.html, venue) : null;
    const result: TrackReferenceData = { venue, date, records, live: parsed && source ? { ...parsed, sourceUrl: liveUrl, fetchedAt: source.fetchedAt } : null, liveError: league === "jra" && date >= today && !source };
    return NextResponse.json(result, { headers });
  } catch {
    return NextResponse.json({ error: "馬場の参考情報を取得できませんでした。時間をおいて再度ご確認ください。" }, { status: 503, headers });
  }
}
