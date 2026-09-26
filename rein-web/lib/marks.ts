// 本命・対抗・穴候補 selection. It only reads the role-model output; it never reorders
// the overall ranking and never feeds the ticket builder.

export type RoleKey = "first" | "second" | "third";

export type MarkHorse = {
  number: number;
  popularity: number;
  firstProbability?: number;
  secondProbability?: number;
  thirdProbability?: number;
  marketFirstProbability?: number | null;
  reinMarketFirstProbability?: number | null;
};

const PROBABILITY: Record<RoleKey, "firstProbability" | "secondProbability" | "thirdProbability"> = {
  first: "firstProbability",
  second: "secondProbability",
  third: "thirdProbability",
};

// Canonical role ranking shared by the API (card selection) and the screen (ranking
// tab). Ordered by the model probability; ties keep the incoming order (the overall
// ranking), which is Array.prototype.sort's stable behaviour.
export function roleOrder<T extends MarkHorse>(horses: T[], role: RoleKey): T[] {
  const key = PROBABILITY[role];
  return [...horses]
    .filter((horse) => Number.isFinite(horse[key]))
    .sort((a, b) => (b[key] as number) - (a[key] as number));
}

// Existing REIN definition of 人気薄: the 注目候補 panel and the trifecta longshot score
// both treat 4th favourite or lower as outside the popular group (1〜3番人気).
export const LONGSHOT_MIN_POPULARITY = 4;
export const LONGSHOT_ROLE_RANKS = [3, 6] as const;

export type MarkPick = {
  number: number;
  role: "本命" | "対抗" | "穴候補";
  firstRank: number;
  // Only for 穴候補: REIN first-place probability / market-model first-place probability.
  marketRatio?: number;
};

export type Picks = {
  status: "ready" | "unavailable";
  reason?: string;
  main: MarkPick | null;
  rival: MarkPick | null;
  longshot: MarkPick | null;
  longshotStatus: "selected" | "none" | "unavailable";
  longshotReason?: string;
};

export function selectPicks(
  horses: MarkHorse[],
  options: { roleModelReady: boolean; marketReady: boolean },
): Picks {
  const empty = { main: null, rival: null, longshot: null } as const;
  if (!options.roleModelReady) {
    return {
      status: "unavailable",
      reason: "1着適性モデルの結果を取得できないため、印の選定を保留しています",
      ...empty,
      longshotStatus: "unavailable",
    };
  }
  const order = roleOrder(horses, "first");
  if (order.length !== horses.length || order.length < 2) {
    return {
      status: "unavailable",
      reason: "1着適性が全頭そろっていないため、印の選定を保留しています",
      ...empty,
      longshotStatus: "unavailable",
    };
  }
  const main: MarkPick = { number: order[0].number, role: "本命", firstRank: 1 };
  const rival: MarkPick = { number: order[1].number, role: "対抗", firstRank: 2 };
  if (!options.marketReady) {
    return {
      status: "ready", main, rival, longshot: null,
      longshotStatus: "unavailable",
      longshotReason: "人気・市場評価がそろっていないため、穴候補は選定しません",
    };
  }
  const [from, to] = LONGSHOT_ROLE_RANKS;
  for (let rank = from; rank <= Math.min(to, order.length); rank++) {
    const horse = order[rank - 1];
    const market = horse.marketFirstProbability;
    const rein = horse.reinMarketFirstProbability;
    if (!(horse.popularity >= LONGSHOT_MIN_POPULARITY)) continue;
    if (!(typeof market === "number" && typeof rein === "number" && market > 0 && rein > 0)) continue;
    if (!(rein > market)) continue;
    return {
      status: "ready", main, rival,
      longshot: { number: horse.number, role: "穴候補", firstRank: rank, marketRatio: rein / market },
      longshotStatus: "selected",
    };
  }
  return {
    status: "ready", main, rival, longshot: null,
    longshotStatus: "none",
    longshotReason: "1着適性3〜6位に、4番人気以下かつ1着評価が市場を上回る馬がいません",
  };
}
