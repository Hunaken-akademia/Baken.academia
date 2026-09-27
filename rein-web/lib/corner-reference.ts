import model from "./corner-reference-model.json";

export type MapHorse = {
  number: number; name: string; gate?: number; style: string;
  earlyPosition?: number | null; mapPositions?: string[]; recentPositions?: string[];
  firstSuitability?: number;
};
export type CornerEstimate = { position: number; samples: number; low: number; high: number };

// Read only the provider's passing-position cells, never dates or unrelated HTML.
export function extractMapPositions(html: string): string[] {
  return [...html.matchAll(/<p\b[^>]*class=["'][^"']*\bhr-denma__passing\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => m[1].replace(/<[^>]*>/g, "").trim())
    .filter((s) => parseSequence(s).length > 0).slice(0, 5);
}

export function parseSequence(value: string): number[] {
  if (!/^\d{1,2}(?:-\d{1,2}){1,3}$/.test(value)) return [];
  const values = value.split("-").map(Number);
  return values.every((n) => n >= 1 && n <= 18) ? values : [];
}

export function stagePosition(values: number[], stage: number): number | null {
  if (stage === 0) return values[0] ?? null;
  const index = stage - (5 - values.length);
  return values.length >= 2 && values.length <= 4 && index >= 0 && index < values.length ? values[index] : null;
}

export function horseSequences(horse: MapHorse): number[][] {
  return (horse.mapPositions ?? horse.recentPositions ?? []).map(parseSequence).filter((v) => v.length).slice(0, 5);
}

export function cornerFeatures(history: number[][], stage: number, field: number, distance: number, dirt: boolean, gate: number): number[] | null {
  const values = history.slice(0, 5).flatMap((seq, i) => {
    const v = stagePosition(seq, stage);
    return v === null ? [] : [{ v, w: 5-i }];
  });
  if (!values.length || !history.length) return null;
  const average = values.reduce((s, v) => s + v.v * v.w, 0) / values.reduce((s, v) => s + v.w, 0);
  const mean = values.reduce((s, v) => s + v.v, 0) / values.length;
  const spread = Math.sqrt(values.reduce((s, v) => s + (v.v-mean)**2, 0) / values.length);
  const early = history.reduce((s,v) => s + v[0], 0) / history.length;
  const late = history.reduce((s,v) => s + v[v.length-1], 0) / history.length;
  return [values[0].v/field, average/field, spread/field, values.length/5, early/field, late/field, (late-early)/field, field/18, distance/2000, Number(dirt), gate/8];
}

export function predictCorner(horse: MapHorse, stage: number, field: number, course: string): CornerEstimate | null {
  const fitted = model.models[String(stage) as keyof typeof model.models];
  const distance = Number(course.match(/(\d{3,4})m/)?.[1] ?? 0);
  if (!fitted?.referenceApproved || field < 2 || field > 18 || !distance || /障害|直線/.test(course) || !horse.gate || horse.gate < 1 || horse.gate > 8) return null;
  const f = cornerFeatures(horseSequences(horse), stage, field, distance, course.startsWith("ダート"), horse.gate);
  if (!f) return null;
  const position = Math.max(1, Math.min(field, field * (fitted.intercept + f.reduce((s,v,i) => s + v*fitted.coef[i], 0))));
  const error = fitted.checkError;
  return { position, samples: Math.round(f[3]*5), low: Math.max(1, Math.floor(position-error)), high: Math.min(field, Math.ceil(position+error)) };
}

export function courseStages(title: string, course: string): number[] | null {
  const venue = title.match(/札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉/)?.[0];
  const surface = course.match(/^(芝|ダート)/)?.[1];
  const distance = course.match(/(\d{3,4})m/)?.[1];
  const layout = course.includes("直線") ? "直線" : course.includes("外") ? "外" : course.includes("内") ? "内" : "標準";
  if (!venue || !surface || !distance) return null;
  const key = `${venue}|${surface}|${distance}|${layout}`;
  return (model.courses as Record<string, number[]>)[key] ?? null;
}

// Slots show front-to-back order. Lateral slots only separate dots for readability.
export function mapSlot(index: number, count: number, curved: boolean) {
  const columns = Math.max(1, Math.ceil(count/3));
  const column = Math.floor(index/3), row = index%3;
  if (!curved) return { x: 34 + (columns > 1 ? column/(columns-1)*332 : 0), y: 104 + row*68 };
  const angle = (82 - (columns > 1 ? column/(columns-1)*74 : 0))*Math.PI/180;
  const radius = 170 + row*56;
  return { x: 18 + radius*Math.cos(angle), y: 18 + radius*Math.sin(angle) };
}

export const CORNER_MODEL_VERSION = model.version;
export const CORNER_AUDIT_MAE = model.models["4"].auditMae;
