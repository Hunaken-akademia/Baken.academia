export type ScheduledRace = {
  raceId: string;
  start: string;
  status?: string;
};

export type RaceVenue = {
  races?: ScheduledRace[];
};

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function jstMinutes(date: Date) {
  const jst = new Date(date.getTime() + JST_OFFSET_MS);
  return jst.getUTCHours() * 60 + jst.getUTCMinutes();
}

export function liveRefreshTargets(venues: RaceVenue[], now: Date, limit = 8) {
  const current = jstMinutes(now);
  return venues
    .flatMap((venue) => venue.races || [])
    .filter((race) => /^\d{1,2}:\d{2}$/.test(race.start) && race.status !== "確定")
    .map((race) => {
      const [hour, minute] = race.start.split(":").map(Number);
      return { ...race, minutesUntilStart: hour * 60 + minute - current };
    })
    .filter((race) => race.minutesUntilStart >= 0 && race.minutesUntilStart <= 35)
    .sort((a, b) => a.minutesUntilStart - b.minutesUntilStart || a.raceId.localeCompare(b.raceId))
    .slice(0, limit);
}

export async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}
