import { NextRequest, NextResponse } from "next/server";
import { getCache } from "@vercel/functions";
import { hasBearerSecret } from "@/lib/internal-auth";
import { mapWithConcurrency, type RaceVenue } from "@/lib/rein-live";
import {
  planPrecompute,
  snapshotMetaKey,
  type PrecomputeRace,
  type SnapshotMeta,
} from "@/lib/analysis-cache";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const PRODUCTION_ORIGIN = "https://rein-web.vercel.app";
// Same namespace as /api/analyze, which writes the snapshots and their metadata.
const analysisCache = getCache({ namespace: "rein-analysis-v1" });
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
  if (!hasBearerSecret(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const origin = process.env.VERCEL_ENV === "production"
    ? PRODUCTION_ORIGIN
    : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : request.nextUrl.origin;

  try {
    const today = await loadRaces(origin, secret, "today");
    // Tomorrow's card is optional work; a failure there must not stop today's refresh.
    const tomorrow = await loadRaces(origin, secret, "tomorrow").catch((error) => {
      console.error("REIN precompute: tomorrow schedule unavailable", error instanceof Error ? error.message : "unknown");
      return [] as PrecomputeRace[];
    });
    const races = [...today, ...tomorrow];
    const metas = new Map<string, SnapshotMeta | null>();
    await mapWithConcurrency(races, 8, async (race) => {
      const key = `${race.preview ? "preview" : "live"}:${race.raceId}`;
      try {
        const meta = await analysisCache.get(snapshotMetaKey(race.raceId, race.preview));
        metas.set(key, meta && typeof meta === "object" ? (meta as SnapshotMeta) : null);
      } catch {
        metas.set(key, null);
      }
    });
    const planned = planPrecompute(races, metas, new Date());
    const near = planned.filter((job) => job.reason === "near-start");
    const jobs = [...near, ...planned.filter((job) => job.reason !== "near-start").slice(0, MAX_BACKLOG_JOBS)];

    const results = await mapWithConcurrency(jobs, 3, async (job) => {
      const remaining = START_BUDGET_MS - (Date.now() - startedAt);
      if (remaining <= 0) return { raceId: job.raceId, preview: job.preview, reason: job.reason, ok: false, status: -1 };
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
          ok: response.ok && response.headers.get("x-rein-fallback") === "0",
          status: response.status,
        };
      } catch {
        return { raceId: job.raceId, preview: job.preview, reason: job.reason, ok: false, status: 0 };
      }
    });

    const summary = {
      checkedAt: new Date().toISOString(),
      planned: planned.length,
      attempted: jobs.length,
      updated: results.filter((result) => result.ok).length,
      incomplete: results.filter((result) => !result.ok && result.status > 0).length,
      failed: results.filter((result) => result.status === 0).length,
      deferred: results.filter((result) => result.status === -1).length,
      elapsedMs: Date.now() - startedAt,
    };
    console.info("REIN precompute", JSON.stringify(summary));
    return NextResponse.json({ ok: summary.failed === 0, ...summary, results }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("REIN live refresh failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Live refresh failed" }, {
      status: 502,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
