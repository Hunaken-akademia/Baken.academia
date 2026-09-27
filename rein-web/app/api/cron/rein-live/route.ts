import { NextRequest, NextResponse } from "next/server";
import { authorizedCapture } from "@/lib/capture-auth";
import { claimCapture, releaseCapture, durableMetas, serverData, dateJst } from "@/lib/server-snapshots";
import { mapWithConcurrency, type RaceVenue } from "@/lib/rein-live";
import {
  planPrecompute,
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

async function loadRaces(origin: string, secret: string, day: "today" | "tomorrow") {
  const response = await fetch(`${origin}/api/races${day === "tomorrow" ? "?day=tomorrow" : ""}`, {
    cache: "no-store",
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(30_000),
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
  const targetDate = requested ?? dateJst();
  if (![dateJst(), dateJst(-1)].includes(targetDate)) return NextResponse.json({error:"Invalid capture date"},{status:400});
  const lockKey = `cron:${targetDate}`;
  const lease = await claimCapture(lockKey,300).catch(() => null);
  if (!lease?.acquired || !lease.token) return NextResponse.json({ok:true,deferred:true,reason:"capture-in-progress"},{status:202});
  try {
    const stored = targetDate !== dateJst() ? await serverData<{schedule:{payload:{venues:RaceVenue[]}}|null}>("schedule",{date:targetDate}) : null;
    if (targetDate !== dateJst() && !stored?.schedule) return NextResponse.json({ok:false,error:"No saved schedule for requested date"},{status:404});
    const todaysRaces = stored ? (stored.schedule?.payload.venues ?? []).flatMap(v=>(v.races??[]).map(r=>({...r,preview:false}))) : await loadRaces(origin, secret, "today");
    // Tomorrow's card is optional work; a failure there must not stop today's refresh.
    const today = todaysRaces.map(r=>({...r,date:targetDate}));
    const localHour = new Date(Date.now()+9*3600_000).getUTCHours();
    const tomorrow = localHour >= 16 && !requested ? await loadRaces(origin, secret, "tomorrow").catch((error) => {
      console.error("REIN precompute: tomorrow schedule unavailable", error instanceof Error ? error.message : "unknown");
      return [] as PrecomputeRace[];
    }) : [];
    const races = [...today, ...tomorrow];
    const metas = await durableMetas(targetDate);
    if (tomorrow.length) for (const [key,value] of await durableMetas(dateJst(1))) metas.set(key,value);
    const planned = planPrecompute(races, metas, new Date());
    const near = planned.filter((job) => job.reason === "near-start");
    const jobs = [...near, ...planned.filter((job) => job.reason !== "near-start").slice(0, MAX_BACKLOG_JOBS)];

    const results = await mapWithConcurrency(jobs, 3, async (job) => {
      const remaining = START_BUDGET_MS - (Date.now() - startedAt);
      if (remaining <= 0) return { raceId: job.raceId, preview: job.preview, reason: job.reason, ok: false, complete: false, status: -1 };
      try {
        const response = await fetch(
          `${origin}/api/analyze?raceId=${encodeURIComponent(job.raceId)}&refresh=1${job.preview ? "&preview=1" : ""}`,
          {
            cache: "no-store",
            headers: { authorization: `Bearer ${secret}` },
            signal: AbortSignal.timeout(Math.max(5_000, Math.min(ANALYZE_TIMEOUT_MS, FUNCTION_BUDGET_MS - (Date.now() - startedAt)))),
          },
        );
        return {
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
    return NextResponse.json({ ok: summary.failed === 0 && summary.incomplete === 0, ...summary, remaining: Math.max(0, planned.length-summary.updated), results }, {
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
