export const JRA_TRACK_VENUES = ["札幌", "函館", "福島", "新潟", "東京", "中山", "中京", "京都", "阪神", "小倉"];
export type TrackEntry = { metric: string; kind: string; value?: number; value_min?: number; value_max?: number; segment?: string; distance_from_inner_m?: number; evidence?: string; as_of_date?: string; source_sha256?: string; retrieved_at?: string };
export type TrackMeasurement = { kind: "measurement"; cushion: number | null; cushion_time: string | null; moisture_time: string | null; course: string | null; turf_moisture_goal: number | null; turf_moisture_turn4: number | null; dirt_moisture_goal: number | null; dirt_moisture_turn4: number | null };
export type TrackSandMeasurement = { kind: "sand_measurement"; measured_at: string; published_at: string; going_at_measurement: string; sand_cm_by_segment: Record<string, number[]> };
export type TrackRecord = { reference_date: string; source_url: string; payload: TrackMeasurement | TrackSandMeasurement | { kind: "notice"; entries: TrackEntry[] } };
export type TrackReferenceData = { venue: string; date: string; records: TrackRecord[]; live?: { observedTime: string; value: number; sourceUrl: string; fetchedAt: string } | null; liveError?: boolean };
export function validTrackDate(value: string) {
  return /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}
export function cushionDescription(value: number) {
  return value >= 12 ? "硬め" : value >= 10 ? "やや硬め" : value >= 8 ? "標準" : value > 7 ? "やや軟らかめ" : "軟らかめ";
}
// General physical interpretation from JRA; not a fitted race/style advantage.
export function cushionImpact(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 20) return null;
  const label = cushionDescription(value);
  const effect = value >= 10
    ? "着地時に馬場から受ける反発が比較的大きく、芝の表層は硬めの状態です。"
    : value >= 8
      ? "芝の表層の硬さ・反発は、JRAの参考区分では標準的な範囲です。"
      : "着地時の馬場の反発は比較的小さく、芝の表層は軟らかめの状態です。";
  const check = value >= 10
    ? "同じ競馬場でクッション値が近かった過去の走りを、時計・着順・馬場状態と合わせて確認。硬めというだけで高速決着や特定の馬の好走は決まりません。"
    : value >= 8
      ? "極端な硬さ・軟らかさを前提にせず、含水率、芝の傷み、当日の時計や脚質傾向も合わせて確認。"
      : "同じ競馬場の近いクッション値での実績を確認。低い値は含水率や芝の種類にも左右されるため、数値だけで重馬場・パワー型向きとは決められません。";
  return { label, effect, check };
}
export function safeTrackSource(value: string) {
  try { const u = new URL(value); return u.protocol === "https:" && ["jra.go.jp","keiba.or.jp","sonoda-himeji.jp","iwatekeiba.or.jp","urawa-keiba.jp","kawasaki-keiba.jp","funabashi-keiba.jp","f-keiba.com","monbetsu-keiba.jp"].some(host => u.hostname === host || u.hostname.endsWith(`.${host}`)); } catch { return false; }
}
// The current JRA fragment deliberately has no year: display the original time,
// never join it to a historical race or silently assign the retrieval year.
export function parseLiveCushion(html: string, venue: string) {
  const blocks = html.normalize("NFKC").split(/<div\s+id=["']rc[A-Z]["']\s+title=["']/i).slice(1);
  for (const block of blocks) {
    if (block.split(/["']/)[0] !== venue) continue;
    const match = block.match(/class=["']time["'][^>]*>\s*([^<]+)<\/div>\s*<div\s+class=["']cushion["'][^>]*>\s*(\d+(?:\.\d+)?)\s*<\/div>/i);
    if (!match) return null;
    const value = Number(match[2]);
    return value >= 0 && value <= 20 && /\d+月\d+日.*\d+時\d+分/.test(match[1]) ? { observedTime: match[1].trim(), value } : null;
  }
  return null;
}
export function displayTrackEntries(entries: TrackEntry[]) {
  const labels: Record<string,string> = { sand_depth_cm: "砂厚", turf_height_cm: "芝高", maintenance: "整備" };
  const kinds: Record<string,string> = { reported_track_profile: "掲載仕様", adjustment_notice: "調整告知", announced_specification: "告知仕様", forecast: "見込み", maintenance_notice: "整備告知" };
  const seen = new Set<string>();
  return entries.flatMap(e => {
    if (!labels[e.metric] || !kinds[e.kind]) return [];
    const numeric = typeof e.value === "number" ? `${e.value}cm` : typeof e.value_min === "number" ? e.value_min === e.value_max ? `${e.value_min}cm` : `${e.value_min}〜${e.value_max}cm` : "";
    const text = [labels[e.metric], kinds[e.kind], e.segment, e.distance_from_inner_m != null ? `内側から${e.distance_from_inner_m}m` : "", numeric, e.evidence].filter(Boolean).join(" ・ ");
    if (seen.has(text)) return []; seen.add(text); return [text];
  });
}
