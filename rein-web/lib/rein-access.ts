type ReinMembership = {
  member_key: string;
  google_email: string;
  plan: string;
  status: "active" | "paused" | "cancelled";
  access_starts_at: string;
  access_ends_at: string | null;
  free_period_ends_at: string;
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

export type { ReinMembership };
