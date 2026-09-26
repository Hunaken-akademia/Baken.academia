// Snapshot keys and freshness rules shared by /api/analyze (serving) and the cron
// (precomputing). Viewers read snapshots; the cron keeps them current. A snapshot past
// its freshness window is still shown (with its data timestamps) while a refresh runs
// in the background, so a viewer never waits for inference when one exists.

export const SNAPSHOT_KEY = "snapshot-market-top4-v2";
export const PREVIEW_SNAPSHOT_KEY = "snapshot-preview-market-top4-v2";

const MINUTE = 60_000;
// The cron runs every 10 minutes; races within an hour of the start are refreshed on
// every run, later races and previews less often.
export const NEAR_START_MINUTES = 60;
export const NEAR_MAX_AGE_MS = 12 * MINUTE;
export const FAR_MAX_AGE_MS = 65 * MINUTE;
export const PREVIEW_MAX_AGE_MS = 180 * MINUTE;

// Storage lifetime is longer than freshness so an older snapshot can be shown while
// a refresh runs.
export const SNAPSHOT_TTL_SECONDS = { live: 6 * 60 * 60, final: 24 * 60 * 60, preview: 36 * 60 * 60 };

export function snapshotKey(raceId: string, preview: boolean) {
  return `${preview ? PREVIEW_SNAPSHOT_KEY : SNAPSHOT_KEY}:${raceId}`;
}

export function snapshotMetaKey(raceId: string, preview: boolean) {
  return `snapshot-meta-v1:${preview ? "preview" : "live"}:${raceId}`;
}

export function refreshLockKey(raceId: string, preview: boolean) {
  return `snapshot-refreshing-v1:${preview ? "preview" : "live"}:${raceId}`;
}

export type SnapshotMeta = {
  generatedAt: string;
  startsAt: number | null;
  final: boolean;
  preview: boolean;
};

type SnapshotBody = {
  race?: { startsAt?: number | null };
  prediction?: { generatedAt?: string; phase?: string };
  review?: { isFinished?: boolean };
};

export function metaFromBody(body: SnapshotBody, preview: boolean): SnapshotMeta | null {
  const generatedAt = body.prediction?.generatedAt;
  if (!generatedAt || !Number.isFinite(Date.parse(generatedAt))) return null;
  const startsAt = body.race?.startsAt;
  return {
    generatedAt,
    startsAt: typeof startsAt === "number" && Number.isFinite(startsAt) ? startsAt : null,
    final: Boolean(body.review?.isFinished),
    preview,
  };
}

export function snapshotMaxAgeMs(meta: SnapshotMeta, now: number) {
  if (meta.final) return Infinity;
  if (meta.preview) return PREVIEW_MAX_AGE_MS;
  if (meta.startsAt === null) return NEAR_MAX_AGE_MS;
  return meta.startsAt - now > NEAR_START_MINUTES * MINUTE ? FAR_MAX_AGE_MS : NEAR_MAX_AGE_MS;
}

export function isSnapshotFresh(meta: SnapshotMeta, now: number) {
  return now - Date.parse(meta.generatedAt) < snapshotMaxAgeMs(meta, now);
}

export function snapshotTtlSeconds(meta: SnapshotMeta) {
  return meta.final ? SNAPSHOT_TTL_SECONDS.final : meta.preview ? SNAPSHOT_TTL_SECONDS.preview : SNAPSHOT_TTL_SECONDS.live;
}

export type PrecomputeRace = {
  raceId: string;
  start: string;
  status?: string;
  preview: boolean;
};

export type PrecomputeJob = PrecomputeRace & { reason: "near-start" | "stale" | "missing" | "result" };

const JST_OFFSET_MS = 9 * 60 * MINUTE;

export function minutesUntilStart(start: string, now: Date) {
  const match = start.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  return +match[1] * 60 + +match[2] - (jst.getUTCHours() * 60 + jst.getUTCMinutes());
}

// Ordered work list for one cron run. Today's races within the hour always come first
// (odds move most there), then missing/stale snapshots for the rest of today, then
// finished races without a result snapshot, then tomorrow's previews.
export function planPrecompute(
  races: PrecomputeRace[],
  metas: Map<string, SnapshotMeta | null>,
  now: Date,
): PrecomputeJob[] {
  const nowMs = now.getTime();
  const near: PrecomputeJob[] = [];
  const later: Array<PrecomputeJob & { minutes: number }> = [];
  const results: PrecomputeJob[] = [];
  const previews: PrecomputeJob[] = [];
  for (const race of races) {
    const meta = metas.get(`${race.preview ? "preview" : "live"}:${race.raceId}`) ?? null;
    if (race.preview) {
      if (!meta) previews.push({ ...race, reason: "missing" });
      else if (!isSnapshotFresh(meta, nowMs)) previews.push({ ...race, reason: "stale" });
      continue;
    }
    const minutes = minutesUntilStart(race.start, now);
    if (minutes === null) continue;
    // The schedule does not mark results, so look for them 10-90 minutes after the
    // start until a result snapshot exists (a handful of attempts per race).
    if (minutes < 0) {
      if (minutes <= -10 && minutes > -90 && !meta?.final) results.push({ ...race, reason: "result" });
      continue;
    }
    if (minutes <= NEAR_START_MINUTES) {
      near.push({ ...race, reason: "near-start" });
      continue;
    }
    if (!meta) later.push({ ...race, reason: "missing", minutes });
    else if (nowMs - Date.parse(meta.generatedAt) >= FAR_MAX_AGE_MS - 10 * MINUTE)
      later.push({ ...race, reason: "stale", minutes });
  }
  near.sort((a, b) => (minutesUntilStart(a.start, now) ?? 0) - (minutesUntilStart(b.start, now) ?? 0));
  later.sort((a, b) => a.minutes - b.minutes);
  return [...near, ...later.map(({ minutes: _minutes, ...job }) => job), ...results, ...previews];
}
