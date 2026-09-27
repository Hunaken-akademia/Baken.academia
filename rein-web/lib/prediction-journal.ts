export type JournalHorse = {
  number: number; name: string; popularity: number; odds: number | null;
  firstProbability?: number; secondProbability?: number; thirdProbability?: number;
};
export type JournalInput = {
  race: { raceId: string; title: string; startsAt?: number | null; dataTimes?: { odds?: string | null; card?: string | null } };
  prediction?: { phase: string; source: string; generatedAt: string };
  model?: { version: string };
  horses: JournalHorse[];
  review?: { isFinished: boolean; finishers: Array<{ number: number; finish: number }> };
  evaluation?: { roleModel: string };
};
export type JournalEntry = {
  schema: 1; id: string; raceId: string; title: string; generatedAt: string; model: string;
  startsAt: number; oddsAt: string | null; roster: string; horses: JournalHorse[];
  finishers?: Array<{ number: number; finish: number }>;
};
export const JOURNAL_KEY = "rein-prediction-journal-v1";
export const JOURNAL_LIMIT = 60;
const roles = ["firstProbability", "secondProbability", "thirdProbability"] as const;
const roster = (horses: Array<{ number: number }>) => horses.map(h => h.number).sort((a,b) => a-b).join("-");
const validResult = (result: Array<{ number: number; finish: number }>, horses: Array<{ number: number }>) =>
  result.every(r => r && Number.isInteger(r.finish) && r.finish >= 1 && horses.some(h => h.number === r.number)) &&
  new Set(result.map(r => r.number)).size === result.length &&
  [1,2,3].every(f => result.filter(r => r.finish === f).length === 1);

export function makeJournalEntry(input: JournalInput): JournalEntry | null {
  const p = input.prediction, start = input.race.startsAt;
  if (!p || !(p.phase === "prestart" || p.source === "prestart") || p.source === "rebuilt" || input.evaluation?.roleModel !== "ready") return null;
  const time = Date.parse(p.generatedAt);
  if (!Number.isFinite(time) || typeof start !== "number" || !Number.isFinite(start) || time >= start || !input.horses.length) return null;
  if (input.horses.some(h => !Number.isInteger(h.number) || h.number < 1 || roles.some(r => typeof h[r] !== "number" || !Number.isFinite(h[r]) || h[r]! < 0 || h[r]! > 1))) return null;
  if (new Set(input.horses.map(h => h.number)).size !== input.horses.length) return null;
  return {
    schema: 1, id: `${input.race.raceId}:${p.generatedAt}`, raceId: input.race.raceId, title: input.race.title,
    generatedAt: p.generatedAt, startsAt: start, model: input.model?.version ?? "不明",
    oddsAt: input.race.dataTimes?.odds || input.race.dataTimes?.card || null, roster: roster(input.horses),
    horses: input.horses.map(({ number, name, popularity, odds, firstProbability, secondProbability, thirdProbability }) => ({ number, name, popularity, odds, firstProbability, secondProbability, thirdProbability })),
  };
}

export function addJournalEntry(entries: JournalEntry[], entry: JournalEntry): JournalEntry[] {
  if (entries.some(e => e.id === entry.id)) return entries;
  return [...entries, entry].sort((a,b) => a.generatedAt.localeCompare(b.generatedAt)).slice(-JOURNAL_LIMIT);
}

export function attachJournalResult(entries: JournalEntry[], input: JournalInput): JournalEntry[] {
  if (!input.review?.isFinished) return entries;
  const result = input.review.finishers;
  // Ambiguous/tied top3 and changed fields are excluded from this simple audit.
  if (!validResult(result, input.horses)) return entries;
  const key = roster(input.horses);
  if (result.some(r => !input.horses.some(h => h.number === r.number))) return entries;
  return entries.map(e => e.raceId === input.race.raceId && e.roster === key && !e.finishers ? { ...e, finishers: result.map(({ number, finish }) => ({ number, finish })) } : e);
}

export function journalSummary(entries: JournalEntry[]) {
  const latest = new Map<string, JournalEntry>();
  for (const e of [...entries].sort((a,b) => a.generatedAt.localeCompare(b.generatedAt))) if (e.finishers) latest.set(e.raceId, e);
  return [1,4,6,10].map(minPopularity => ({ minPopularity, roles: roles.map((role,index) => {
    let races = 0, hits = 0;
    for (const e of latest.values()) {
      const result = e.finishers!.find(r => r.finish === index+1);
      const horse = e.horses.find(h => h.number === result?.number);
      if (!horse || (minPopularity > 1 && (!Number.isInteger(horse.popularity) || horse.popularity < minPopularity || horse.popularity > e.horses.length))) continue;
      races++;
      const top5 = [...e.horses].sort((a,b) => (b[role] ?? -1)-(a[role] ?? -1)).slice(0,5);
      if (top5.some(h => h.number === horse.number)) hits++;
    }
    return { target: index+1, races, hits };
  }) }));
}

export function readJournal(value: string | null): JournalEntry[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e: JournalEntry) => e && e.schema === 1 && typeof e.id === "string" && typeof e.raceId === "string" && typeof e.title === "string" && typeof e.model === "string" && typeof e.generatedAt === "string" && Number.isFinite(Date.parse(e.generatedAt)) && typeof e.startsAt === "number" && Number.isFinite(e.startsAt) && Date.parse(e.generatedAt) < e.startsAt && Array.isArray(e.horses) && e.horses.length > 0 && e.horses.every(h => h && Number.isInteger(h.number) && h.number > 0 && typeof h.name === "string" && typeof h.popularity === "number" && Number.isFinite(h.popularity) && roles.every(r => typeof h[r] === "number" && Number.isFinite(h[r]) && h[r]! >= 0 && h[r]! <= 1)) && new Set(e.horses.map(h => h.number)).size === e.horses.length && e.roster === roster(e.horses) && (!e.finishers || Array.isArray(e.finishers) && validResult(e.finishers, e.horses))).sort((a: JournalEntry,b: JournalEntry) => a.generatedAt.localeCompare(b.generatedAt)).slice(-JOURNAL_LIMIT);
  } catch { return []; }
}

export function marketRankPoints(horses: JournalHorse[], role: typeof roles[number] = "firstProbability") {
  if (!horses.length || horses.some(h => !Number.isInteger(h.popularity) || h.popularity < 1 || h.popularity > horses.length || typeof h[role] !== "number" || !Number.isFinite(h[role]))) return [];
  return [...horses].sort((a,b) => (b[role] ?? -1)-(a[role] ?? -1)).map((horse,index) => ({ ...horse, rank: index+1, difference: horse.popularity-index-1 }));
}
