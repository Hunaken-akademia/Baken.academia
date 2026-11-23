import type { Ticket } from "./tickets";
import type { RacePayout } from "./payouts";

const betName = (value: string) => value.replace(/三/g, "3");
function selectionKey(value: string, ordered: boolean) {
  const numbers = (value.match(/\d+/g) ?? []).map(Number);
  return (ordered ? numbers : numbers.sort((a,b) => a-b)).join("-");
}
export function referenceResults(tickets: Ticket[], finished: boolean, payouts: RacePayout[], excluded = false) {
  return tickets.flatMap(ticket => ticket.tiers.filter(tier => tier.selections.length).map(tier => {
    const type = betName(ticket.type), ordered = type === "馬単" || type === "3連単";
    const results = payouts.filter(p => betName(p.type) === type);
    const hits = results.filter(p => tier.selections.some(s => selectionKey(s, ordered) === selectionKey(p.selection, ordered)));
    return { type: ticket.type, group: tier.group, selections: tier.selections,
      status: excluded ? "excluded" : !finished ? "pending" : !results.length ? "unavailable" : hits.length ? "hit" : "miss",
      returnYen: hits.reduce((sum,p) => sum+p.payout,0), hits: hits.map(p => p.selection) };
  }));
}
export type ReferenceLine = ReturnType<typeof referenceResults>[number];
export type ReferenceRace = { raceId: string; title: string; venue: string; number: number; start: string; startsAt: number | null; saved: boolean; finished: boolean; lines: ReferenceLine[] };
export type ReferenceBoard = { races: ReferenceRace[]; error?: string };

export function filterReferenceRaces(races: ReferenceRace[], filters: { venue: string; type: string; group: string; hitsOnly: boolean }) {
  return races.filter(race => !filters.venue || race.venue === filters.venue).map(race => ({
    ...race,
    lines: race.lines.filter(line => (!filters.type || line.type === filters.type)
      && (!filters.group || line.group === filters.group) && (!filters.hitsOnly || line.status === "hit")),
  })).filter(race => race.lines.length > 0 || (!filters.type && !filters.group && !filters.hitsOnly));
}
