// 買い方タブ・狙い目ナビ（2026-11-20 オーナー依頼。WAKE の買い方タブ・狙い目ナビを競馬向けに作り直したもの）。
// 新しい予想ロジックは足さず、今の参考買い目（券種ごとの本線・対抗・穴）を「目的別」に組み替える。
// レースの型は「条件でレースを探す」と同じ（単勝オッズの割れ具合、lib/race-finder.ts）。
// 成績は lib/bet-tab-stats.json（scripts/bet-tab-stats.sql の集計、1点100円・実際の払戻）。
import stats from "./bet-tab-stats.json";
import { classifyRace, RACE_KINDS, type League, type RaceKind } from "./race-finder";
import type { Ticket } from "./tickets";

export type TabKey = "single" | "hit" | "honsen" | "confident" | "ana" | "placeAna";
export type Mark = "◎" | "○" | "△" | "✕";
// 成績を分ける型。固めは「REIN の本命が1番人気か（鉄板）」でも分けて数えている。
export type StatKind = "solidT" | "solidO" | "middle" | "rough";

export const BET_TABS: Record<TabKey, { label: string; type: string; group: "本線" | "対抗" | "穴"; detail: string; solidOnly?: boolean }> = {
  single: { label: "本命勝負", type: "複勝", group: "本線", detail: "本線の1頭の複勝を1点" },
  hit: { label: "的中重視", type: "ワイド", group: "本線", detail: "ワイドの本線（最大4点）" },
  honsen: { label: "本線", type: "馬連", group: "本線", detail: "馬連の本線（最大5点）" },
  confident: { label: "自信レース", type: "三連複", group: "本線", detail: "固めのレースだけ、3連複の本線（最大10点）", solidOnly: true },
  ana: { label: "穴狙い", type: "ワイド", group: "穴", detail: "ワイドの穴（最大5点）" },
  placeAna: { label: "穴の複勝", type: "複勝", group: "穴", detail: "穴の1頭の複勝を1点" },
};
export const TAB_ORDER: TabKey[] = ["single", "hit", "honsen", "confident", "ana", "placeAna"];

type Line = [races: number, hits: number, points: number, returned: number];
type LeagueStats = { period: { from: string; to: string; preFrom: string }; kinds: Record<StatKind, Partial<Record<TabKey, Line>>>; navi: Record<StatKind, [races: number, favWin: number, favTop3: number, trioMan: number]> };
const STATS = (stats as unknown as { leagues: Record<League, LeagueStats> }).leagues;
export const FEW_RACES = 100;

export type TabStat = { key: TabKey; label: string; races: number; hitRate: number; roi: number; points: number; few: boolean };
const r1 = (v: number) => Math.round(v * 10) / 10;
function line(key: TabKey, rows: Array<Line | undefined>): TabStat | null {
  const [races, hits, points, ret] = rows.reduce<Line>((s, v) => v ? [s[0] + v[0], s[1] + v[1], s[2] + v[2], s[3] + v[3]] : s, [0, 0, 0, 0]);
  if (!races || !points) return null;
  return { key, label: BET_TABS[key].label, races, hitRate: r1(100 * hits / races), roi: r1(ret / points), points: r1(points / races), few: races < FEW_RACES };
}
// 中央は鉄板で分けても差が出なかったので、固めは1つにまとめて見せる。
export function statKinds(league: League, kind: RaceKind, teppan: boolean): StatKind[] {
  if (kind !== "solid") return [kind];
  if (league === "jra") return ["solidT", "solidO"];
  return [teppan ? "solidT" : "solidO"];
}
export function tabStats(league: League, kinds: StatKind[]): TabStat[] {
  const s = STATS[league];
  return TAB_ORDER.map(key => line(key, kinds.map(k => s.kinds[k]?.[key]))).filter((v): v is TabStat => !!v);
}
export function allTabStats(league: League): TabStat[] {
  return tabStats(league, ["solidT", "solidO", "middle", "rough"]);
}

// タブの印：そのレースの型で、過去の回収率が高い順に ◎（1つ）→ ○（2つ）→ △、回収率70%未満は ✕。
export function tabMarks(league: League, kinds: StatKind[]): Partial<Record<TabKey, Mark>> {
  const rows = tabStats(league, kinds).filter(r => !r.few).sort((a, b) => b.roi - a.roi || b.hitRate - a.hitRate);
  const marks: Partial<Record<TabKey, Mark>> = {};
  rows.forEach((r, i) => { marks[r.key] = r.roi < 70 ? "✕" : i === 0 ? "◎" : i <= 2 ? "○" : "△"; });
  return marks;
}

export type RaceType = { kind: RaceKind; label: string; teppan: boolean; statKinds: StatKind[] };
type HorseLike = { number: number; odds: number | null };
// teppan：固めのレースで、REIN の本命が単勝1番人気（オッズが一番低い馬）と同じ。
export function raceType(league: League, horses: HorseLike[], mainNumber: number | null | undefined): RaceType | null {
  const classified = classifyRace(league, horses.map(h => h.odds));
  if (!classified) return null;
  const fav = horses.reduce<HorseLike | null>((best, h) => !best || (h.odds as number) < (best.odds as number) || ((h.odds as number) === (best.odds as number) && h.number < best.number) ? h : best, null);
  const teppan = classified.kind === "solid" && mainNumber != null && fav?.number === mainNumber;
  return { kind: classified.kind, label: RACE_KINDS[classified.kind].label, teppan, statKinds: statKinds(league, classified.kind, teppan) };
}

export type BetTab = { key: TabKey; label: string; detail: string; type: string; group: string; selections: string[]; skip: string | null; mark: Mark | null; stat: TabStat | null };
export function buildBetTabs(league: League, tickets: Ticket[], type: RaceType): { tabs: BetTab[]; recommended: TabKey | null } {
  const marks = tabMarks(league, type.statKinds), stat = new Map(tabStats(league, type.statKinds).map(s => [s.key, s]));
  const tabs = TAB_ORDER.map((key): BetTab => {
    const def = BET_TABS[key];
    const selections = tickets.find(t => t.type === def.type)?.tiers.find(t => t.group === def.group)?.selections ?? [];
    const skip = def.solidOnly && type.kind !== "solid" ? "固めのレースではないので見送り" : !selections.length ? "買い目がありません" : null;
    return { key, label: def.label, detail: def.detail, type: def.type === "三連複" ? "3連複" : def.type, group: def.group, selections: skip ? [] : selections, skip, mark: skip ? null : marks[key] ?? null, stat: stat.get(key) ?? null };
  });
  // おすすめ＝印の◎（見送りのときは次に回収率が高いタブ）。
  const open = tabs.filter(t => !t.skip && t.stat && !t.stat.few).sort((a, b) => (b.stat as TabStat).roi - (a.stat as TabStat).roi);
  return { tabs, recommended: open[0]?.key ?? null };
}

// 狙い目ナビ：レースの型ごとの過去の傾向（1番人気の勝率・3着内率、3連複の万馬券率）。
export type NaviKey = "teppan" | "solid" | "middle" | "rough";
export const NAVI_LABELS: Record<NaviKey, { label: string; icon: string; text: string }> = {
  teppan: { label: "鉄板", icon: "◎", text: "人気が集中していて、REINの本命も1番人気と同じレース" },
  solid: { label: "固め", icon: "○", text: "人気が上位に集中しているレース" },
  middle: { label: "中穴", icon: "△", text: "人気がほどよく割れているレース" },
  rough: { label: "荒れそう", icon: "🌀", text: "人気が多くの馬に割れているレース" },
};
export type NaviStat = { races: number; favWin: number; favTop3: number; trioMan: number };
function naviLine(league: League, kinds: StatKind[]): NaviStat {
  const [races, w, t3, man] = kinds.reduce((s, k) => { const v = STATS[league].navi[k]; return [s[0] + v[0], s[1] + v[1], s[2] + v[2], s[3] + v[3]]; }, [0, 0, 0, 0]);
  return { races, favWin: r1(100 * w / races), favTop3: r1(100 * t3 / races), trioMan: r1(100 * man / races) };
}
// 鉄板は地方だけ（中央は REIN の本命が1番人気かどうかで差が出なかった）。
export function naviKey(league: League, type: RaceType): NaviKey {
  if (type.kind === "solid") return league === "nar" && type.teppan ? "teppan" : "solid";
  return type.kind;
}
export function naviStat(league: League, key: NaviKey): NaviStat {
  return naviLine(league, key === "teppan" ? ["solidT"] : key === "solid" ? (league === "nar" ? ["solidO"] : ["solidT", "solidO"]) : [key]);
}
export function naviBase(league: League): NaviStat {
  return naviLine(league, ["solidT", "solidO", "middle", "rough"]);
}
const md = (d: string) => `${Number(d.slice(0, 4))}/${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
export function statsPeriod(league: League) {
  const p = STATS[league].period;
  return { range: `${md(p.from)}〜${md(p.to)}`, note: p.preFrom > p.from ? `${md(p.preFrom)}より前は確定オッズで計算し直した参考値です` : null };
}
