import {
  getClueIndustryLinks,
  getMarketQuotesByTradeDate,
  listDailyCandidateLists,
  listTradeDates,
  type DailyCandidateEntry,
} from "./database.ts";
import { buildDailyFocusPool, type DailyFocusPoolQuote, type DailyFocusPoolResponse, type DailyFocusPoolWindowSessions } from "./dailyFocusPool.ts";

export interface LiveDailyFocusPoolList {
  tradeDate: string;
  items: DailyCandidateEntry[];
}

const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Builds the current five-session short-trading pool. Historical reconstructions stay excluded. */
export function getDailyFocusPool(windowSessions: DailyFocusPoolWindowSessions = 5, liveList?: LiveDailyFocusPoolList | null): DailyFocusPoolResponse {
  const tradeDates = listTradeDates().slice(0, windowSessions).sort();
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
  return buildDailyFocusPool({ tradeDates, windowSessions, lists, quotesByDate, clueIndustriesById });
}
