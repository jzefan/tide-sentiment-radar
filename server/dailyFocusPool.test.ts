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
    leaders: 0,
    leaderRatio: 0,
  });

  const twoSessionPool = buildDailyFocusPool({ ...source, windowSessions: 2 });
  assert.deepEqual(twoSessionPool.window.tradeDates, dates.slice(-2));
  assert.equal(twoSessionPool.window.sessions, 2);
  assert.deepEqual(twoSessionPool.items.map((item) => item.code).sort(), ["600001", "600002", "600004", "600005"]);
  assert.equal(twoSessionPool.items.every((item) => item.dailyChanges.length === 2), true);
  assert.equal(twoSessionPool.items.find((item) => item.code === "600001")?.windowPctChange, 4.8551);
});

test("anchors the window on any retained trading day and reports how to return to the latest", () => {
  const quotesByDate = new Map(dates.map((tradeDate) => [tradeDate, [quote(tradeDate, "600001", 10, 1)]]));
  const source = { tradeDates: dates, windowSessions: 3 as const, lists: [], quotesByDate };

  const latest = buildDailyFocusPool(source);
  assert.deepEqual(latest.window.tradeDates, dates.slice(-3));
  assert.equal(latest.window.latestTradeDate, dates.at(-1));
  assert.equal(latest.window.isLatest, true);
  assert.deepEqual(latest.window.availableTradeDates, [...dates].reverse(), "日期下拉需要全部已留存交易日，倒序且最新在前");

  const anchored = buildDailyFocusPool({ ...source, windowEndDate: "2026-08-27" });
  assert.deepEqual(anchored.window.tradeDates, ["2026-08-25", "2026-08-26", "2026-08-27"], "点选 08-27 即以该日结束窗口");
  assert.equal(anchored.window.end, "2026-08-27");
  assert.equal(anchored.window.isLatest, false);
  assert.equal(anchored.window.latestTradeDate, dates.at(-1), "历史窗口仍然告知最新交易日，便于回到最新");

  const earliest = buildDailyFocusPool({ ...source, windowEndDate: dates[0] });
  assert.deepEqual(earliest.window.tradeDates, [dates[0]!], "窗口不足 N 个交易日时只展示已存在的部分，不补造日期");
  assert.equal(earliest.window.start, dates[0]);

  const unknown = buildDailyFocusPool({ ...source, windowEndDate: "2026-01-01" });
  assert.deepEqual(unknown.window.tradeDates, dates.slice(-3), "未知日期回落到最新窗口，而不是给出空窗口");
  assert.equal(unknown.window.isLatest, true);
});

test("marks pool members that were the market or industry leader on a certified trading day", () => {
  const windowDates = dates.slice(-3);
  const quotesByDate = new Map(windowDates.map((tradeDate) => [tradeDate, [
    quote(tradeDate, "600001", 10, 1, "半导体"),
    quote(tradeDate, "600002", 10, 1, "半导体"),
    quote(tradeDate, "600003", 10, 1, "制造业"),
  ]]));
  const lists = windowDates.map((tradeDate) => ({ tradeDate, items: [entry("600001"), entry("600002"), entry("600003")] }));
  const leadershipRow = (tradeDate: string, code: string, boardCount: number, firstSealTime: string | null, industryName: string) => ({
    code,
    name: `股票${code}`,
    tradeDate,
    industryName,
    boardCount,
    firstSealTime,
    lastSealTime: firstSealTime,
    breakCount: 0,
    sealAmount: null,
    amount: 200_000_000,
    dragonTiger: null,
  });
  const leadershipByDate = new Map([
    // 08-27：600001 为全市场最高 3 板，600002 在半导体行业内涨停但落后，600003 首板。
    ["2026-08-27", [leadershipRow("2026-08-27", "600001", 3, "09:31:00", "半导体"), leadershipRow("2026-08-27", "600002", 2, "10:05:00", "半导体"), leadershipRow("2026-08-27", "600003", 1, "13:40:00", "制造业")]],
    // 08-28：600002 反超成为 4 板市场龙头。
    ["2026-08-28", [leadershipRow("2026-08-28", "600002", 4, "09:25:00", "半导体"), leadershipRow("2026-08-28", "600001", 1, "14:20:00", "半导体")]],
  ]);
  const pool = buildDailyFocusPool({ tradeDates: dates, windowSessions: 3, lists, quotesByDate, leadershipByDate });

  const first = pool.items.find((item) => item.code === "600001")!;
  assert.equal(first.leadership.isLeader, true);
  assert.equal(first.leadership.tier, "market");
  assert.equal(first.leadership.maxBoardCount, 3);
  assert.deepEqual(first.leadership.limitUpDates, ["2026-08-27", "2026-08-28"]);
  assert.match(first.leadership.reasons.join(" "), /全市场最高梯队/);

  const second = pool.items.find((item) => item.code === "600002")!;
  assert.equal(second.leadership.isLeader, true);
  assert.equal(second.leadership.tier, "market", "market leadership on any window day outranks industry-only days");
  assert.equal(second.leadership.maxBoardCount, 4);
  assert.equal(second.leadership.lastFirstSealTime, "09:25:00", "最近一个涨停日的首次封板时间");

  const third = pool.items.find((item) => item.code === "600003")!;
  assert.equal(third.leadership.tier, null);
  assert.equal(third.leadership.label, "1 连板");
  assert.deepEqual(third.leadership.reasons, ["窗口内最高 1 连板"]);

  assert.equal(pool.stats.leaders, 2);
  assert.equal(pool.stats.leaderRatio, 0.6667);
  assert.deepEqual(pool.items.slice(0, 2).map((item) => item.code).sort(), ["600001", "600002"], "龙头排在列表最前");
  assert.equal(pool.window.listDates.length, 3, "池子只由窗口内有聚焦名单的日期构成");
});

test("leaves leadership unverified when a window day has no certified limit-up data", () => {
  const quotesByDate = new Map(dates.slice(-2).map((tradeDate) => [tradeDate, [quote(tradeDate, "600001", 10, 1)]]));
  const lists = dates.slice(-2).map((tradeDate) => ({ tradeDate, items: [entry("600001")] }));
  const pool = buildDailyFocusPool({ tradeDates: dates, windowSessions: 2, lists, quotesByDate });
  const item = pool.items[0]!;
  assert.equal(item.leadership.isLeader, false);
  assert.equal(item.leadership.tier, null);
  assert.equal(item.leadership.maxBoardCount, null);
  assert.deepEqual(item.leadership.reasons, []);
  assert.equal(pool.window.listDates.length, 2);
  assert.equal(pool.window.livePreviewDate, null);
});

test("keeps the latest trading day aware when the service only passes the anchored window", () => {
  const quotesByDate = new Map(dates.map((tradeDate) => [tradeDate, [quote(tradeDate, "600001", 10, 1)]]));
  const windowDates = ["2026-08-26", "2026-08-27", "2026-08-28"];
  const pool = buildDailyFocusPool({
    tradeDates: windowDates,
    windowSessions: 3,
    windowEndDate: "2026-08-28",
    latestTradeDate: dates.at(-1),
    availableTradeDates: [...dates].reverse(),
    lists: [],
    quotesByDate,
  });
  assert.deepEqual(pool.window.tradeDates, windowDates);
  assert.equal(pool.window.latestTradeDate, "2026-08-31");
  assert.equal(pool.window.isLatest, false, "只传窗口内行情时，历史窗口不能被误判成最新窗口");
});

test("keeps a per-day focus reason timeline so repeated names explain themselves", () => {
  const windowDates = dates.slice(-3);
  const quotesByDate = new Map(windowDates.map((tradeDate) => [tradeDate, [
    quote(tradeDate, "600001", 10, 1),
    quote(tradeDate, "600002", 10, 1),
  ]]));
  const focusEntry = (tradeDate: string, code: string, lane: string, focusType: string, title: string) => entry(code, {
    snapshot: { name: `股票${code}`, industry: { name: "半导体" }, events: [], lane, focusType, primaryEvent: { title } },
  });
  const lists = [
    { tradeDate: windowDates[0]!, items: [focusEntry(windowDates[0]!, "600001", "event", "research", "签署重大合同")] },
    { tradeDate: windowDates[1]!, items: [focusEntry(windowDates[1]!, "600001", "dual", "research-hot", "签署重大合同的进展")] },
    { tradeDate: windowDates[2]!, items: [focusEntry(windowDates[2]!, "600001", "dual", "research-hot", "签署重大合同的进展"), entry("600002")] },
  ];
  const pool = buildDailyFocusPool({ tradeDates: dates, windowSessions: 3, lists, quotesByDate });

  const tracked = pool.items.find((item) => item.code === "600001")!;
  assert.deepEqual(tracked.focus.timeline.map((point) => [point.tradeDate, point.lane, point.focusType]), [
    [windowDates[0], "event", "research"],
    [windowDates[1], "dual", "research-hot"],
    [windowDates[2], "dual", "research-hot"],
  ]);
  assert.equal(tracked.focus.changed, true, "通道或核心事件变化过就标记 changed");
  assert.equal(tracked.focus.lane, "dual", "取最近一个聚焦日");
  assert.equal(tracked.focus.focusType, "research-hot");
  assert.equal(tracked.focus.primaryEventTitle, "签署重大合同的进展");

  const legacy = pool.items.find((item) => item.code === "600002")!;
  assert.deepEqual(legacy.focus.timeline, [{ tradeDate: windowDates[2], lane: null, focusType: null, primaryEventTitle: null }]);
  assert.equal(legacy.focus.changed, false, "旧冻结记录没有通道字段时留白，不猜测");
  assert.equal(legacy.focus.lane, null);
});
