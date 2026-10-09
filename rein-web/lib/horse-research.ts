import { roleOrder, type RoleKey } from "./marks";
import type { Horse, HistoryFactor } from "./horse-types";

export const ROLE_LABELS = { first: "1着", second: "2着", third: "3着" } as const;
export const HORSE_CONDITIONS = ["通算成績", "近5走", "芝ダ適性", "距離適性", "競馬場適性"] as const;
export type HorseFilter = "all" | "top5" | "longshot" | "selected";
export type HorseSort = "number" | "popularity" | "overall" | RoleKey;

export function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// The detailed factors are preferred, but older snapshots may have only historyFactors.
// Never let an empty detailed list hide valid saved history.
export function historyFactors(horse: Pick<Horse, "parameterFactors" | "historyFactors">): HistoryFactor[] {
  const factors = new Map<string, HistoryFactor>();
  for (const item of [...(horse.historyFactors ?? []), ...(horse.parameterFactors ?? [])]) {
    if (!factors.has(item.label) || item.samples > 0) factors.set(item.label, item);
  }
  return [...factors.values()];
}

export function historyRate(factor: HistoryFactor | undefined, kind: "win" | "top3"): number | null {
  if (!factor || !finite(factor.samples) || factor.samples <= 0) return null;
  const value = kind === "win" ? factor.winRate : factor.top3Rate;
  if (finite(value) && value >= 0 && value <= 100) return value;
  const count = kind === "win" ? factor.wins : factor.top3;
  return finite(count) && count >= 0 && count <= factor.samples ? count / factor.samples * 100 : null;
}

// Only compare the horse's own conditions with its own career, never with jockey/trainer totals.
export function careerDifference(factor: HistoryFactor, career: HistoryFactor | undefined): number | null {
  if (!HORSE_CONDITIONS.some(label => label === factor.label) || factor.label === "通算成績") return null;
  const current = historyRate(factor, "top3"), baseline = historyRate(career, "top3");
  return current !== null && baseline !== null ? current - baseline : null;
}

export function roleRanks(horses: Horse[], role: RoleKey, ready: boolean): Map<number, number> {
  if (!ready || !horses.length) return new Map();
  const key = { first: "firstProbability", second: "secondProbability", third: "thirdProbability" } as const;
  if (horses.some(h => !finite(h[key[role]]) || h[key[role]]! < 0 || h[key[role]]! > 1)) return new Map();
  return new Map(roleOrder(horses, role).map((horse, index) => [horse.number, index + 1]));
}

export function filterHorses(horses: Horse[], options: {
  query: string; filter: HorseFilter; sort: HorseSort; role: RoleKey;
  selected: number[]; rolesReady: boolean; overallReady: boolean;
}): Horse[] {
  const ranks = roleRanks(horses, options.role, options.rolesReady);
  const sortRanks = options.sort === "first" || options.sort === "second" || options.sort === "third"
    ? roleRanks(horses, options.sort, options.rolesReady) : new Map<number, number>();
  const overallRanks = new Map(horses.map((horse, index) => [horse.number, index + 1]));
  const query = options.query.trim().normalize("NFKC").toLocaleLowerCase("ja");
  const value = (horse: Horse): number | null => {
    if (options.sort === "number") return horse.number;
    if (options.sort === "popularity") return finite(horse.popularity) && horse.popularity > 0 ? horse.popularity : null;
    if (options.sort === "overall") return options.overallReady ? overallRanks.get(horse.number) ?? null : null;
    return sortRanks.get(horse.number) ?? null;
  };
  return horses.filter(horse => {
    if (query && !`${horse.number} ${horse.name} ${horse.jockey ?? ""}`.normalize("NFKC").toLocaleLowerCase("ja").includes(query)) return false;
    if (options.filter === "selected") return options.selected.includes(horse.number);
    if (options.filter === "longshot") return horse.popularity >= 4 && (ranks.get(horse.number) ?? Infinity) <= 5;
    if (options.filter === "top5") return (ranks.get(horse.number) ?? Infinity) <= 5;
    return true;
  }).sort((a, b) => (value(a) ?? Infinity) - (value(b) ?? Infinity) || a.number - b.number);
}

export const percent = (value: number | null) => value === null ? "未取得" : `${value.toFixed(1)}%`;
export const pointsDifference = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)}pt`;
