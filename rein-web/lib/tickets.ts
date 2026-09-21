export type TicketHorse = {
  number: number; gate: number; popularity: number; odds: number | null; reinScore: number; marketScore: number;
  firstProbability?: number; secondProbability?: number; thirdProbability?: number;
};
export type TicketTier = { group: "本線" | "対抗" | "穴"; points: number; selections: string[] };
export type Ticket = { type: string; tiers: TicketTier[] };

const caps: Record<string, [number, number, number]> = {
  単勝: [1, 1, 1], 複勝: [1, 1, 1], 枠連: [3, 4, 4], 馬連: [5, 6, 6],
  ワイド: [4, 5, 5], 馬単: [8, 10, 10], 三連複: [10, 12, 12], 三連単: [15, 22, 22],
};
type RoleHorse = TicketHorse & { first: number; second: number; third: number };
type Candidate = { selection: number[]; probability: number };

function normalize(values: number[]) {
  const safe = values.map((value) => Math.max(Number.isFinite(value) ? value : 0, 1e-9));
  const total = safe.reduce((sum, value) => sum + value, 0);
  return safe.map((value) => value / total);
}

function roleProbabilities(horses: TicketHorse[]): RoleHorse[] {
  const fallback = Math.max(...horses.map((horse) => horse.popularity || 0), horses.length) + 1;
  const market = normalize(horses.map((horse) => 1 / Math.max(horse.popularity || fallback, 1)));
  const learned = {
    first: normalize(horses.map((horse) => horse.firstProbability ?? horse.reinScore)),
    second: normalize(horses.map((horse) => horse.secondProbability ?? horse.reinScore)),
    third: normalize(horses.map((horse) => horse.thirdProbability ?? horse.reinScore)),
  };
  const blended = (role: keyof typeof learned, index: number) => .70 * market[index] + .30 * learned[role][index];
  return horses.map((horse, index) => ({ ...horse, first: blended("first", index), second: blended("second", index), third: blended("third", index) }));
}

function add(values: Map<string, Candidate>, selection: number[], probability: number) {
  const key = selection.join("-");
  const existing = values.get(key);
  if (existing) existing.probability += probability;
  else values.set(key, { selection, probability });
}

function candidates(horses: TicketHorse[]) {
  let roles = roleProbabilities(horses);
  if (roles.length > 9) {
    roles = [...roles].sort((a, b) => Math.max(b.first, b.second, b.third) - Math.max(a.first, a.second, a.third)).slice(0, 9);
    const first = normalize(roles.map((horse) => horse.first));
    const second = normalize(roles.map((horse) => horse.second));
    const third = normalize(roles.map((horse) => horse.third));
    roles = roles.map((horse, index) => ({ ...horse, first: first[index], second: second[index], third: third[index] }));
  }
  const values = Object.fromEntries(Object.keys(caps).map((type) => [type, new Map<string, Candidate>()])) as Record<string, Map<string, Candidate>>;
  for (const horse of roles) {
    add(values.単勝, [horse.number], horse.first);
    add(values.複勝, [horse.number], horse.first + horse.second + horse.third);
  }
  for (const first of roles) for (const second of roles) {
    if (first.number === second.number) continue;
    const probability = first.first * second.second / Math.max(1 - first.second, 1e-12);
    add(values.馬単, [first.number, second.number], probability);
    add(values.馬連, [first.number, second.number].sort((a, b) => a - b), probability);
    if (first.gate !== second.gate) add(values.枠連, [first.gate, second.gate].sort((a, b) => a - b), probability);
  }
  for (const first of roles) for (const second of roles) for (const third of roles) {
    if (new Set([first.number, second.number, third.number]).size < 3) continue;
    const probability = first.first * second.second / Math.max(1 - first.second, 1e-12)
      * third.third / Math.max(1 - first.third - second.third, 1e-12);
    add(values.三連単, [first.number, second.number, third.number], probability);
    add(values.三連複, [first.number, second.number, third.number].sort((a, b) => a - b), probability);
    add(values.ワイド, [first.number, second.number].sort((a, b) => a - b), probability);
    add(values.ワイド, [first.number, third.number].sort((a, b) => a - b), probability);
    add(values.ワイド, [second.number, third.number].sort((a, b) => a - b), probability);
  }
  return values;
}

export function buildTickets(horses: TicketHorse[]): Ticket[] {
  const values = candidates(horses);
  const groups: TicketTier["group"][] = ["本線", "対抗", "穴"];
  return Object.entries(caps).map(([type, pointCaps]) => {
    let remaining = [...values[type].values()].sort((a, b) => b.probability - a.probability);
    const tiers = groups.map((group, index) => {
      const picked = remaining.slice(0, pointCaps[index]);
      remaining = remaining.slice(picked.length);
      return { group, points: picked.length, selections: picked.map((item) => item.selection.join("-")) };
    });
    return { type, tiers };
  });
}

export function compactSelections(selections: string[]): string[] {
  const output: string[] = [];
  const groups = new Map<string, string[]>();
  for (const selection of selections) {
    const parts = selection.split("-");
    if (parts.length < 2) { output.push(selection); continue; }
    const prefix = parts.slice(0, -1).join("-");
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push(parts[parts.length - 1]);
  }
  for (const [prefix, endings] of groups) output.push(`${prefix}-${[...new Set(endings)].join(".")}`);
  return output;
}
