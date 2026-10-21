import type { Horse } from "./horse-types";
import { historyFactors, historyRate, careerDifference } from "./horse-research";

export const CONDITION_ROWS = [
  { label: "通算", factor: "通算成績" },
  { label: "距離", factor: "距離適性" },
  { label: "競馬場", factor: "競馬場適性" },
  { label: "芝・ダート", factor: "芝ダ適性" },
  { label: "近5走", factor: "近5走" },
  { label: "馬場状態", factor: "馬場適性" },
  { label: "血統", factor: "血統適性" },
  { label: "騎手との相性", factor: "騎手相性" },
] as const;
export function availableConditionRows(horses: Horse[]) {
  return CONDITION_ROWS.filter(row => horses.some(h => historyRate(historyFactors(h).find(f => f.label === row.factor), "top3") !== null));
}

export function conditionSymbol(horse: Pick<Horse, "parameterFactors" | "historyFactors" | "jockey">, label: string) {
  const factors = historyFactors(horse), factor = factors.find(f => f.label === label);
  const career = factors.find(f => f.label === "通算成績");
  const rate = historyRate(factor, "top3");
  const baseline = factor?.baseline !== undefined && Number.isFinite(factor.baseline) ? factor.baseline : null;
  const diff = !factor ? null : careerDifference(factor, career) ?? (rate !== null && baseline !== null ? rate - baseline : null);
  const samples = factor?.samples ?? 0;
  const confidence = rate === null ? "missing" : samples < 5 ? "reference" : "standard";
  // Keep sparse observed records visible; shrink differences rather than discarding the record.
  const adjustedDiff = diff === null ? null : diff * Math.min(1, samples / 5);
  const adjustedRate = rate === null ? null : (rate * samples + 100 / 3 * 5) / (samples + 5);
  const symbol = rate === null ? "—" : adjustedDiff !== null
    ? adjustedDiff >= 15 ? "◎" : adjustedDiff >= 5 ? "○" : adjustedDiff >= -5 ? "△" : "×"
    : adjustedRate! >= 60 ? "◎" : adjustedRate! >= 40 ? "○" : adjustedRate! >= 20 ? "△" : "×";
  // The official card gives today's jockey's record on this horse, including first rides.
  const rider = label === "騎手相性" && factor?.record ? (horse.jockey?.trim() ? `${horse.jockey.trim()}騎手` : "今回の騎手") : "";
  const reason = rate === null ? rider ? `${rider}とは初コンビ（騎乗実績なし）` : "該当実績なし・未取得" : `${rider ? `${rider}で${factor!.record}・` : ""}${factor?.subject ? `${factor.subject} ` : ""}${samples}走・3着内率 ${rate.toFixed(1)}%${diff === null ? "・実績率による参考評価" : `・${baseline !== null ? `産駒全体（${baseline.toFixed(1)}%）比` : "通算比"} ${diff > 0 ? "+" : ""}${diff.toFixed(1)}pt`}`;
  return { symbol, samples, rate, diff, confidence, adjustedRate, detail: `${reason}${confidence === "reference" ? "・少数実績の参考判定（補正あり）" : ""}` };
}
