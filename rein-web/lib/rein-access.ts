export type ReinPlan = "nar" | "jra" | "all";
export type ReinArea = "nar" | "jra";

type ReinMembership = {
  member_key: string;
  google_email: string;
  plan: ReinPlan;
  status: "active" | "paused" | "cancelled";
  access_starts_at: string;
  access_ends_at: string | null;
  free_period_ends_at: string;
};

export const REIN_PLANS: Record<ReinPlan, {
  name: string;
  shortName: string;
  monthlyPriceYen: number;
  canJra: boolean;
  canNar: boolean;
}> = {
  nar: {
    name: "REIN 地方競馬",
    shortName: "地方競馬",
    monthlyPriceYen: 1000,
    canJra: false,
    canNar: true,
  },
  jra: {
    name: "REIN 中央競馬",
    shortName: "中央競馬",
    monthlyPriceYen: 1000,
    canJra: true,
    canNar: false,
  },
  all: {
    name: "REIN オール",
    shortName: "地方＋中央",
    monthlyPriceYen: 1500,
    canJra: true,
    canNar: true,
  },
};

export function hasActiveReinAccess(
  membership: ReinMembership | null | undefined,
  now = new Date(),
) {
  if (!membership || membership.status !== "active") return false;
  const starts = new Date(membership.access_starts_at);
  if (Number.isNaN(starts.getTime()) || now < starts) return false;
  if (membership.access_ends_at) {
    const ends = new Date(membership.access_ends_at);
    if (!Number.isNaN(ends.getTime()) && now >= ends) return false;
  }
  return true;
}

export function canAccessReinArea(
  membership: ReinMembership | null | undefined,
  area: ReinArea,
  now = new Date(),
) {
  if (!hasActiveReinAccess(membership, now)) return false;
  if (membership!.plan === "all") return true;
  return membership!.plan === area;
}

export function homeForReinPlan(plan: ReinPlan) {
  if (plan === "jra") return "/jra";
  if (plan === "nar") return "/nar";
  return "/";
}

export type { ReinMembership };
