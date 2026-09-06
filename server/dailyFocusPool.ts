import type { DailyCandidateEntry } from "./database.ts";

export type DailyFocusPoolTrendDirection = "strong-up" | "up" | "weakening" | "repairing" | "down" | "flat" | "insufficient";
export type DailyFocusPoolWindowSessions = 2 | 3 | 4 | 5;

export interface DailyFocusPoolQuote {
  code: string;
  name: string;
  tradeDate: string;
  price: number | null;
  pctChange: number | null;
  amount: number | null;
  industryName: string | null;
  quoteAt: string;
}

export interface DailyFocusPoolIndustryLink {
  code: string;
  name: string;
  relevance: number;
}

export interface DailyFocusPoolSource {
  tradeDates: string[];
  windowSessions?: DailyFocusPoolWindowSessions;
  lists: Array<{ tradeDate: string; items: DailyCandidateEntry[] }>;
  quotesByDate: Map<string, DailyFocusPoolQuote[]>;
  clueIndustriesById?: Map<string, DailyFocusPoolIndustryLink[]>;
}

export interface DailyFocusPoolItem {
  code: string;
  name: string;
  focusDates: string[];
  consecutiveDays: 1 | 2 | 3 | 4 | 5;
  firstFocusDate: string;
  lastFocusDate: string;
  sessionsSinceFocus: number;
  isHotIndustry: boolean;
  industries: Array<{ code: string; name: string; hot: boolean; source: "primary" | "clue" }>;
  dailyChanges: Array<{ tradeDate: string; price: number | null; pctChange: number | null }>;
  priceHistory: Array<{ tradeDate: string; price: number; pctChange: number | null; amount: number | null }>;
  entryPrice: number | null;
  latestPrice: number | null;
  windowPctChange: number | null;
  upDays: number;
  downDays: number;
  flatDays: number;
  trend: { direction: DailyFocusPoolTrendDirection; label: string; summary: string };
}

export interface DailyFocusPoolResponse {
  window: { start: string | null; end: string | null; tradeDates: string[]; sessions: DailyFocusPoolWindowSessions; maxSessions: 5 };
  asOf: string | null;
  items: DailyFocusPoolItem[];
  stats: {
    total: number;
    priced: number;
    up: number;
    down: number;
    flat: number;
    upRatio: number | null;
    downRatio: number | null;
    hotIndustry: number;
    hotIndustryRatio: number | null;
  };
}

const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const round = (value: number) => Math.round(value * 10_000) / 10_000;

function analyzeTrend(history: DailyFocusPoolItem["priceHistory"], windowPctChange: number | null): DailyFocusPoolItem["trend"] {
  if (!history.length || windowPctChange === null) return { direction: "insufficient", label: "数据不足", summary: "窗口内有效价格不足，暂不判断趋势。" };
  if (history.length === 1) {
    if (windowPctChange > 0) return { direction: "up", label: "当日走强", summary: `入池当日上涨 ${windowPctChange.toFixed(2)}%，仍需后续交易日确认。` };
    if (windowPctChange < 0) return { direction: "down", label: "当日转弱", summary: `入池当日下跌 ${Math.abs(windowPctChange).toFixed(2)}%，仍需后续交易日确认。` };
    return { direction: "flat", label: "当日平盘", summary: "入池当日价格基本持平，仍需后续交易日确认。" };
  }
  const latestDay = history.at(-1)?.pctChange ?? 0;
  const recent = history.slice(-3);
  const recentRise = recent.length >= 2 && recent.at(-1)!.price > recent[0]!.price;
  const upDays = history.filter((point) => (point.pctChange ?? 0) > 0).length;
  const downDays = history.filter((point) => (point.pctChange ?? 0) < 0).length;
  if (windowPctChange >= 5 && recentRise && upDays >= downDays) return { direction: "strong-up", label: "强势上行", summary: `窗口涨幅 ${windowPctChange.toFixed(2)}%，最近价格仍在抬高。` };
  if (windowPctChange > 0 && recentRise && latestDay >= 0) return { direction: "up", label: "震荡上行", summary: `窗口保持上涨，${upDays} 个交易日收涨。` };
  if (windowPctChange > 0) return { direction: "weakening", label: "上涨趋缓", summary: `窗口仍涨 ${windowPctChange.toFixed(2)}%，但最新价格动能减弱。` };
  if (windowPctChange < 0 && latestDay > 0) return { direction: "repairing", label: "下跌修复", summary: `窗口仍跌 ${Math.abs(windowPctChange).toFixed(2)}%，最新交易日出现修复。` };
  if (windowPctChange < 0) return { direction: "down", label: "弱势下行", summary: `窗口下跌 ${Math.abs(windowPctChange).toFixed(2)}%，${downDays} 个交易日收跌。` };
  return { direction: "flat", label: "横盘整理", summary: "窗口首尾价格基本持平。" };
}

export function buildDailyFocusPool(source: DailyFocusPoolSource): DailyFocusPoolResponse {
  const windowSessions = source.windowSessions ?? 5;
  const tradeDates = [...new Set(source.tradeDates)].sort().slice(-windowSessions);
  const dateIndex = new Map(tradeDates.map((date, index) => [date, index]));
  const occurrences = new Map<string, Array<{ tradeDate: string; item: DailyCandidateEntry }>>();
  for (const list of source.lists.filter((value) => dateIndex.has(value.tradeDate))) {
    for (const item of list.items) {
      const values = occurrences.get(item.code) ?? [];
      values.push({ tradeDate: list.tradeDate, item });
      occurrences.set(item.code, values);
    }
  }
  const quoteMaps = new Map(tradeDates.map((date) => [date, new Map((source.quotesByDate.get(date) ?? []).map((quote) => [quote.code, quote]))]));
  const items = [...occurrences.entries()].map(([code, rawOccurrences]): DailyFocusPoolItem => {
    const values = rawOccurrences.sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
    const focusDates = [...new Set(values.map((value) => value.tradeDate))];
    const focusSet = new Set(focusDates);
    const lastFocusDate = focusDates.at(-1)!;
    const lastFocusIndex = dateIndex.get(lastFocusDate) ?? tradeDates.length - 1;
    let consecutiveDays = 0;
    for (let index = lastFocusIndex; index >= 0 && focusSet.has(tradeDates[index]!); index -= 1) consecutiveDays += 1;
    const boundedConsecutiveDays = Math.max(1, Math.min(5, consecutiveDays)) as 1 | 2 | 3 | 4 | 5;
    const firstFocusDate = focusDates[0]!;
    const dailyChanges = tradeDates.map((date) => {
      const quote = quoteMaps.get(date)?.get(code);
      return { tradeDate: date, price: finite(quote?.price), pctChange: finite(quote?.pctChange) };
    });
    const priceHistory = dailyChanges.flatMap((point) => point.price === null
      ? []
      : [{ ...point, price: point.price, amount: finite(quoteMaps.get(point.tradeDate)?.get(code)?.amount) }]);
    const entryPrice = priceHistory[0]?.price ?? null;
    const latestPrice = priceHistory.at(-1)?.price ?? null;
    const dailyPctChanges = dailyChanges.map((point) => point.pctChange);
    const windowPctChange = dailyPctChanges.every((value): value is number => value !== null)
      ? round((dailyPctChanges.reduce((value, pctChange) => value * (1 + pctChange / 100), 1) - 1) * 100)
      : null;
    const industryMap = new Map<string, { code: string; name: string; hot: boolean; source: "primary" | "clue"; relevance: number }>();
    const addIndustry = (input: { code?: string | null; name?: string | null; hot?: boolean; source: "primary" | "clue"; relevance?: number }) => {
      const name = input.name?.trim();
      if (!name) return;
      const codeValue = input.code?.trim() || `name:${name}`;
      const current = industryMap.get(codeValue);
      const candidate = { code: codeValue, name, hot: Boolean(input.hot), source: input.source, relevance: input.relevance ?? 100 };
      if (!current || Number(candidate.hot) > Number(current.hot) || candidate.relevance > current.relevance) industryMap.set(codeValue, candidate);
    };
    for (const occurrence of values) {
      const snapshot = record(occurrence.item.snapshot);
      const industry = record(snapshot.industry);
      const primaryName = string(industry.name);
      addIndustry({ name: primaryName, hot: occurrence.item.isHotIndustry, source: "primary" });
      const events = Array.isArray(snapshot.events) ? snapshot.events.map(record) : [];
      for (const event of events) {
        const id = string(event.id);
        if (!id) continue;
        for (const link of source.clueIndustriesById?.get(id) ?? []) addIndustry({ code: link.code, name: link.name, source: "clue", relevance: link.relevance });
      }
    }
    for (const date of tradeDates) addIndustry({ name: quoteMaps.get(date)?.get(code)?.industryName, source: "primary" });
    const latestOccurrence = values.at(-1)!;
    const latestSnapshot = record(latestOccurrence.item.snapshot);
    const latestQuote = [...tradeDates].reverse().map((date) => quoteMaps.get(date)?.get(code)).find(Boolean);
    const name = string(latestSnapshot.name) ?? latestQuote?.name ?? code;
    const upDays = priceHistory.filter((point) => (point.pctChange ?? 0) > 0).length;
    const downDays = priceHistory.filter((point) => (point.pctChange ?? 0) < 0).length;
    const flatDays = priceHistory.filter((point) => point.pctChange === 0).length;
    return {
      code,
      name,
      focusDates,
      consecutiveDays: boundedConsecutiveDays,
      firstFocusDate,
      lastFocusDate,
      sessionsSinceFocus: Math.max(0, tradeDates.length - 1 - lastFocusIndex),
      isHotIndustry: values.some((value) => value.item.isHotIndustry),
      industries: [...industryMap.values()].sort((left, right) => Number(right.hot) - Number(left.hot) || Number(right.source === "primary") - Number(left.source === "primary") || right.relevance - left.relevance || left.name.localeCompare(right.name, "zh-Hans-CN")).slice(0, 6).map(({ relevance: _relevance, ...industry }) => industry),
      dailyChanges,
      priceHistory,
      entryPrice,
      latestPrice,
      windowPctChange,
      upDays,
      downDays,
      flatDays,
      trend: analyzeTrend(priceHistory, windowPctChange),
    };
  }).sort((left, right) => Number(right.isHotIndustry) - Number(left.isHotIndustry) || (right.windowPctChange ?? -Infinity) - (left.windowPctChange ?? -Infinity) || right.focusDates.length - left.focusDates.length || left.code.localeCompare(right.code));
  const priced = items.filter((item) => item.windowPctChange !== null);
  const up = priced.filter((item) => item.windowPctChange! > 0).length;
  const down = priced.filter((item) => item.windowPctChange! < 0).length;
  const flat = priced.length - up - down;
  const hotIndustry = items.filter((item) => item.isHotIndustry).length;
  const quoteTimes = tradeDates.flatMap((date) => (source.quotesByDate.get(date) ?? []).map((quote) => quote.quoteAt)).filter(Boolean).sort();
  return {
    window: { start: tradeDates[0] ?? null, end: tradeDates.at(-1) ?? null, tradeDates, sessions: windowSessions, maxSessions: 5 },
    asOf: quoteTimes.at(-1) ?? null,
    items,
    stats: {
      total: items.length,
      priced: priced.length,
      up,
      down,
      flat,
      upRatio: priced.length ? round(up / priced.length) : null,
      downRatio: priced.length ? round(down / priced.length) : null,
      hotIndustry,
      hotIndustryRatio: items.length ? round(hotIndustry / items.length) : null,
    },
  };
}
