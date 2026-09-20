import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";

type Rate = { n: number; w: number; t: number; f: number };
type Rates = Record<string, Rate>;

export type HistoryBundle = {
  meta: {
    version: string;
    dateFrom: string;
    dateTo: string;
    races: number;
    runners: number;
    horses: number;
    leakagePolicy: string;
  };
  horse: Rates;
  horseRecent5: Rates;
  horseSurface: Rates;
  horseDistance: Rates;
  horseCourse: Rates;
  jockey: Rates;
  trainer: Rates;
  course: Rates;
  gate: Rates;
};

export type HistoryInput = {
  horseId: string;
  jockeyId: string;
  trainerId: string;
  racecourse: string;
  surface: string;
  distanceM: number;
  going: string;
  gate: number;
};

export type HistoryScore = {
  adjustment: number;
  samples: number;
  reasons: string[];
  risks: string[];
  components: { label: string; samples: number; signal: number }[];
};

let cached: Promise<HistoryBundle> | undefined;

export function loadHistory(): Promise<HistoryBundle> {
  cached ??= readFile(path.join(process.cwd(), "data", "history-profile.json.gz"))
    .then((value) => JSON.parse(gunzipSync(value).toString("utf8")) as HistoryBundle);
  return cached;
}

const cleanId = (value: string) => value.replace(/^0+/, "") || "0";
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function rateSignal(rate: Rate): number {
  const confidence = clamp(Math.log1p(rate.n) / Math.log(51), 0.12, 1);
  const lift = 0.35 * (rate.w / 0.075 - 1) + 0.65 * (rate.t / 0.225 - 1);
  return Math.tanh(lift) * confidence;
}

export function scoreHistory(bundle: HistoryBundle, input: HistoryInput): HistoryScore {
  const horse = cleanId(input.horseId);
  const jockey = cleanId(input.jockeyId);
  const trainer = cleanId(input.trainerId);
  const bucket = Math.floor(input.distanceM / 200);
  const candidates: Array<[string, number, Rate | undefined]> = [
    ["通算成績", 0.32, bundle.horse[horse]],
    ["近5走", 0.24, bundle.horseRecent5[horse]],
    ["芝ダ適性", 0.14, bundle.horseSurface[`${horse}|${input.surface}`]],
    ["距離適性", 0.10, bundle.horseDistance[`${horse}|${bucket}`]],
    ["競馬場適性", 0.06, bundle.horseCourse[`${horse}|${input.racecourse}`]],
    ["騎手傾向", 0.08, bundle.jockey[jockey]],
    ["厩舎傾向", 0.06, bundle.trainer[trainer]],
  ];
  const components = candidates.flatMap(([label, weight, rate]) =>
    rate ? [{ label, samples: rate.n, signal: rateSignal(rate) * weight }] : [],
  );
  const availableWeight = candidates.reduce((sum, [, weight, rate]) => sum + (rate ? weight : 0), 0);
  const combined = components.reduce((sum, part) => sum + part.signal, 0) / Math.max(availableWeight, 0.25);

  const context = bundle.gate[`${input.racecourse}|${input.surface}|${bucket}|${input.gate}`];
  const contextSignal = context ? rateSignal(context) * 0.12 : 0;
  const adjustment = Math.round(clamp(14 * Math.tanh((combined + contextSignal) * 1.15), -14, 14));
  const ordered = [...components].sort((a, b) => Math.abs(b.signal) - Math.abs(a.signal));
  const reasons = ordered.filter((part) => part.signal > 0.012).slice(0, 3)
    .map((part) => `${part.label}（${part.samples}走）`);
  const risks = ordered.filter((part) => part.signal < -0.012).slice(0, 3)
    .map((part) => `${part.label}弱め（${part.samples}走）`);
  if (context && contextSignal > 0.01) reasons.push(`枠傾向（${context.n}走）`);
  if (context && contextSignal < -0.01) risks.push(`枠傾向弱め（${context.n}走）`);
  return {
    adjustment,
    samples: bundle.horse[horse]?.n ?? 0,
    reasons: reasons.slice(0, 3),
    risks: risks.slice(0, 3),
    components,
  };
}
