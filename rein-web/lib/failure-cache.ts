import { getCache } from "@vercel/functions";

// A failure is as reusable as a success for a short window. An unpublished race card
// or a source outage stays that way for seconds, but the failure path caches nothing:
// every visitor re-runs the upstream fetches, so one missing page becomes one scrape
// per visitor. Reuse the failure for a few seconds instead, and let the CDN collapse
// the rest. Deliberately short so a recovered source surfaces within one poll.
const cache = getCache({ namespace: "rein-failure-v1" });

export const FAILURE_TTL_SECONDS = 30;

export const failureCacheHeaders = {
  "Cache-Control": `public, max-age=0, s-maxage=${FAILURE_TTL_SECONDS}, stale-while-revalidate=30`,
};

export async function readFailure(key: string): Promise<string | null> {
  try {
    const value = await cache.get(key);
    return typeof value === "string" ? value : null;
  } catch (error) {
    console.error("REIN failure cache read failed", error instanceof Error ? error.message : "unknown");
    return null;
  }
}

export async function writeFailure(key: string, body: string, tags: string[]): Promise<void> {
  try {
    await cache.set(key, body, { ttl: FAILURE_TTL_SECONDS, tags, name: "REIN upstream failure" });
  } catch (error) {
    console.error("REIN failure cache write failed", error instanceof Error ? error.message : "unknown");
  }
}
