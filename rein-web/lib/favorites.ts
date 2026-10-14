export type League = "jra" | "nar";
export type EntryHorse = { number: number; name: string; horseId: string | null; jockey: string; jockeyId: string | null };
export type EntryRace = { raceId: string; title: string; start: string; horses: EntryHorse[] };
export type FavoriteJockey = { key: string; name: string };
export type FavoriteMatch = { raceId: string; title: string; start: string; items: Array<{ number: number; horse: string; jockey: string; reasons: Array<"horse" | "jockey"> }> };

export const FAVORITE_JOCKEY_LIMIT = 50;
const KEY = /^(jra|nar):[0-9A-Za-z]{1,12}$/;

export function jockeyKey(league: League, jockeyId: string | null | undefined) {
  if (!jockeyId || !/^[0-9A-Za-z]{1,12}$/.test(jockeyId)) return null;
  return `${league}:${jockeyId}`;
}

export function validJockeyKey(value: unknown): value is string {
  return typeof value === "string" && KEY.test(value);
}

export function cleanJockeyName(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 60) : "";
}

// Lists races in start order that include a watched horse or a favorite jockey.
export function favoriteMatches(league: League, races: EntryRace[], watchedHorseIds: Iterable<string>, jockeys: Iterable<string>): FavoriteMatch[] {
  const horses = new Set(watchedHorseIds), riders = new Set(jockeys);
  if (!horses.size && !riders.size) return [];
  return races.flatMap((race) => {
    const items = race.horses.flatMap((horse) => {
      const reasons: Array<"horse" | "jockey"> = [];
      if (horse.horseId && horses.has(horse.horseId)) reasons.push("horse");
      const key = jockeyKey(league, horse.jockeyId);
      if (key && riders.has(key)) reasons.push("jockey");
      return reasons.length ? [{ number: horse.number, horse: horse.name, jockey: cleanJockeyName(horse.jockey), reasons }] : [];
    });
    return items.length ? [{ raceId: race.raceId, title: race.title, start: race.start, items: items.sort((a, b) => a.number - b.number) }] : [];
  }).sort((a, b) => (a.start || "99:99").localeCompare(b.start || "99:99") || a.raceId.localeCompare(b.raceId));
}
