import { NextRequest, NextResponse } from "next/server";
import { authorizedCapture } from "@/lib/capture-auth";
import { claimCapture, releaseCapture, durableMetas, serverData, dateJst } from "@/lib/server-snapshots";
import { mapWithConcurrency, type RaceVenue } from "@/lib/rein-live";
import { loadNarRuntime } from "@/lib/nar-model";
import { expireNarReleaseMetas } from "@/lib/nar-release";
import {
  planPrecompute, backfillPage,
  type PrecomputeRace,
} from "@/lib/analysis-cache";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const PRODUCTION_ORIGIN = "https://rein-web.vercel.app";
// Stop starting new work early enough that a started analysis can finish in time.
const START_BUDGET_MS = 200_000;
const ANALYZE_TIMEOUT_MS = 150_000;
const FUNCTION_BUDGET_MS = 285_000;
// Near-start races are always refreshed; the rest of the backlog (morning fill,
// results, tomorrow's previews) is capped per run so source fetches are spread out
// (6 runs an hour x 12 races).
const MAX_BACKLOG_JOBS = 12;

async function loadRaces(origin: string, secret: string, day: "today" | "tomorrow", league: "jra" | "nar" = "jra", requestedDate?: string) {
  const query = requestedDate ? `?date=${encodeURIComponent(requestedDate)}` : day === "tomorrow" ? "?day=tomorrow" : "";
  const response = await fetch(`${origin}${league === "nar" ? "/api/nar" : "/api"}/races${query}`, {
    cache: "no-store",
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(league === "nar" ? 100_000 : 30_000),
  });
  if (!response.ok) throw new Error(`schedule:${day}:${response.status}`);
  const schedule = (await response.json()) as { venues?: RaceVenue[] };
  return (schedule.venues || []).flatMap((venue) =>
    (venue.races || []).map((race): PrecomputeRace => ({ ...race, preview: day === "tomorrow" })),
  );
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const secret = process.env.CRON_SECRET || "";
  if (!await authorizedCapture(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const origin = process.env.VERCEL_ENV === "production"
    ? PRODUCTION_ORIGIN
    : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : request.nextUrl.origin;

  const requested = request.nextUrl.searchParams.get("date");
  const league = request.nextUrl.searchParams.get("area") === "nar" ? "nar" : "jra";
  const targetDate = requested ?? dateJst();
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(targetDate) || targetDate < dateJst(-365) || targetDate > dateJst()) return NextResponse.json({error:"Invalid capture date"},{status:400});
  const lockKey = `cron:${league}:${targetDate}`;
  const lease = await claimCapture(lockKey,300).catch(() => null);
  if (!lease?.acquired || !lease.token) return NextResponse.json({ok:true,deferred:true,reason:"capture-in-progress"},{status:202});
  try {
    const expectedRelease=request.nextUrl.searchParams.get("release");
    const narRuntime=league==="nar"?await loadNarRuntime(!!expectedRelease):null;
    if(expectedRelease && (league!=="nar" || narRuntime?.model.release?.id!==expectedRelease))return NextResponse.json({error:"Model release pending"},{status:503});
    const stored = targetDate !== dateJst() ? await serverData<{schedule:{payload:{venues:RaceVenue[]}}|null}>("schedule",{date:targetDate,league}) : null;
    const todaysRaces = stored?.schedule
      ? stored.schedule.payload.venues.flatMap(v=>(v.races??[]).map(r=>({...r,preview:false})))
      : await loadRaces(origin, secret, "today", league, targetDate !== dateJst() ? targetDate : undefined);
    // Tomorrow's card is optional work; a failure there must not stop today's refresh.
    const today = todaysRaces.map(r=>({...r,date:targetDate}));
    const localHour = new Date(Date.now()+9*3600_000).getUTCHours();
    const tomorrow = localHour >= 16 && !requested ? await loadRaces(origin, secret, "tomorrow", league).catch((error) => {
      console.error("REIN precompute: tomorrow schedule unavailable", error instanceof Error ? error.message : "unknown");
      return [] as PrecomputeRace[];
    }) : [];
    const races = [...today, ...tomorrow];
    const metas = await durableMetas(targetDate);
    if (tomorrow.length) for (const [key,value] of await durableMetas(dateJst(1))) metas.set(key,value);
    if(narRuntime)expireNarReleaseMetas(metas,narRuntime.updatedAt,Date.now());
    const backfill = requested !== null && targetDate < dateJst() && request.nextUrl.searchParams.get("backfill") === "1";
    const after = backfill ? request.nextUrl.searchParams.get("after") || "" : "";
    if (after && !/^\d{10,12}$/.test(after)) return NextResponse.json({error:"Invalid backfill cursor"},{status:400});
    const pending = planPrecompute(races, metas, new Date());
    const planned = backfill ? backfillPage(pending, after) : pending;
    const near = planned.filter((job) => job.reason === "near-start");
    const retrospective = targetDate < dateJst(-1);
    const jobs = [...near, ...planned.filter((job) => job.reason !== "near-start").slice(0, retrospective ? 4 : MAX_BACKLOG_JOBS)];

    const results = await mapWithConcurrency(jobs, retrospective ? 1 : league === "nar" ? 2 : 3, async (job) => {
      const remaining = START_BUDGET_MS - (Date.now() - startedAt);
      if (remaining <= 0) return { raceId: job.raceId, preview: job.preview, reason: job.reason, ok: false, complete: false, status: -1 };
      try {
        const response = await fetch(
          `${origin}${league === "nar" ? "/api/nar" : "/api"}/analyze?raceId=${encodeURIComponent(job.raceId)}&refresh=1${job.preview ? "&preview=1" : ""}${expectedRelease ? `&release=${encodeURIComponent(expectedRelease)}` : ""}`,
          {
            cache: "no-store",
            headers: { authorization: `Bearer ${secret}` },
            signal: AbortSignal.timeout(Math.max(5_000, Math.min(ANALYZE_TIMEOUT_MS, FUNCTION_BUDGET_MS - (Date.now() - startedAt)))),
          },
        );
        const body = backfill && response.ok ? await response.json() : null;
        return {
          resultAvailable: body?.review?.isFinished === true,
          raceId: job.raceId,
          preview: job.preview,
          reason: job.reason,
          ok: response.ok && response.headers.get("x-rein-persisted") === "1",
          complete: response.headers.get("x-rein-fallback") === "0",
          status: response.status,
        };
      } catch {
        return { raceId: job.raceId, preview: job.preview, reason: job.reason, ok: false, complete: false, status: 0 };
      }
    });

    const summary = {
      league,
      ...(narRuntime?{narRelease:narRuntime.model.release?.id??null}:{}),
      checkedAt: new Date().toISOString(),
      date: targetDate,
      planned: planned.length,
      attempted: jobs.length,
      updated: results.filter((result) => result.ok).length,
      held: results.filter((result) => result.ok && !result.complete).length,
      incomplete: results.filter((result) => !result.ok && result.status > 0).length,
      failed: results.filter((result) => result.status === 0).length,
      deferred: results.filter((result) => result.status === -1).length,
      elapsedMs: Date.now() - startedAt,
    };
    await serverData("run", { summary: { ...summary, results } });
    console.info("REIN precompute", JSON.stringify(summary));
    return NextResponse.json({ ok: summary.failed === 0 && summary.incomplete === 0, ...summary,
      ...(backfill ? {
        nextCursor: results.length && results.every(r => r.ok) ? jobs[jobs.length-1].raceId : after,
        unavailableResults: results.filter(r => r.ok && "resultAvailable" in r && !r.resultAvailable).map(r => r.raceId),
      } : {}),
      remaining: Math.max(0, planned.length-summary.updated), results }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("REIN live refresh failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Live refresh failed" }, {
      status: 502,
      headers: { "Cache-Control": "private, no-store" },
    });
  } finally { await releaseCapture(lockKey,lease.token).catch(() => {}); }
}
