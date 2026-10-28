// "条件でレースを探す": sort the day's races into 固め / 中穴 / 荒れそう from how
// spread out the win market is. Effective contenders = exp(entropy) of the
// normalized implied win probabilities (1 = one certain horse, N = all equal).
// Cut-offs were fixed on authentic prestart odds (2026-09-27/28 to 10-12/13)
// and audited on the following two weeks; see docs/validation/race-finder-20261028.md.

export type RaceKind = "solid" | "middle" | "rough";
export type League = "jra" | "nar";

export const RACE_KINDS: Record<RaceKind, { label: string; hitLabel: string; description: string }> = {
  solid: { label: "固め", hitLabel: "万馬券にならず", description: "人気が上位数頭に集中。3連単が万馬券になりにくいレース" },
  middle: { label: "中穴", hitLabel: "3連単30倍以上", description: "人気がほどよく割れたレース" },
  rough: { label: "荒れそう", hitLabel: "3連単万馬券", description: "人気が多くの馬に割れ、高配当になりやすいレース" },
};
export const KIND_ORDER: RaceKind[] = ["solid", "middle", "rough"];

// [固め以下, 荒れそう以上] in effective contenders.
export const FINDER_CUTS: Record<League, [number, number]> = { nar: [5.16, 6.57], jra: [6.51, 8.84] };

type Reference = { races: number; hits: number; jackpots: number; cheap: number; median: number };
// Held-out audit with the cut-offs above. Trifecta payouts per 100 yen.
export const FINDER_REFERENCE: Record<League, { period: string; total: number; jackpots: number; kinds: Record<RaceKind, Reference> }> = {
  nar: {
    period: "2026/10/14〜10/28", total: 686, jackpots: 319,
    kinds: {
      solid: { races: 272, hits: 197, jackpots: 75, cheap: 118, median: 3900 },
      middle: { races: 186, hits: 147, jackpots: 76, cheap: 39, median: 7130 },
      rough: { races: 228, hits: 168, jackpots: 168, cheap: 8, median: 21260 },
    },
  },
  jra: {
    period: "2026/10/17〜10/25", total: 140, jackpots: 103,
    kinds: {
      solid: { races: 46, hits: 25, jackpots: 21, cheap: 11, median: 9340 },
      middle: { races: 54, hits: 54, jackpots: 46, cheap: 0, median: 26295 },
      rough: { races: 40, hits: 36, jackpots: 36, cheap: 0, median: 38035 },
    },
  },
};

export function effectiveContenders(odds: Array<number | null | undefined>): number | null {
  if (odds.length < 5 || odds.some(o => typeof o !== "number" || !Number.isFinite(o) || o < 1)) return null;
  const inverse = (odds as number[]).map(o => 1 / o), total = inverse.reduce((s, v) => s + v, 0);
  const entropy = inverse.reduce((s, v) => { const p = v / total; return s - p * Math.log(p); }, 0);
  return Math.exp(entropy);
}

export function classifyRace(league: League, odds: Array<number | null | undefined>): { kind: RaceKind; effective: number } | null {
  const effective = effectiveContenders(odds);
  if (effective === null) return null;
  const [solid, rough] = FINDER_CUTS[league];
  return { kind: effective <= solid ? "solid" : effective < rough ? "middle" : "rough", effective };
}

export function finderHit(kind: RaceKind, trifecta: number) {
  return kind === "solid" ? trifecta < 10_000 : kind === "middle" ? trifecta >= 3_000 : trifecta >= 10_000;
}

type Payout = { type?: string; payout?: number; selection?: string; popularity?: number | null };
export function trifectaResult(payouts: unknown): { payout: number; selection: string; popularity: number | null } | null {
  if (!Array.isArray(payouts)) return null;
  const hit = (payouts as Payout[]).find(p => p?.type === "三連単" || p?.type === "3連単");
  return hit && typeof hit.payout === "number" && Number.isFinite(hit.payout) && hit.payout > 0
    ? { payout: hit.payout, selection: String(hit.selection ?? ""), popularity: typeof hit.popularity === "number" ? hit.popularity : null }
    : null;
}

export type FinderRow = {
  raceId: string; venue: string; number: number; start: string; startsAt: number | null; title: string; course: string;
  kind: RaceKind | null; effective: number | null; field: number; favorite: { name: string; odds: number } | null; oddsAt: string | null;
  // Finished races are judged only when the odds come from the saved prestart forecast.
  result: { payout: number; selection: string; popularity: number | null } | null; verified: boolean;
};
export type RaceFinder = { date: string; league: League; generatedAt: string; rows: FinderRow[]; error?: string };

type Horse = { name?: string; odds?: number | null; number?: number };
export function finderRow(raceId: string, league: League, venue: string, payload: Record<string, any>): FinderRow {
  const race = payload.race ?? {}, horses: Horse[] = Array.isArray(payload.horses) ? payload.horses : [];
  const classified = classifyRace(league, horses.map(h => h.odds));
  const favorite = classified ? horses.reduce<Horse | null>((best, h) => !best || (h.odds as number) < (best.odds as number) ? h : best, null) : null;
  const prediction = payload.prediction ?? {}, startsAt = typeof race.startsAt === "number" ? race.startsAt : null;
  const verified = prediction.source === "prestart" && startsAt !== null && Date.parse(prediction.generatedAt) < startsAt;
  return {
    raceId, venue, number: Number(raceId.slice(-2)), start: String(race.start ?? ""), startsAt,
    title: String(race.title ?? ""), course: String(race.course ?? ""),
    kind: classified?.kind ?? null, effective: classified ? Math.round(classified.effective * 100) / 100 : null, field: horses.length,
    favorite: favorite ? { name: String(favorite.name ?? ""), odds: favorite.odds as number } : null,
    oddsAt: race.dataTimes?.odds ?? prediction.generatedAt ?? null,
    result: payload.review?.isFinished ? trifectaResult(payload.review.payouts) : null, verified,
  };
}
