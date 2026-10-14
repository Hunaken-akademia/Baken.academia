export type PerformanceRace = {
  raceId: string;
  date: string;
  title: string;
  generatedAt: string;
  picks: { main: number | null; rival: number | null; longshot: number | null } | null;
  tickets: Array<{ type: string; tiers: Array<{ group: string; selections: string[] }> }> | null;
  final: boolean;
  finishers: Array<{ number: number; finish: number }>;
  payouts: Array<{ type: string; selection: string; payout: number }>;
  scratched: number;
};

export type MarkKey = "main" | "rival" | "longshot";
export type MarkStats = { key: MarkKey; label: string; races: number; wins: number; top2: number; top3: number; winReturn: number; placeReturn: number };
export type TicketStats = { races: number; points: number; hitRaces: number; stake: number; returned: number };
export type TicketTypeStats = { type: string; tiers: Record<string, TicketStats>; total: TicketStats };
export type PerformanceSummary = {
  from: string | null;
  to: string | null;
  saved: number;
  counted: number;
  excluded: { pending: number; scratched: number; noPayout: number };
  marks: MarkStats[];
  tickets: TicketTypeStats[];
};

export const MARK_LABELS: Record<MarkKey, string> = { main: "本命", rival: "対抗", longshot: "穴候補" };
export const TICKET_GROUPS = ["本線", "対抗", "穴"] as const;
const STAKE = 100;
const ORDERED = new Set(["馬単", "3連単"]);

export function ticketTypeKey(type: string) {
  return type.replace(/^三連/, "3連");
}

function selectionKey(type: string, selection: string) {
  const numbers = selection.split(/[-→>＞－]/).map((part) => Number(part.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (!numbers.length) return "";
  return (ORDERED.has(ticketTypeKey(type)) ? numbers : [...numbers].sort((a, b) => a - b)).join("-");
}

const emptyTicket = (): TicketStats => ({ races: 0, points: 0, hitRaces: 0, stake: 0, returned: 0 });

// Only races with a pre-start prediction, a confirmed result, published payouts and no scratched runner are scored.
export function summarizePerformance(races: PerformanceRace[]): PerformanceSummary {
  const excluded = { pending: 0, scratched: 0, noPayout: 0 };
  const counted: PerformanceRace[] = [];
  for (const race of races) {
    if (!race.final || ![1, 2, 3].every((finish) => race.finishers.some((item) => item.finish === finish))) excluded.pending++;
    else if (race.scratched > 0) excluded.scratched++;
    else if (!race.payouts.length) excluded.noPayout++;
    else counted.push(race);
  }
  const marks = (Object.keys(MARK_LABELS) as MarkKey[]).map((key) => {
    const stats: MarkStats = { key, label: MARK_LABELS[key], races: 0, wins: 0, top2: 0, top3: 0, winReturn: 0, placeReturn: 0 };
    for (const race of counted) {
      const number = race.picks?.[key];
      if (!number) continue;
      stats.races++;
      const finish = race.finishers.find((item) => item.number === number)?.finish ?? 99;
      if (finish === 1) stats.wins++;
      if (finish <= 2) stats.top2++;
      if (finish <= 3) stats.top3++;
      for (const payout of race.payouts) {
        if (selectionKey(payout.type, payout.selection) !== String(number)) continue;
        if (payout.type === "単勝") stats.winReturn += payout.payout;
        if (payout.type === "複勝") stats.placeReturn += payout.payout;
      }
    }
    return stats;
  });
  const byType = new Map<string, TicketTypeStats>();
  for (const race of counted) {
    if (!race.tickets) continue;
    for (const ticket of race.tickets) {
      const type = ticketTypeKey(ticket.type);
      const payouts = race.payouts.filter((payout) => ticketTypeKey(payout.type) === type);
      // A bet type that was not sold for this race (e.g. 枠連 in a small field) has no payout rows; skip it.
      if (!payouts.length) continue;
      const paid = new Map<string, number>();
      for (const payout of payouts) {
        const key = selectionKey(type, payout.selection);
        paid.set(key, (paid.get(key) ?? 0) + payout.payout);
      }
      const stats = byType.get(type) ?? { type, tiers: Object.fromEntries(TICKET_GROUPS.map((group) => [group, emptyTicket()])), total: emptyTicket() };
      byType.set(type, stats);
      let totalPoints = 0, totalReturn = 0;
      for (const tier of ticket.tiers) {
        const selections = [...new Set(tier.selections.map((selection) => selectionKey(type, selection)).filter(Boolean))];
        if (!selections.length || !stats.tiers[tier.group]) continue;
        const returned = selections.reduce((sum, key) => sum + (paid.get(key) ?? 0), 0);
        const target = stats.tiers[tier.group];
        target.races++; target.points += selections.length; target.stake += selections.length * STAKE; target.returned += returned;
        if (returned > 0) target.hitRaces++;
        totalPoints += selections.length; totalReturn += returned;
      }
      if (!totalPoints) continue;
      stats.total.races++; stats.total.points += totalPoints; stats.total.stake += totalPoints * STAKE; stats.total.returned += totalReturn;
      if (totalReturn > 0) stats.total.hitRaces++;
    }
  }
  const order = ["単勝", "複勝", "枠連", "馬連", "ワイド", "馬単", "3連複", "3連単"];
  const rank = (type: string) => { const index = order.indexOf(type); return index < 0 ? order.length : index; };
  const dates = counted.map((race) => race.date).sort();
  return {
    from: dates[0] ?? null,
    to: dates.at(-1) ?? null,
    saved: races.length,
    counted: counted.length,
    excluded,
    marks,
    tickets: [...byType.values()].sort((a, b) => rank(a.type) - rank(b.type)),
  };
}

export const PERFORMANCE_PERIODS = [7, 30, 90] as const;
export type PerformancePeriod = (typeof PERFORMANCE_PERIODS)[number];

export function performanceRange(days: PerformancePeriod, now = Date.now()) {
  const jst = (offset: number) => new Date(now + 9 * 3600_000 - offset * 86400_000).toISOString().slice(0, 10);
  return { from: jst(days - 1), to: jst(0) };
}

export function rate(part: number, whole: number) {
  return whole ? part / whole : null;
}
