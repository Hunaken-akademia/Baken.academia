import type { PreviousRun } from "./previous-run";
import type { DayTrends } from "./race-day-trends";
export type RaceContextData = {
  raceId: string; date: string; generatedAt: string; previousFetchedAt: string | null;
  previousRuns: Record<number, PreviousRun | null>; previousError: string | null;
  trends: DayTrends;
};
