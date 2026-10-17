export const THIRD_SUPPORT_VERSION = "hanshin-good-third-support-20261017-v1";

type RoleRunner = {
  horse_number: number;
  first_probability: number;
  second_probability: number;
  third_probability: number;
  third_probability_before_support?: number;
};
export type RoleAdjustment = { version: string; label: string; experimental: true };
type Score = { version?: string; runners?: RoleRunner[]; roleAdjustment?: RoleAdjustment };

/** Apply once to newly computed JRA scores; never rewrite saved past predictions. */
export function applyJraRoleAdjustment<T extends Score>(
  score: T,
  race: { racecourse: string; surface: string; going: string },
  hasScratches = false,
): T {
  const runners = score.runners;
  if (score.roleAdjustment || hasScratches || race.racecourse !== "阪神" || race.going !== "良"
      || !["芝", "ダート"].includes(race.surface) || !runners || runners.length < 6
      || new Set(runners.map(r => r.horse_number)).size !== runners.length
      || runners.some(r => !Number.isInteger(r.horse_number) || r.horse_number < 1
        || [r.first_probability, r.second_probability, r.third_probability].some(v => !Number.isFinite(v) || v < 0))) return score;
  const secondTotal = runners.reduce((sum, r) => sum + r.second_probability, 0);
  const thirdTotal = runners.reduce((sum, r) => sum + r.third_probability, 0);
  if (!(secondTotal > 0 && thirdTotal > 0) || !Number.isFinite(secondTotal) || !Number.isFinite(thirdTotal)) return score;
  return {
    ...score,
    version: `${score.version || "REIN"}+${THIRD_SUPPORT_VERSION}`,
    roleAdjustment: { version: THIRD_SUPPORT_VERSION, label: "阪神・良馬場の3着評価補助", experimental: true },
    runners: runners.map(r => ({
      ...r,
      third_probability_before_support: r.third_probability,
      third_probability: .75 * r.third_probability / thirdTotal + .25 * r.second_probability / secondTotal,
    })),
  };
}
