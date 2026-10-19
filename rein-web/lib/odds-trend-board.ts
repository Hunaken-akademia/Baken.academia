import { TREND_RULES,type TrendItem,type TrendRule } from "./odds-trends";
import { NAR_COURSES } from "./nar-source";

// Day board: every race of the day that a condition can still apply to, so members can
// find matching tickets without opening each race. Tickets are only looked up near post time.
export const BOARD_LOOKUP_MINUTES = 75;
export type BoardPhase = "scheduled" | "provisional" | "saved-prestart" | "historical" | "unavailable";
export type BoardRace = { raceId: string; venue: string; number: number; start: string; title: string; course: string; phase: BoardPhase; items: TrendItem[] };
export type OddsTrendBoard = { date: string; league: "jra" | "nar"; version: string; generatedAt: string; races: BoardRace[]; error?: string };
type ScheduleRace = { number?: number; start?: string; raceId?: string; title?: string; course?: string };

const JRA_VENUES: Record<string,string> = {"01":"札幌","02":"函館","03":"福島","04":"新潟","05":"東京","06":"中山","07":"中京","08":"京都","09":"阪神","10":"小倉"};
export function venueOfRace(raceId: string, league: "jra" | "nar") {
  return league === "jra" ? JRA_VENUES[raceId.slice(2,4)] : NAR_COURSES[raceId.slice(8,10)];
}
export const isVenueRule = (rule: TrendRule) => typeof rule.conditions.venue === "string";
// Only the venue is known from the schedule; every other condition is decided from the race card and odds.
export function candidateRules(raceId: string, league: "jra" | "nar") {
  const venue = venueOfRace(raceId, league);
  return TREND_RULES.filter(rule => rule.league === league && (!isVenueRule(rule) || rule.conditions.venue === venue));
}
export function startsAtJst(date: string, start: string) {
  return /^\d{1,2}:\d{2}$/.test(start) ? Date.parse(`${date}T${start.padStart(5,"0")}:00+09:00`) : null;
}
export function scheduledBoardRaces(date: string, league: "jra" | "nar", races: ScheduleRace[]) {
  return races.flatMap(race => {
    const raceId = race.raceId ?? "", start = race.start ?? "";
    if (!/^\d{10}(?:\d{2})?$/.test(raceId) || (league === "nar") !== (raceId.length === 12)) return [];
    const rules = candidateRules(raceId, league);
    if (!rules.length) return [];
    return [{ raceId, venue: venueOfRace(raceId, league) ?? "", number: Number(race.number) || Number(raceId.slice(-2)), start, title: race.title ?? "", course: race.course ?? "", startsAt: startsAtJst(date, start), rules }];
  }).sort((a,b) => (a.startsAt ?? Infinity) - (b.startsAt ?? Infinity) || a.raceId.localeCompare(b.raceId));
}
export const needsLookup = (startsAt: number | null, now: number) => startsAt === null || startsAt - now <= BOARD_LOOKUP_MINUTES * 60_000;
export const readyItems = (race: BoardRace) => race.items.filter(item => item.state === "ready" && item.selections.length > 0);
