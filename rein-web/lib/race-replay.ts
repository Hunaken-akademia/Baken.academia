// 展開ビュー: an animated, illustrative race preview built only from REIN outputs.
// Positions at the start/corners come from the validated corner-position model
// (lib/corner-reference.ts) or, where it does not apply, from recent running style.
// The finish order is the 1着適性 ranking (same order as 本命・対抗). Gaps between
// checkpoints, lanes and spacing are presentation only: no 馬身差 or path is claimed.

import { courseStages, predictCorner, type MapHorse } from "./corner-reference";
import { roleOrder } from "./marks";

export type ReplayHorse = MapHorse & { firstProbability?: number; popularity: number };

export type CheckpointSource = "start" | "ai" | "style" | "first-ranking";

export type ReplayCheckpoint = {
  id: string;
  label: string;
  // Metres the leader still has to run when the field reaches this point.
  remaining: number;
  source: CheckpointSource;
  // Order front to back; estimate is the model's 番手 (null when filled in).
  order: Array<{ number: number; estimate: number | null }>;
};

export type ReplayGeometry = {
  venue: string;
  distance: number;
  circumference: number;
  homeStraight: number;
  curve: number;
  rightHanded: boolean;
  approximate: true;
};

export type ReplayPlan = {
  geometry: ReplayGeometry;
  checkpoints: ReplayCheckpoint[];
  // Metres behind the leader per position, per checkpoint (visual spacing only).
  spacing: number[];
  commentary: Array<{ checkpoint: number; label: string; text: string }>;
  finish: number[];
  cornerSource: "ai" | "style";
};

export type ReplayUnavailable = { unavailable: string };

// Approximate public course figures (circumference, home straight in metres). The view
// is labelled 概略; it is used for where corners fall, not for timing.
const COURSES: Record<string, Record<string, [number, number]>> = {
  札幌: { 芝: [1641, 266], ダート: [1487, 264] },
  函館: { 芝: [1627, 262], ダート: [1476, 260] },
  福島: { 芝: [1600, 292], ダート: [1445, 296] },
  新潟: { 芝: [1623, 359], 芝外: [2223, 659], ダート: [1472, 354] },
  東京: { 芝: [2083, 526], ダート: [1899, 502] },
  中山: { 芝: [1667, 310], 芝外: [1840, 310], ダート: [1493, 308] },
  中京: { 芝: [1706, 413], ダート: [1530, 411] },
  京都: { 芝: [1783, 328], 芝外: [1894, 404], ダート: [1608, 329] },
  阪神: { 芝: [1689, 357], 芝外: [2089, 474], ダート: [1518, 353] },
  小倉: { 芝: [1615, 293], ダート: [1445, 291] },
};
const LEFT_HANDED = new Set(["東京", "中京", "新潟"]);
const STYLE_ORDER: Record<string, number> = { 逃げ: 1, 先行: 2, 好位: 3, 差し: 4, 追込: 5 };
// Track metres behind the leader per position, chosen so the field is readable on the
// drawn oval (a faster pace strings the field out more). Not a 馬身差 estimate.
const PACE_SPACING: Record<string, number> = {
  ハイペース寄り: 14,
  "平均〜やや速い": 12,
  "スロー〜平均": 10,
  スロー: 8,
};
const FINISH_SPACING = 6;

export function replayGeometry(title: string, course: string): ReplayGeometry | ReplayUnavailable {
  if (/障害/.test(course)) return { unavailable: "障害レースは展開ビューの対象外です" };
  if (/直線/.test(course)) return { unavailable: "直線コースは展開ビューの対象外です" };
  const distance = Number(course.match(/(\d{3,4})m/)?.[1] ?? 0);
  const surface = course.match(/^(芝|ダート)/)?.[1];
  if (!distance || !surface) return { unavailable: "コース情報を取得できないため展開ビューを表示できません" };
  const venue = title.match(/札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉/)?.[0] ?? "";
  const outer = surface === "芝" && /外/.test(course);
  const table = COURSES[venue];
  const [circumference, homeStraight] =
    (table && ((outer && table["芝外"]) || table[surface])) || [1600, 300];
  const curve = Math.max(150, (circumference - 2 * homeStraight) / 2);
  const rightHanded = /左/.test(course) ? false : /右/.test(course) ? true : !LEFT_HANDED.has(venue);
  return { venue: venue || "コース", distance, circumference, homeStraight, curve, rightHanded, approximate: true };
}

// Where corner n (the last four corners of the race) is passed, as metres remaining.
export function cornerRemaining(geometry: ReplayGeometry, stage: number) {
  const { homeStraight: home, curve } = geometry;
  switch (stage) {
    case 4: return home + 0.15 * curve;
    case 3: return home + 0.75 * curve;
    case 2: return home + curve + home + 0.15 * curve;
    case 1: return home + curve + home + 0.75 * curve;
    default: return null;
  }
}

function fillOrder(
  horses: ReplayHorse[],
  estimates: Map<number, number | null>,
): Array<{ number: number; estimate: number | null }> {
  const known = horses.filter((horse) => estimates.get(horse.number) != null);
  const middle = (horses.length + 1) / 2;
  const byStyle = new Map<string, number[]>();
  for (const horse of known) {
    const list = byStyle.get(horse.style) ?? [];
    list.push(estimates.get(horse.number)!);
    byStyle.set(horse.style, list);
  }
  return horses
    .map((horse) => {
      const estimate = estimates.get(horse.number) ?? null;
      const peers = byStyle.get(horse.style);
      const sortKey = estimate ?? (peers?.length ? peers.reduce((a, b) => a + b, 0) / peers.length : middle) + 0.01;
      return { number: horse.number, estimate, sortKey };
    })
    .sort((a, b) => a.sortKey - b.sortKey || a.number - b.number)
    .map(({ number, estimate }) => ({ number, estimate }));
}

function styleOrder(horses: ReplayHorse[]) {
  return [...horses]
    .sort((a, b) =>
      (STYLE_ORDER[a.style] ?? 3.5) - (STYLE_ORDER[b.style] ?? 3.5)
      || (a.earlyPosition ?? 99) - (b.earlyPosition ?? 99)
      || a.number - b.number)
    .map((horse) => ({ number: horse.number, estimate: null }));
}

export function buildReplay(input: {
  horses: ReplayHorse[];
  title: string;
  course: string;
  raceId: string;
  pace: string;
  league?: "jra" | "nar";
  roleReady: boolean;
}): ReplayPlan | ReplayUnavailable {
  const { horses, title, course, raceId, pace } = input;
  if (/ばんえい/.test(course)) return { unavailable: "ばんえいは展開ビューの対象外です" };
  if (horses.length < 2) return { unavailable: "出走馬が少ないため展開ビューを表示できません" };
  if (!input.roleReady) return { unavailable: "1着適性の評価が保留中のため、ゴールの並びを出せません。評価の取得後に表示します" };
  const finishOrder = roleOrder(horses, "first");
  if (finishOrder.length !== horses.length) return { unavailable: "1着適性が全頭そろっていないため展開ビューを表示できません" };
  const geometry = replayGeometry(title, course);
  if ("unavailable" in geometry) return geometry;

  const year = raceId.length === 10 ? 2000 + Number(raceId.slice(0, 2)) : Number(raceId.slice(0, 4));
  const stages = input.league === "nar" ? null : courseStages(title, course);
  const aiEligible = year >= 2025 && !!stages?.length;
  const field = horses.length;
  const estimateAt = (stage: number) =>
    new Map(horses.map((horse) => [horse.number, predictCorner(horse, stage, field, course)?.position ?? null] as const));

  const checkpoints: ReplayCheckpoint[] = [];
  checkpoints.push({
    id: "start", label: "スタート", remaining: geometry.distance, source: "start",
    order: [...horses].sort((a, b) => a.number - b.number).map((horse) => ({ number: horse.number, estimate: null })),
  });

  const cornerStages = (aiEligible ? stages! : [3, 4])
    .map((stage) => ({ stage, remaining: cornerRemaining(geometry, stage) }))
    .filter((item): item is { stage: number; remaining: number } =>
      item.remaining !== null && item.remaining < geometry.distance - 120);
  const firstCorner = cornerStages[0]?.remaining ?? geometry.homeStraight;
  const earlyRemaining = Math.max(
    firstCorner + 0.35 * (geometry.distance - firstCorner),
    geometry.distance - Math.min(250, 0.2 * geometry.distance),
  );
  if (earlyRemaining > firstCorner + 60) {
    checkpoints.push({
      id: "early", label: "序盤", remaining: Math.min(earlyRemaining, geometry.distance - 80),
      source: aiEligible ? "ai" : "style",
      order: aiEligible ? fillOrder(horses, estimateAt(0)) : styleOrder(horses),
    });
  }
  for (const { stage, remaining } of cornerStages) {
    checkpoints.push({
      id: `corner${stage}`, label: `${stage}角`, remaining, source: aiEligible ? "ai" : "style",
      order: aiEligible ? fillOrder(horses, estimateAt(stage)) : styleOrder(horses),
    });
  }
  checkpoints.push({
    id: "finish", label: "ゴール", remaining: 0, source: "first-ranking",
    order: finishOrder.map((horse) => ({ number: horse.number, estimate: null })),
  });

  const racing = PACE_SPACING[pace] ?? 11;
  const spacing = checkpoints.map((checkpoint) =>
    checkpoint.source === "start" ? 0 : checkpoint.source === "first-ranking" ? FINISH_SPACING : racing);

  return {
    geometry,
    checkpoints,
    spacing,
    commentary: commentary(horses, checkpoints, pace, geometry),
    finish: finishOrder.map((horse) => horse.number),
    cornerSource: aiEligible ? "ai" : "style",
  };
}

function commentary(
  horses: ReplayHorse[],
  checkpoints: ReplayCheckpoint[],
  pace: string,
  geometry: ReplayGeometry,
): ReplayPlan["commentary"] {
  const name = (number: number) => horses.find((horse) => horse.number === number)?.name ?? `${number}番`;
  const rankOf = (checkpoint: ReplayCheckpoint, number: number) =>
    checkpoint.order.findIndex((item) => item.number === number) + 1;
  const finish = checkpoints[checkpoints.length - 1];
  const [winner, second, third] = finish.order.map((item) => item.number);
  const lines: ReplayPlan["commentary"] = [];
  const firstRacing = checkpoints.find((checkpoint) => checkpoint.source !== "start");
  const lastCorner = [...checkpoints].reverse().find((checkpoint) => checkpoint.id.startsWith("corner"));

  if (firstRacing && firstRacing.id !== "finish") {
    const [lead, next] = firstRacing.order.map((item) => item.number);
    lines.push({
      checkpoint: 0, label: "スタート",
      text: `${horses.length}頭がスタート。${name(lead)}${next ? `と${name(next)}` : ""}が前へ。1着適性1位の${name(winner)}は${rankOf(firstRacing, winner)}番手あたりから運ぶ想定です。`,
    });
  }
  checkpoints.forEach((checkpoint, index) => {
    if (checkpoint.source === "start" || checkpoint.id === "finish") return;
    const lead = checkpoint.order[0].number;
    if (checkpoint.id === "early") {
      lines.push({
        checkpoint: index, label: "序盤",
        text: `${pace}の想定。先頭は${name(lead)}、${name(winner)}は${rankOf(checkpoint, winner)}番手${second ? `、${name(second)}は${rankOf(checkpoint, second)}番手` : ""}。`,
      });
      return;
    }
    const isLast = checkpoint === lastCorner;
    let text = `${checkpoint.label}、先頭は${name(lead)}。${name(winner)}は${rankOf(checkpoint, winner)}番手付近。`;
    if (isLast) {
      const mover = [winner, second, third]
        .filter((number): number is number => number !== undefined)
        .map((number) => ({ number, gain: rankOf(checkpoint, number) - rankOf(finish, number) }))
        .sort((a, b) => b.gain - a.gain)[0];
      if (mover && mover.gain >= 3) text += `${name(mover.number)}が${rankOf(checkpoint, mover.number)}番手から進出を開始。`;
    }
    lines.push({ checkpoint: index, label: checkpoint.label, text });
  });
  lines.push({
    checkpoint: checkpoints.length - 1, label: "直線",
    text: `直線${geometry.homeStraight}m（概略）。${name(winner)}が抜け出し${second ? `、${name(second)}` : ""}${third ? `・${name(third)}` : ""}が追う予想です。`,
  });
  return lines;
}

// ---- Playback ---------------------------------------------------------------

const smooth = (t: number) => t * t * (3 - 2 * t);

export type ReplayFrame = {
  leaderRemaining: number;
  runners: Array<{ number: number; remaining: number; lane: number }>;
  checkpoint: number;
};

// progress: 0 (start) .. 1 (leader at the post).
export function replayFrame(plan: ReplayPlan, progress: number): ReplayFrame {
  const { checkpoints, spacing, geometry } = plan;
  const leaderRemaining = geometry.distance * (1 - Math.min(1, Math.max(0, progress)));
  let index = 0;
  while (index < checkpoints.length - 1 && checkpoints[index + 1].remaining >= leaderRemaining) index += 1;
  const from = checkpoints[index];
  const to = checkpoints[Math.min(index + 1, checkpoints.length - 1)];
  const span = from.remaining - to.remaining;
  const t = span > 0 ? smooth((from.remaining - leaderRemaining) / span) : 1;
  const spacingFrom = spacing[index];
  const spacingTo = spacing[Math.min(index + 1, spacing.length - 1)];
  const runners = from.order.map(({ number }) => {
    const rankFrom = from.order.findIndex((item) => item.number === number);
    const rankTo = to.order.findIndex((item) => item.number === number);
    const behind = (1 - t) * rankFrom * spacingFrom + t * rankTo * spacingTo;
    // At the start the field is abreast across the track; afterwards up to 3 wide.
    const abreast = (rank: number) => (from.order.length > 1 ? (rank * 2.6) / (from.order.length - 1) : 0);
    const laneFrom = from.source === "start" ? abreast(rankFrom) : rankFrom % 3;
    const laneTo = to.source === "start" ? abreast(rankTo) : rankTo % 3;
    return { number, remaining: leaderRemaining + behind, lane: (1 - t) * laneFrom + t * laneTo };
  });
  return { leaderRemaining, runners, checkpoint: index };
}

export function currentOrder(frame: ReplayFrame) {
  return [...frame.runners].sort((a, b) => a.remaining - b.remaining || a.number - b.number).map((runner) => runner.number);
}

// ---- Track drawing ------------------------------------------------------------

export type TrackShape = { width: number; height: number; straight: number; radius: number; goalAt: number };

export const TRACK: TrackShape = { width: 640, height: 330, straight: 300, radius: 110, goalAt: 0.18 };

// Point for a runner `remaining` metres before the post. The drawn oval is split into
// the same segments as the real course (home straight, final turn, back straight,
// first turn), each scaled linearly, so corners appear where the course has them.
export function trackPoint(geometry: ReplayGeometry, remaining: number, lane: number, shape = TRACK) {
  const { straight: S, radius: R, width, height, goalAt } = shape;
  const cx = width / 2, cy = height / 2;
  const home = geometry.homeStraight;
  const curve = geometry.curve;
  const back = home;
  const rest = Math.max(40, geometry.circumference - (home + curve + back + curve));
  const lap = home + curve + back + curve + rest;
  let d = ((remaining % lap) + lap) % lap;
  const r = R + 10 + lane * 9;
  let x: number, y: number;
  const goalX = cx - S / 2 + goalAt * S;
  if (d <= home) {
    // Home straight, from the post back toward the final turn.
    x = goalX + (d / home) * (cx + S / 2 - goalX); y = cy + r;
  } else if ((d -= home) <= curve) {
    const angle = Math.PI / 2 - (d / curve) * Math.PI;
    x = cx + S / 2 + r * Math.cos(angle); y = cy + r * Math.sin(angle);
  } else if ((d -= curve) <= back) {
    x = cx + S / 2 - (d / back) * S; y = cy - r;
  } else if ((d -= back) <= curve) {
    const angle = -Math.PI / 2 - (d / curve) * Math.PI;
    x = cx - S / 2 + r * Math.cos(angle); y = cy + r * Math.sin(angle);
  } else {
    d -= curve;
    x = cx - S / 2 + (d / rest) * (goalX - (cx - S / 2)); y = cy + r;
  }
  if (!geometry.rightHanded) x = width - x;
  return { x, y };
}
