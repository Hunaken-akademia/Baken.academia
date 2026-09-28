import type { SnapshotMeta } from "./analysis-cache";

// Only future forecasts may be refreshed after a model release. Stored prestart
// predictions for a race that has already started remain the audit source.
export function expireNarReleaseMetas(metas:Map<string,SnapshotMeta|null>, activatedAt:string, now:number) {
  const activated=Date.parse(activatedAt);
  if(!Number.isFinite(activated))return;
  for(const [key,meta] of metas) {
    if(!/^(live|preview):\d{12}$/.test(key) || !meta || meta.final || meta.startsAt===null || meta.startsAt<=now)continue;
    if(Date.parse(meta.generatedAt)<activated)metas.delete(key);
  }
}
