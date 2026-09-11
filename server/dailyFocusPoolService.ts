import {
  getClueIndustryLinks,
  getMarketQuotesByTradeDate,
  listDailyCandidateLists,
  listTradeDates,
  type DailyCandidateEntry,
} from "./database.ts";
import { buildDailyFocusPool, type DailyFocusPoolQuote, type DailyFocusPoolResponse, type DailyFocusPoolWindowSessions } from "./dailyFocusPool.ts";
import { readLeadershipDayRows } from "./leadershipSync.ts";
import { normalizeIndustryName } from "./industry.ts";

export interface LiveDailyFocusPoolList {
  tradeDate: string;
  items: DailyCandidateEntry[];
}

const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** 可用于选择观察截止日的交易日（倒序，含最新）。 */
export function listFocusPoolTradeDates(): string[] {
  return [...new Set(listTradeDates())].sort().reverse();
}

/**
 * Builds the current short-trading pool. Historical reconstructions stay excluded.
 * `windowEndDate` anchors the window on any retained trading day; omitting it keeps the latest window.
 */
export function getDailyFocusPool(windowSessions: DailyFocusPoolWindowSessions = 5, liveList?: LiveDailyFocusPoolList | null, windowEndDate?: string | null): DailyFocusPoolResponse {
  const availableTradeDates = listFocusPoolTradeDates();
  const anchorDate = windowEndDate && availableTradeDates.includes(windowEndDate) ? windowEndDate : null;
  // 只取窗口内的行情，避免为了看历史窗口而读入全部交易日。
  const eligible = anchorDate ? availableTradeDates.filter((date) => date <= anchorDate) : availableTradeDates;
  const tradeDates = eligible.slice(0, windowSessions).sort();
  const listByDate = new Map(listDailyCandidateLists()
    .filter((list) => tradeDates.includes(list.tradeDate) && list.status === "frozen")
    .map((list) => [list.tradeDate, { tradeDate: list.tradeDate, items: list.items }]));
  if (liveList && tradeDates.includes(liveList.tradeDate)) listByDate.set(liveList.tradeDate, { tradeDate: liveList.tradeDate, items: liveList.items });
  const lists = [...listByDate.values()].sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
  const quotesByDate = new Map(tradeDates.map((tradeDate) => [
    tradeDate,
    getMarketQuotesByTradeDate(tradeDate).map((quote): DailyFocusPoolQuote => ({
      code: quote.code,
      name: quote.name,
      tradeDate,
      price: quote.price,
      pctChange: quote.pctChange,
      amount: quote.amount,
      industryName: quote.industryName,
      quoteAt: quote.quoteAt,
    })),
  ]));
  const clueIds = new Set(lists.flatMap((list) => list.items.flatMap((item) => {
    const events = record(item.snapshot).events;
    return Array.isArray(events) ? events.flatMap((event) => {
      const id = record(event).id;
      return typeof id === "string" && id.trim() ? [id.trim()] : [];
    }) : [];
  })));
  const clueIndustriesById = new Map([...clueIds].map((id) => [id, getClueIndustryLinks(id).map((link) => ({
    code: link.industryCode,
    name: link.industryName,
    relevance: link.relevance,
  }))]));
  // 龙头事实按窗口逐日读取：未取证的日期不参与标注，池子不会凭空出现“龙头”。
  const leadershipByDate = new Map<string, ReturnType<typeof readLeadershipDayRows>>();
  for (const tradeDate of tradeDates) {
    const quotes = quotesByDate.get(tradeDate) ?? [];
    const industryByCode = new Map(quotes.map((quote) => [quote.code, normalizeIndustryName(quote.industryName)]));
    const rows = readLeadershipDayRows(tradeDate, industryByCode);
    if (rows.length) leadershipByDate.set(tradeDate, rows);
  }
  return buildDailyFocusPool({
    tradeDates,
    windowSessions,
    windowEndDate: anchorDate,
    availableTradeDates,
    latestTradeDate: availableTradeDates[0] ?? null,
    livePreviewDate: liveList?.tradeDate ?? null,
    lists,
    quotesByDate,
    clueIndustriesById,
    leadershipByDate,
  });
}
