export type TicketHorse = {
  number: number;
  gate: number;
  popularity: number;
  odds: number;
  reinScore: number;
  marketScore: number;
};

export type TicketTier = { group: "本線" | "対抗" | "穴"; points: number; selections: string[] };
export type Ticket = { type: string; tiers: TicketTier[] };

const caps: Record<string, [number, number, number]> = {
  単勝: [1, 1, 2], 複勝: [1, 1, 2], 枠連: [3, 4, 5], 馬連: [5, 6, 8],
  ワイド: [4, 5, 7], 馬単: [8, 10, 12], 三連複: [10, 12, 15], 三連単: [15, 22, 30],
};

function combinations(values: number[], size: number): number[][] {
  const out: number[][] = [];
  const walk = (start: number, current: number[]) => {
    if (current.length === size) { out.push([...current]); return; }
    for (let index = start; index < values.length; index += 1) walk(index + 1, [...current, values[index]]);
  };
  walk(0, []);
  return out;
}

function permutations(values: number[], size: number): number[][] {
  if (size === 1) return values.map((value) => [value]);
  return values.flatMap((value) => permutations(values.filter((candidate) => candidate !== value), size - 1)
    .map((tail) => [value, ...tail]));
}

function candidates(type: string, horses: TicketHorse[]): string[] {
  const numbers = horses.map((horse) => horse.number);
  if (type === "単勝" || type === "複勝") return numbers.map(String);
  if (type === "枠連") {
    const gates = [...new Set(horses.map((horse) => horse.gate))];
    return combinations(gates, 2).map((pair) => pair.join("-"));
  }
  if (type === "馬連" || type === "ワイド") return combinations(numbers, 2).map((pair) => pair.join("-"));
  if (type === "馬単") return permutations(numbers, 2).map((pair) => pair.join("→"));
  if (type === "三連複") return combinations(numbers, 3).map((trio) => trio.join("-"));
  return permutations(numbers, 3).map((trio) => trio.join("→"));
}

export function buildTickets(horses: TicketHorse[]): Ticket[] {
  const market = [...horses].sort((a, b) => a.popularity - b.popularity);
  const counter = [...horses].sort((a, b) =>
    (0.75 * b.marketScore + 0.25 * b.reinScore) - (0.75 * a.marketScore + 0.25 * a.reinScore));
  const longshot = [...horses].sort((a, b) =>
    (0.5 * b.marketScore + 0.5 * b.reinScore + Math.min(8, Math.log1p(b.odds))) -
    (0.5 * a.marketScore + 0.5 * a.reinScore + Math.min(8, Math.log1p(a.odds))));
  const rankings = [market, counter, longshot];
  const groups: TicketTier["group"][] = ["本線", "対抗", "穴"];

  return Object.entries(caps).map(([type, pointCaps]) => {
    const used = new Set<string>();
    const tiers = rankings.map((ranking, index) => {
      const primary = candidates(type, ranking.slice(0, Math.min(ranking.length, type === "三連単" ? 7 : 6)));
      const fallback = candidates(type, ranking);
      const selections = [...primary, ...fallback]
        .filter((selection, position, all) => all.indexOf(selection) === position)
        .filter((selection) => !used.has(selection))
        .slice(0, pointCaps[index]);
      selections.forEach((selection) => used.add(selection));
      return { group: groups[index], points: selections.length, selections };
    });
    return { type, tiers };
  });
}
