// Past-edition trend cards for JRA graded races (scripts/build_graded_trends.py).
export type TrendRecord = [number, number, number, number]; // 1着-2着-3着-着外
export type TrendSection = { title: string; note: string; rows: Array<{ label: string; record: TrendRecord }> };
export type TrendResult = { finish: number; name: string; sexAge: string; sire: string; popularity: number | null; prior: string; corner4: number | null; last3fRank: number | null };
export type GradedTrend = {
  key: string; name: string; grade: string; yearFrom: number; yearTo: number; editions: number; course: string; courseChanged: boolean;
  summary: { favorite: TrendRecord; winnersPopularity4Plus: number; maxWinnerPopularity: number };
  sections: TrendSection[]; sires: Array<{ name: string; record: TrendRecord }>; damSires: Array<{ name: string; record: TrendRecord }>;
  results: Array<{ year: number; going: string; field: number; rows: TrendResult[] }>;
};

export const TREND_PAGES: Array<{ id: string; label: string; sections: string[] }> = [
  { id: "trend", label: "傾向", sections: ["人気別", "上がり3ハロンの順位", "枠別", "4コーナーの位置"] },
  { id: "prior", label: "前走", sections: ["前走のレース", "前走の格", "前走の着順", "前走からの間隔"] },
  { id: "horse", label: "馬と騎手", sections: ["年齢", "GI勝ちの実績", "性別", "*の実績", "騎手", "騎手との相性"] },
  { id: "blood", label: "血統と体", sections: ["馬体重"] },
  { id: "results", label: "過去の1〜3着", sections: [] },
];

export const starts = (r: TrendRecord) => r[0] + r[1] + r[2] + r[3];
export const top3 = (r: TrendRecord) => r[0] + r[1] + r[2];
export const top3Rate = (r: TrendRecord) => starts(r) ? top3(r) / starts(r) : null;
export const recordText = (r: TrendRecord) => r.join("-");

// Highlight buckets clearly above this race's overall top-three rate, with enough runners to mean something.
export function baselineRate(trend: GradedTrend) {
  const all = trend.sections.find(s => s.title === "人気別")?.rows ?? [];
  const total = all.reduce((s, r) => s + starts(r.record), 0), placed = all.reduce((s, r) => s + top3(r.record), 0);
  return total ? placed / total : 0;
}
export const isStrong = (r: TrendRecord, base: number) => starts(r) >= 5 && (top3Rate(r) ?? 0) >= base * 1.25;

export function sectionsFor(trend: GradedTrend, names: string[]) {
  return names.flatMap(name => trend.sections.filter(s => name.startsWith("*") ? s.title.endsWith(name.slice(1)) : s.title === name));
}
