export type TrendRace = {
  raceId: string; date: string; title: string; course: string; condition: string;
  startsAt: number | null; capturedAt: string; isFinished: boolean;
  horses: Array<{ number: number; gate?: number; style?: string }>;
  finishers: Array<{ number: number; finish: number }>;
};
export type TrendGroup = { label: string; runners: number; wins: number; top3: number; winRate: number | null; top3Rate: number | null };
export const raceSurface = (course: string) => course.match(/ばんえい|障害|芝|ダート/)?.[0] ?? null;
const sameDay = (time: number, date: string) => new Date(time + 9 * 3600000).toISOString().slice(0, 10) === date;
const validTime = (time: unknown): time is number => typeof time === "number" && Number.isFinite(time) && time > 0;
const gateGroup = (h: TrendRace["horses"][number]) => Number.isInteger(h.gate) && h.gate! >= 1 && h.gate! <= 8 ? h.gate! <= 3 ? "内枠（1〜3枠）" : h.gate! <= 6 ? "中枠（4〜6枠）" : "外枠（7〜8枠）" : null;
const styleGroup = (h: TrendRace["horses"][number]) => ["逃げ", "先行", "好位"].includes(h.style ?? "") ? "逃げ・先行・好位" : ["差し", "追込"].includes(h.style ?? "") ? "差し・追込" : null;
export function buildDayTrends(target: Pick<TrendRace, "raceId" | "date" | "course" | "startsAt">, input: TrendRace[], now = Date.now()) {
  const surface = raceSurface(target.course), supported = surface === "芝" || surface === "ダート";
  const cutoff = validTime(target.startsAt) && sameDay(target.startsAt, target.date) ? Math.min(target.startsAt, now) : null;
  const priorCount = Math.max(0, Math.min(11, Number(target.raceId.slice(-2)) - 1));
  const excluded = { missing: 0, pending: 0, afterCutoff: 0, otherSurface: 0, invalid: 0 };
  const races: TrendRace[] = [], seen = new Set<string>();
  for (const race of input) {
    if (race.raceId === target.raceId || race.raceId.slice(0, -2) !== target.raceId.slice(0, -2) || race.date !== target.date || Number(race.raceId.slice(-2)) >= Number(target.raceId.slice(-2)) || seen.has(race.raceId)) continue;
    seen.add(race.raceId);
    if (!supported || !cutoff) continue;
    if (raceSurface(race.course) !== surface) { excluded.otherSurface++; continue; }
    if (!race.isFinished) { excluded.pending++; continue; }
    const captured = Date.parse(race.capturedAt);
    // Conservative: overwritten or backfilled final snapshots cannot prove earlier availability.
    if (!validTime(race.startsAt) || !sameDay(race.startsAt, target.date) || !Number.isFinite(captured) || captured < race.startsAt || captured >= cutoff || race.startsAt >= cutoff) { excluded.afterCutoff++; continue; }
    const hs = race.horses, fs = race.finishers;
    if (!hs.length || new Set(hs.map(h => h.number)).size !== hs.length || hs.some(h => !Number.isInteger(h.number) || h.number < 1) || !fs.some(f => f.finish === 1) || !fs.some(f => f.finish <= 3) || new Set(fs.map(f => f.number)).size !== fs.length || fs.some(f => !Number.isInteger(f.finish) || f.finish < 1 || f.finish > hs.length || !hs.some(h => h.number === f.number)) || (hs.length >= 3 && fs.filter(f => f.finish <= 3).length < 3)) { excluded.invalid++; continue; }
    races.push(race);
  }
  excluded.missing = Math.max(0, priorCount - seen.size);
  races.sort((a, b) => a.raceId.localeCompare(b.raceId));
  const summarize = (labels: string[], group: (horse: TrendRace["horses"][number]) => string | null) => labels.map(label => {
    let runners = 0, wins = 0, top3 = 0;
    for (const race of races) for (const horse of race.horses) {
      if (group(horse) !== label) continue;
      runners++;
      const finish = race.finishers.find(f => f.number === horse.number)?.finish;
      if (finish === 1) wins++;
      if (finish !== undefined && finish <= 3) top3++;
    }
    return { label, runners, wins, top3, winRate: runners ? wins / runners * 100 : null, top3Rate: runners ? top3 / runners * 100 : null } satisfies TrendGroup;
  });
  return {
    supported, surface, cutoff: cutoff ? new Date(cutoff).toISOString() : null, priorCount, excluded,
    raceCount: races.length, runnerCount: races.reduce((s, r) => s + r.horses.length, 0),
    gates: summarize(["内枠（1〜3枠）", "中枠（4〜6枠）", "外枠（7〜8枠）"], gateGroup),
    styles: summarize(["逃げ・先行・好位", "差し・追込"], styleGroup),
    unknownGate: races.reduce((s, r) => s + r.horses.filter(h => !gateGroup(h)).length, 0),
    unknownStyle: races.reduce((s, r) => s + r.horses.filter(h => !styleGroup(h)).length, 0),
    races: races.map(r => ({ raceId: r.raceId, title: r.title, course: r.course, condition: r.condition, capturedAt: r.capturedAt, runners: r.horses.length })),
  };
}
export type DayTrends = ReturnType<typeof buildDayTrends>;
