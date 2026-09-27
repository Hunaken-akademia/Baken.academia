import { getVercelOidcToken } from "@vercel/oidc";
import { getCache } from "@vercel/functions";
import { SUPABASE_URL } from "./supabase/config";
import type { SharedJournal } from "./prediction-journal";
import type { SnapshotMeta } from "./analysis-cache";

const brokerUrl = `${SUPABASE_URL}/functions/v1/rein-server-data`;
const historyCache = getCache({ namespace: "rein-history-display-v1" });
export type StoredSnapshot = { payload: Record<string, any>; generated_at: string; starts_at: string | null; is_final: boolean; slot: string; captured_at: string };
export async function serverData<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const token = await getVercelOidcToken();
  if (!token) throw new Error("Server identity unavailable");
  const response = await fetch(brokerUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ action, ...params }), cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Snapshot store ${response.status}`);
  return await response.json() as T;
}
export const storedSnapshot = (raceId: string, slot: "live" | "preview" | "prestart") => serverData<{ snapshot: StoredSnapshot | null }>("read", { raceId, slot });
export const saveSnapshot = (payload: unknown, preview: boolean) => serverData<{ saved: boolean }>("save", { payload, preview });
export async function durableMetas(date: string) {
  const { snapshots } = await serverData<{ snapshots: Array<Omit<StoredSnapshot,"payload"> & { race_id: string }> }>("metas", { date });
  return new Map(snapshots.map(s => [`${s.slot}:${s.race_id}`, { generatedAt: s.generated_at, startsAt: s.starts_at ? Date.parse(s.starts_at) : null, final: s.is_final, preview: s.slot === "preview" } satisfies SnapshotMeta]));
}
export async function raceHistory(raceId: string) {
  const key = `race:${raceId}`;
  const cached = await historyCache.get(key).catch(() => null);
  if (cached && typeof cached === "object") return cached as SharedJournal;
  const result = await serverData<SharedJournal>("history", { raceId });
  await historyCache.set(key, result, { ttl: 60 }).catch(() => {});
  return result;
}
export function dateJst(offsetDays = 0, now = Date.now()) { return new Date(now + 9 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0,10); }
export const claimCapture = (key: string, ttl = 180) => serverData<{ acquired: boolean; token: string | null }>("claim", { key, ttl });
export const releaseCapture = (key: string, token: string) => serverData("release", { key, token });
