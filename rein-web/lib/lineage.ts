import type { HistoryFactor } from "./horse-types";

type Rate = { n: number; w: number; t: number; f: number };
type SireProfile = { sire?: Record<string, Rate>; sireDistance?: Record<string, Rate>; sireSurfaceDistance?: Record<string, Rate> };

// Same key as the profile builders: cards and horse pages differ only in spacing.
export const lineageKey = (name?: string) => (name ?? "").normalize("NFKC").replace(/\s+/g, "");

// Yahoo! JRA card cell: "父： ハーツクライ 母：ダストアンドダイヤモンズ (母父：Vindication)".
export function parseCardLineage(text = "") {
  const sire = text.match(/^\s*父[：:]\s*(.*?)\s*母[：:]/)?.[1] ?? "";
  const damSire = text.match(/母父[：:]\s*(.*?)\s*[)）]/)?.[1] ?? "";
  return { ...(sire ? { sire } : {}), ...(damSire ? { damSire } : {}) };
}

// Profile rates are smoothed as (count+1.5)/(n+20) and (top3+4.5)/(n+20).
const counts = (r: Rate) => ({ wins: Math.max(0, Math.round(r.w * (r.n + 20) - 1.5)), top3: Math.max(0, Math.round(r.t * (r.n + 20) - 4.5)) });

// Sire progeny at today's distance band (and surface, when the profile has it),
// compared with all of the sire's progeny.
export function pedigreeFactors(profile: SireProfile, sireName: string | undefined, surface: string | undefined, distanceM: number): HistoryFactor[] {
  const sire = lineageKey(sireName), bucket = Math.floor(distanceM / 200);
  const bySurface = !!profile.sireSurfaceDistance && !!surface;
  const all = sire ? profile.sire?.[sire] : undefined;
  const band = !sire ? undefined : bySurface ? profile.sireSurfaceDistance?.[`${sire}|${surface}|${bucket}`] : profile.sireDistance?.[`${sire}|${bucket}`];
  if (!all || !band) return [];
  const { wins, top3 } = counts(band), overall = counts(all).top3;
  return [{ label: "血統適性", samples: band.n, impact: 0, wins, top3, winRate: Math.round(wins / band.n * 1000) / 10, top3Rate: Math.round(top3 / band.n * 1000) / 10, averageFinish: band.f, baseline: Math.round(overall / all.n * 1000) / 10, subject: `${sireName}産駒・${bySurface ? surface : ""}${bucket * 200}〜${bucket * 200 + 199}m` }];
}

// Exact horse x jockey record [starts, 1st, 2nd, 3rd]. Without a record this is a first ride.
export function pairFactors(record: number[] | undefined): HistoryFactor[] {
  const [starts, wins, seconds, thirds] = record ?? [0, 0, 0, 0];
  const top3 = wins + seconds + thirds, rate = (n: number) => starts ? Math.round(n / starts * 1000) / 10 : 0;
  return [{ label: "騎手相性", samples: starts, impact: 0, wins, top3, winRate: rate(wins), top3Rate: rate(top3), record: `${wins}-${seconds}-${thirds}-${starts - top3}` }];
}
