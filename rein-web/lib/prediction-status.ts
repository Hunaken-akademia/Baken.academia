export type StatusHorse = { weight?: number | null; odds: number | null; popularity: number };
export type StatusInput = {
  horses: StatusHorse[];
  evaluation?: { roleModel?: string; overall?: string } | null;
};

const MINUTE = 60_000;
const JST_OFFSET_MS = 9 * 60 * MINUTE;

// Lists the same-day inputs that keep a prediction provisional, in the order users can act on them.
export function missingPredictionItems(data: StatusInput) {
  const total = data.horses.length;
  const items: string[] = [];
  if (!total) return ["出走表"];
  const weights = data.horses.filter((horse) => !(typeof horse.weight === "number" && horse.weight > 0)).length;
  const odds = data.horses.filter((horse) => !(horse.odds !== null && horse.odds > 0 && horse.popularity > 0)).length;
  if (weights) items.push(weights === total ? "馬体重（未発表）" : `馬体重（${weights}頭未取得）`);
  if (odds) items.push(odds === total ? "人気・オッズ（未発表）" : `人気・オッズ（${odds}頭未取得）`);
  if (data.evaluation?.roleModel !== "ready") items.push("着順別モデルの評価");
  if (data.evaluation?.overall !== "ready") items.push("総合評価");
  return items;
}

function jstClock(time: number) {
  const jst = new Date(time + JST_OFFSET_MS);
  return `${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
}

// Mirrors vercel.json: JRA refreshes every 10 minutes (:00, :10, …), NAR at :05, :15, …,
// only for races starting within the next 60 minutes.
export function nextServerUpdate(startsAt: number | null | undefined, now: number, league: "jra" | "nar" = "jra") {
  if (!startsAt || !Number.isFinite(startsAt)) return null;
  if (now >= startsAt) return { phase: "started" as const };
  const windowStart = startsAt - 60 * MINUTE;
  const from = Math.max(now, windowStart);
  const offset = league === "nar" ? 5 * MINUTE : 0;
  const step = 10 * MINUTE;
  const next = Math.ceil((from - offset) / step) * step + offset;
  if (next >= startsAt) return { phase: "final" as const };
  return { phase: now < windowStart ? "waiting" as const : "live" as const, at: next, label: jstClock(next), windowLabel: jstClock(windowStart) };
}

export function updateScheduleText(startsAt: number | null | undefined, now: number, league: "jra" | "nar" = "jra") {
  const next = nextServerUpdate(startsAt, now, league);
  if (!next) return "発走時刻の取得後に更新予定を表示します。";
  if (next.phase === "started") return "発走済みです。確定結果の取得後に答え合わせを表示します。";
  if (next.phase === "final") return "発走前の最終更新を終えています。";
  if (next.phase === "waiting") return `発走60分前（${next.windowLabel}）から10分ごとに自動更新します。`;
  return `次の自動更新は${next.label}ごろです。`;
}
