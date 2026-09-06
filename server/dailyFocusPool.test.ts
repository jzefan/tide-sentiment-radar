import assert from "node:assert/strict";
import test from "node:test";
import type { DailyCandidateEntry } from "./database.ts";
import { buildDailyFocusPool, type DailyFocusPoolQuote } from "./dailyFocusPool.ts";

const dates = ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-31"];

const entry = (code: string, overrides: Partial<DailyCandidateEntry> = {}): DailyCandidateEntry => ({
  code,
  rank: 1,
  grade: "A",
  isHotIndustry: false,
  baseScore: 80,
  overheatPenalty: 0,
  finalScore: 80,
  scores: {},
  snapshot: { name: `股票${code}`, industry: { name: "制造业" }, events: [] },
  reasons: [],
  ...overrides,
});

const quote = (tradeDate: string, code: string, price: number, pctChange: number, industryName = "制造业"): DailyFocusPoolQuote => ({
  code,
  name: `股票${code}`,
  tradeDate,
  price,
  pctChange,
  amount: 200_000_000,
  industryName,
  quoteAt: `${tradeDate}T15:00:00+08:00`,
});

test("builds a five-session pool with true consecutive streaks, price outcomes, and multiple industries", () => {
  const lists = dates.map((tradeDate, index) => ({
    tradeDate,
    items: [
      ...(index >= 1 ? [entry("600001", {
        isHotIndustry: true,
        snapshot: { name: "芯片龙头", industry: { name: "半导体" }, events: [{ id: "clue-chip" }] },
      })] : []),
      ...(index === 4 || index === 5 ? [entry("600002")] : []),
      ...(index === 1 ? [entry("600003")] : []),
      ...(index === 1 || index === 2 || index === 4 ? [entry("600004")] : []),
      ...(index === 5 ? [entry("600005")] : []),
      ...(index === 0 ? [entry("600099")] : []),
    ],
  }));
  const prices: Record<string, number[]> = {
    "600001": [10, 10.3, 10.5, 10.8, 11],
    "600002": [20, 20, 20, 20, 19],
    "600003": [30, 30.2, 30.5, 30.8, 31],
    "600004": [40, 40, 40, 40, 40],
    "600005": [14, 14, 14, 14.5, 15],
  };
  const pctChanges: Record<string, number[]> = {
    "600001": [1, 3, 1.9, 2.9, 1.9],
    "600002": [0, 0, 0, 0.5, -5],
    "600003": [2, 0.7, 1, 1, 0.6],
    "600004": [0, 0, 0, 0, 0],
    "600005": [0, 0, 0, 0, 3],
  };
  const activeDates = dates.slice(1);
  const quotesByDate = new Map(activeDates.map((tradeDate, dateIndex) => [tradeDate, Object.entries(prices).flatMap(([code, values]) => {
    return [quote(tradeDate, code, values[dateIndex]!, pctChanges[code]![dateIndex]!, code === "600001" ? "半导体" : "制造业")];
  })]));

  const source = {
    tradeDates: dates,
    lists,
    quotesByDate,
    clueIndustriesById: new Map([["clue-chip", [
      { code: "BK0917", name: "芯片概念", relevance: 95 },
      { code: "BK0737", name: "人工智能", relevance: 86 },
    ]]]),
  };
  const pool = buildDailyFocusPool(source);

  assert.deepEqual(pool.window.tradeDates, activeDates);
  assert.equal(pool.items.some((item) => item.code === "600099"), false, "stocks older than five sessions leave the pool");
  assert.equal(pool.items.length, 5);

  const continuousFive = pool.items.find((item) => item.code === "600001")!;
  assert.equal(continuousFive.consecutiveDays, 5);
  assert.equal(continuousFive.windowPctChange, 11.1533);
  assert.deepEqual(continuousFive.dailyChanges.map((point) => [point.tradeDate, point.pctChange]), activeDates.map((tradeDate, index) => [tradeDate, pctChanges["600001"]![index]]));
  assert.equal(continuousFive.trend.direction, "strong-up");
  assert.deepEqual(continuousFive.industries.map((industry) => industry.name), ["半导体", "芯片概念", "人工智能"]);

  const continuousTwo = pool.items.find((item) => item.code === "600002")!;
  assert.equal(continuousTwo.consecutiveDays, 2);
  assert.equal(continuousTwo.windowPctChange, -4.525);
  assert.equal(continuousTwo.trend.direction, "down");

  const expiredSignal = pool.items.find((item) => item.code === "600003")!;
  assert.equal(expiredSignal.consecutiveDays, 1);
  assert.equal(expiredSignal.sessionsSinceFocus, 4);
  assert.equal(expiredSignal.windowPctChange, 5.4072);

  const brokenStreak = pool.items.find((item) => item.code === "600004")!;
  assert.equal(brokenStreak.consecutiveDays, 1, "a gap must break the streak instead of counting total appearances");
  assert.equal(brokenStreak.sessionsSinceFocus, 1);
  assert.equal(brokenStreak.windowPctChange, 0);

  const today = pool.items.find((item) => item.code === "600005")!;
  assert.equal(today.trend.label, "震荡上行");
  assert.equal(today.windowPctChange, 3);
  assert.deepEqual(pool.stats, {
    total: 5,
    priced: 5,
    up: 3,
    down: 1,
    flat: 1,
    upRatio: 0.6,
    downRatio: 0.2,
    hotIndustry: 1,
    hotIndustryRatio: 0.2,
  });

  const twoSessionPool = buildDailyFocusPool({ ...source, windowSessions: 2 });
  assert.deepEqual(twoSessionPool.window.tradeDates, dates.slice(-2));
  assert.equal(twoSessionPool.window.sessions, 2);
  assert.deepEqual(twoSessionPool.items.map((item) => item.code).sort(), ["600001", "600002", "600004", "600005"]);
  assert.equal(twoSessionPool.items.every((item) => item.dailyChanges.length === 2), true);
  assert.equal(twoSessionPool.items.find((item) => item.code === "600001")?.windowPctChange, 4.8551);
});
