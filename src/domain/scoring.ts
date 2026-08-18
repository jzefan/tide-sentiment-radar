import type { ScoreFactors, SignalLabel } from "./types";

const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value));

export function calculateRadarScore(factors: ScoreFactors): number {
  if (Math.abs(factors.sentiment) < 8) return 50;

  const direction = Math.sign(factors.sentiment);
  const strength = Math.min(1, Math.abs(factors.sentiment) / 100);
  const evidenceWeight =
    0.2 +
    (factors.attention / 100) * 0.2 +
    (factors.consensus / 100) * 0.15 +
    (factors.sourceQuality / 100) * 0.15 +
    (factors.priceConfirm / 100) * 0.15 +
    (factors.freshness / 100) * 0.15;

  return Math.round(clamp(50 + 50 * direction * strength * evidenceWeight));
}

export function calculateAlertScore(factors: ScoreFactors): number {
  return Math.round(clamp(
    factors.velocity * 0.35 +
    factors.attention * 0.25 +
    factors.sourceQuality * 0.2 +
    Math.abs(factors.sentiment) * 0.2,
  ));
}

export function signalFromFactors(
  factors: ScoreFactors,
  radarScore = calculateRadarScore(factors),
): SignalLabel {
  if (factors.consensus < 46 && factors.attention > 66) return "高分歧";
  if (factors.sentiment < -30 && radarScore < 42) return "风险升温";
  if (factors.sentiment > 35 && factors.priceConfirm > 56 && radarScore > 66) {
    return "偏多共振";
  }
  return "热度观察";
}

export const scoreFormula = [
  { label: "讨论增速", weight: 35, key: "velocity" },
  { label: "互动热度", weight: 25, key: "attention" },
  { label: "来源广度", weight: 20, key: "sourceQuality" },
  { label: "情绪位移", weight: 20, key: "sentiment" },
] as const;
