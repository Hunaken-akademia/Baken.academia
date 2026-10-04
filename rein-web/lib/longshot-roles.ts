import { roleOrder, type MarkHorse, type RoleKey } from "./marks";

export type LongshotRoleResult<T> = {
  status: "ready" | "unavailable";
  reason?: string;
  candidates: { horse: T; overallRank: number; outsiderRank: number }[];
};

// A view of existing model ranks, not a new model or calibrated probability.
export function longshotRoleOrder<T extends MarkHorse>(
  horses: T[], role: RoleKey, minPopularity: 4 | 6 | 10 = 4,
): LongshotRoleResult<T> {
  if (!horses.length || horses.some(h => !Number.isInteger(h.popularity) || h.popularity < 1 || h.popularity > horses.length)
    || new Set(horses.map(h => h.popularity)).size !== horses.length) {
    return { status: "unavailable", reason: "全頭の人気順位がそろっていないため、比較を保留しています。", candidates: [] };
  }
  const order = roleOrder(horses, role);
  if (order.length !== horses.length) {
    return { status: "unavailable", reason: "この着順の適性が全頭そろっていないため、比較を保留しています。", candidates: [] };
  }
  return { status: "ready", candidates: order.map((horse, index) => ({ horse, overallRank: index + 1 }))
    .filter(({ horse }) => horse.popularity >= minPopularity).slice(0, 3)
    .map((candidate, index) => ({ ...candidate, outsiderRank: index + 1 })) };
}
