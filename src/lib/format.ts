import type { SentimentTone } from "../domain/types";

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function toneLabel(tone: SentimentTone): string {
  return { positive: "偏正面", negative: "偏负面", mixed: "多空分歧", neutral: "中性" }[tone];
}

export function changeLabel(value: number, suffix = "%"): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}${suffix}`;
}
