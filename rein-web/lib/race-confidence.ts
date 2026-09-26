export const RACE_CONFIDENCE_THRESHOLDS = {
  cautious: 0.5605698038816331,
  standard: 0.6292787977730023,
  high: 0.687187131160703,
} as const;

export type RaceConfidenceLevel = "慎重" | "標準" | "高め" | "かなり高い";

export type RaceConfidence = {
  label: RaceConfidenceLevel;
  top3Share: number;
  sharePercent: number;
  detail: string;
  note: string;
};

const DETAILS: Record<RaceConfidenceLevel, string> = {
  慎重: "上位3頭とそれ以下の差は小さめです。",
  標準: "上位3頭がやや優勢です。",
  高め: "上位3頭が明確に優勢です。",
  かなり高い: "上位3頭への指数集中が非常に強いです。",
};

export function raceConfidenceLevel(top3Share: number): RaceConfidenceLevel {
  if (top3Share <= RACE_CONFIDENCE_THRESHOLDS.cautious) return "慎重";
  if (top3Share <= RACE_CONFIDENCE_THRESHOLDS.standard) return "標準";
  if (top3Share <= RACE_CONFIDENCE_THRESHOLDS.high) return "高め";
  return "かなり高い";
}

export function buildRaceConfidence(
  sourceScores: Array<number | null | undefined>,
): RaceConfidence | null {
  if (sourceScores.length < 4) return null;
  const scores = sourceScores.filter(
    (score): score is number =>
      typeof score === "number" && Number.isFinite(score) && score > 0,
  );
  if (scores.length !== sourceScores.length) return null;

  scores.sort((a, b) => b - a);
  const total = scores.reduce((sum, score) => sum + score, 0);
  if (!(total > 0)) return null;
  const top3Share = scores.slice(0, 3).reduce((sum, score) => sum + score, 0) / total;
  const label = raceConfidenceLevel(top3Share);
  return {
    label,
    top3Share: Number(top3Share.toFixed(6)),
    sharePercent: Number((top3Share * 100).toFixed(1)),
    detail: DETAILS[label],
    note: "上位3頭への集中度です。期待回収率や賭け金を示すものではありません。",
  };
}
