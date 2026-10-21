import type { Horse } from "./horse-types";
import { historyFactors, historyRate, careerDifference } from "./horse-research";

export const CONDITION_ROWS = [
  { label: "距離", factor: "距離適性" },
  { label: "競馬場", factor: "競馬場適性" },
  { label: "芝・ダート", factor: "芝ダ適性" },
  { label: "近5走", factor: "近5走" },
  { label: "馬場状態", factor: "馬場適性" },
  { label: "血統", factor: "血統適性" },
  { label: "騎手との相性", factor: "騎手相性" },
] as const;

export function conditionSymbol(horse: Horse, label: string) {
  const factors = historyFactors(horse), factor = factors.find(f => f.label === label);
  const career = factors.find(f => f.label === "通算成績");
  const rate = historyRate(factor, "top3"), diff = factor ? careerDifference(factor, career) : null;
  const samples = factor?.samples ?? 0;
  const sufficient = samples >= (label === "近5走" ? 5 : 10) && (career?.samples ?? 0) >= 20;
  const symbol = sufficient && diff !== null ? diff >= 15 ? "◎" : diff >= 5 ? "○" : diff >= -5 ? "△" : "×" : "—";
  const reason = rate === null ? "実績未取得" : `${samples}走・3着内率 ${rate.toFixed(1)}%${diff === null ? "" : `・通算比 ${diff > 0 ? "+" : ""}${diff.toFixed(1)}pt`}`;
  return { symbol, samples, rate, diff, detail: `${reason}${symbol === "—" && rate !== null ? "・判定に必要な実績または比較基準が不足" : ""}` };
}
