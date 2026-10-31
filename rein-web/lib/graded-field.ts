// "今年の出走馬" pages for a graded race: recent 上がり ranks, the trend checklist
// and longshot candidates. Uses only pre-race facts: recent JRA runs, card data and
// the race's past-edition trend buckets (lib/graded-trends.ts).
import type { Horse } from "./horse-types";
import { baselineRate, isStrong, top3Rate, type GradedTrend, type TrendRecord } from "./graded-trends";

type Run = NonNullable<Horse["recent"]>["runs"][number];
const GRADED = new Set(["G1", "G2", "G3"]);
const ageBucket = (a: number) => a <= 3 ? "3歳" : a === 4 ? "4歳" : a === 5 ? "5歳" : a === 6 ? "6歳" : "7歳以上";
const finishBucket = (f: number) => f === 1 ? "前走1着" : f <= 3 ? "前走2〜3着" : f <= 5 ? "前走4〜5着" : "前走6着以下";
const weightBucket = (w: number) => w <= 459 ? "459kg以下" : w <= 479 ? "460〜479kg" : w <= 499 ? "480〜499kg" : "500kg以上";

export function lastRanks(horse: Horse) {
  const runs = horse.recent?.runs ?? [];
  const ranks = runs.map(r => ({ rank: r[4], graded: GRADED.has(r[2]), name: r[1], corner: r[5] }));
  const graded = ranks.filter(r => r.graded && r.rank !== null).map(r => r.rank as number);
  const corners = ranks.filter(r => r.corner !== null).map(r => r.corner as number);
  const avg = (v: number[]) => v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  return { ranks, top3: ranks.filter(r => r.rank !== null && r.rank <= 3).length, counted: ranks.filter(r => r.rank !== null).length,
    gradedAvg: graded.length >= 2 ? avg(graded) : null, cornerAvg: avg(corners) };
}

// Ranked by average 上がり rank in graded races (two or more), then the rest.
export function speedTable(horses: Horse[]) {
  const rows = horses.map(horse => ({ horse, ...lastRanks(horse) }));
  const rated = rows.filter(r => r.gradedAvg !== null).sort((a, b) => a.gradedAvg! - b.gradedAvg! || b.top3 - a.top3);
  const rest = rows.filter(r => r.gradedAvg === null).sort((a, b) => b.top3 - a.top3 || a.horse.number - b.horse.number);
  return [...rated.map((r, i) => ({ ...r, star: i < 5 })), ...rest.map(r => ({ ...r, star: false }))];
}

// Value of each mappable trend section for one runner, known before the race.
export function runnerBuckets(horse: Horse, raceDate: string): Record<string, string | null> {
  const prev: Run | undefined = horse.recent?.runs[0];
  const days = prev ? Math.round((Date.parse(raceDate) - Date.parse(prev[0])) / 86_400_000) : null;
  const rides = horse.parameterFactors?.find(f => f.label === "騎手相性")?.samples;
  return {
    "前走のレース": prev?.[1] ?? null,
    "前走の格": prev ? prev[2] === "G1" ? "前走G1" : prev[2] === "G2" ? "前走G2" : "前走G3以下" : null,
    "前走の着順": prev && prev[3] !== null ? finishBucket(prev[3]) : null,
    "前走からの間隔": days === null ? null : days <= 35 ? "中4週以内" : days <= 70 ? "中5〜9週" : "中10週以上",
    "年齢": horse.age ? ageBucket(horse.age) : null,
    "性別": horse.sex ? horse.sex === "牝" ? "牝馬" : "牡馬・セン馬" : null,
    "GI勝ちの実績": horse.recent ? horse.recent.g1 > 0 ? "GI勝ちあり" : "GI勝ちなし" : null,
    "騎手": prev && horse.jockeyId ? prev[6] === horse.jockeyId ? "前走と同じ騎手" : "乗り替わり" : null,
    "騎手との相性": typeof rides === "number" ? rides === 0 ? "初コンビ" : rides <= 2 ? "2〜3戦目" : "4戦目以上" : null,
    "枠別": horse.gate ? `${horse.gate}枠` : null,
    "馬体重": horse.weight ? weightBucket(horse.weight) : null,
    "上がり3ハロンの順位": horse.recent ? lastRanks(horse).top3 > 0 ? "近5走で上がり3位以内" : "近5走で上がり3位以内なし" : null,
  };
}

export type CheckItem = { section: string; label: string; short: string; record: TrendRecord; rate: number };
const SHORT: Record<string, string> = { "前走G1": "前走GI", "前走2〜3着": "前走2〜3着", "前走1着": "前走1着", "中10週以上": "中10週以上", "GI勝ちあり": "GI勝ちあり",
  "前走と同じ騎手": "前走と同じ騎手", "近5走で上がり3位以内": "上がり3位内" };

// Strong buckets of this race that can be judged before the start. 上がり in the race itself is
// replaced by "近5走で上がり3位以内" when the race rewards fast finishers.
export function checkItems(trend: GradedTrend, limit = 7): CheckItem[] {
  const base = baselineRate(trend), items: CheckItem[] = [];
  for (const s of trend.sections) {
    if (s.title === "上がり3ハロンの順位") {
      const fast = s.rows.filter(r => r.label === "上がり1位" || r.label === "上がり2〜3位");
      const record = fast.reduce<TrendRecord>((t, r) => [t[0] + r.record[0], t[1] + r.record[1], t[2] + r.record[2], t[3] + r.record[3]], [0, 0, 0, 0]);
      if (fast.length && isStrong(record, base)) items.push({ section: s.title, label: "近5走で上がり3位以内", short: "上がり3位内", record, rate: top3Rate(record)! });
      continue;
    }
    if (!(s.title in BUCKET_SECTIONS)) continue;
    for (const r of s.rows) if (r.label !== "その他" && isStrong(r.record, base)) items.push({ section: s.title, label: r.label, short: SHORT[r.label] ?? r.label, record: r.record, rate: top3Rate(r.record)! });
  }
  return items.sort((a, b) => b.rate - a.rate).slice(0, limit);
}
const BUCKET_SECTIONS: Record<string, true> = { "前走のレース": true, "前走の格": true, "前走の着順": true, "前走からの間隔": true, "年齢": true, "性別": true,
  "GI勝ちの実績": true, "騎手": true, "騎手との相性": true, "枠別": true, "馬体重": true };

export function checklist(trend: GradedTrend, horses: Horse[], raceDate: string) {
  const items = checkItems(trend);
  return { items, rows: horses.map(horse => {
    const buckets = runnerBuckets(horse, raceDate);
    const hits = items.map(item => buckets[item.section] === null ? null : buckets[item.section] === item.label);
    return { horse, hits, count: hits.filter(Boolean).length };
  }).sort((a, b) => a.horse.number - b.horse.number) };
}

// Lowest popularity that finished 1st/2nd/3rd in the past editions.
export function popularityReach(trend: GradedTrend) {
  return [1, 2, 3].map(finish => Math.max(0, ...trend.results.flatMap(e => e.rows.filter(r => r.finish === finish && r.popularity).map(r => r.popularity as number))));
}

export type Longshot = { horse: Horse; count: number; reasons: string[]; cautions: string[] };
// Unpopular runners (5th favourite or lower) with the most checklist matches.
export function longshots(trend: GradedTrend, horses: Horse[], raceDate: string, limit = 4): Longshot[] {
  const { items, rows } = checklist(trend, horses, raceDate), base = baselineRate(trend);
  return rows.filter(r => r.horse.popularity >= 5 && r.count >= 2)
    .sort((a, b) => b.count - a.count || (lastRanks(a.horse).gradedAvg ?? 99) - (lastRanks(b.horse).gradedAvg ?? 99) || a.horse.popularity - b.horse.popularity)
    .slice(0, limit).map(r => {
      const speed = lastRanks(r.horse), pair = r.horse.parameterFactors?.find(f => f.label === "騎手相性");
      const reasons = [`傾向チェック${r.count}項目（${items.filter((_, i) => r.hits[i]).map(i => i.short).join("・")}）`];
      if (speed.counted) reasons.push(`近5走で上がり3位以内${speed.top3}回${speed.gradedAvg !== null ? `・重賞の平均${speed.gradedAvg.toFixed(1)}位` : ""}`);
      if (pair?.record && pair.samples > 0) reasons.push(`${r.horse.jockey?.trim() ?? "騎手"}とは${pair.record}`);
      // Cautions: this runner's own bucket clearly below the race baseline.
      const buckets = runnerBuckets(r.horse, raceDate), cautions: string[] = [];
      for (const s of trend.sections) {
        const row = s.rows.find(x => x.label === buckets[s.title]);
        const rate = row ? top3Rate(row.record) : null;
        if (row && rate !== null && row.record.reduce((a, b) => a + b, 0) >= 10 && rate <= base * 0.5) cautions.push(`${row.label}は3着以内${Math.round(rate * 100)}%`);
      }
      return { horse: r.horse, count: r.count, reasons, cautions: cautions.slice(0, 2) };
    });
}
