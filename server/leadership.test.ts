import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveDailyLeaders,
  leadershipLabel,
  mergeLeadershipDay,
  normalizeSealTime,
  parseDragonTigerPayload,
  parseLimitUpPoolPayload,
  sealMinutesFromOpen,
  verifyLimitUpAgainstQuotes,
  type LeadershipDayRow,
  type LimitUpRecord,
} from "./leadership.ts";

const ztPayload = {
  rc: 0,
  data: {
    tc: 3,
    qdate: 20260911,
    pool: [
      { c: "000978", m: 0, n: "桂林旅游", p: 9690, zdp: 9.988649368286133, amount: 771858384, ltsz: 4536097945, hs: 17.27, lbc: 4, fbt: 92500, lbt: 93803, fund: 70007963, zbc: 1, hybk: "旅游及景", zttj: { days: 4, ct: 4 } },
      { c: "600318", m: 1, n: "新力金融", p: 8090, zdp: 10.068, amount: 920574928, hs: 22.46, lbc: 1, fbt: 92501, lbt: 143946, fund: 44051668, zbc: 6, hybk: "多元金融", zttj: { days: 1, ct: 1 } },
      { c: "830001", m: 2, n: "北交样本", p: 12000, zdp: 29.9, amount: 1000, lbc: 2, fbt: 100000, lbt: 100000, zbc: 0, hybk: "专用设备" },
    ],
  },
};

const billboardPayload = {
  result: {
    pages: 1,
    data: [
      { SECURITY_CODE: "000978", SECURITY_NAME_ABBR: "桂林旅游", CLOSE_PRICE: 9.69, CHANGE_RATE: 9.99, BILLBOARD_NET_AMT: 12000000, BILLBOARD_BUY_AMT: 30000000, BILLBOARD_SELL_AMT: 18000000, BILLBOARD_DEAL_AMT: 48000000, TURNOVERRATE: 17.27, EXPLANATION: "日涨幅偏离值达到7%的前5只证券", EXPLAIN: "1家机构买入" },
      // 同一股票因第二个原因再次出现，金额字段是同一份席位明细的重复呈现，不得累加。
      { SECURITY_CODE: "000978", SECURITY_NAME_ABBR: "桂林旅游", CLOSE_PRICE: 9.69, CHANGE_RATE: 9.99, BILLBOARD_NET_AMT: 12000000, BILLBOARD_BUY_AMT: 30000000, BILLBOARD_SELL_AMT: 18000000, BILLBOARD_DEAL_AMT: 48000000, TURNOVERRATE: 17.27, EXPLANATION: "连续三个交易日内涨幅偏离值累计达到20%", EXPLAIN: "1家机构买入" },
      { SECURITY_CODE: "600318", SECURITY_NAME_ABBR: "新力金融", CLOSE_PRICE: 8.09, CHANGE_RATE: 10.07, BILLBOARD_NET_AMT: -4000000, BILLBOARD_BUY_AMT: 10000000, BILLBOARD_SELL_AMT: 14000000, BILLBOARD_DEAL_AMT: 24000000, TURNOVERRATE: 22.46, EXPLANATION: "日换手率达到20%的前5只证券" },
    ],
  },
};

test("normalizes HHMMSS seal times and reports minutes from the auction open", () => {
  assert.equal(normalizeSealTime(92500), "09:25:00");
  assert.equal(normalizeSealTime("143946"), "14:39:46");
  assert.equal(normalizeSealTime(0), null);
  assert.equal(normalizeSealTime(999999), null);
  assert.equal(normalizeSealTime("abc"), null);
  assert.equal(sealMinutesFromOpen("09:25:00"), 0);
  assert.equal(sealMinutesFromOpen("09:31:00"), 6);
  assert.equal(sealMinutesFromOpen("14:00:00"), 275);
  assert.equal(sealMinutesFromOpen(null), null);
});

test("parses the limit-up pool into normalized records and rejects non-pool payloads", () => {
  const rows = parseLimitUpPoolPayload(ztPayload, "2026-09-10");
  assert.equal(rows.length, 3);
  const tourism = rows.find((row) => row.code === "000978")!;
  assert.equal(tourism.exchange, "SZ");
  assert.equal(tourism.close, 9.69, "涨停池价格按 1/1000 元返回");
  assert.equal(tourism.boardCount, 4);
  assert.equal(tourism.firstSealTime, "09:25:00");
  assert.equal(tourism.lastSealTime, "09:38:03");
  assert.equal(tourism.breakCount, 1);
  assert.equal(tourism.statDays, 4);
  assert.equal(tourism.industryName, "旅游及景");
  assert.equal(rows.find((row) => row.code === "830001")!.exchange, "BJ");
  assert.deepEqual(rows.map((row) => row.code), ["000978", "830001", "600318"], "按连板高度、封板时间排序");
  assert.deepEqual(parseLimitUpPoolPayload({ rc: 0, data: null }, "2026-09-06"), [], "非交易日返回空数组");
  assert.throws(() => parseLimitUpPoolPayload({ rc: 1, data: null }, "2026-09-10"), /rc=1/);
});

test("aggregates dragon-tiger rows per stock without double counting repeated amounts", () => {
  const rows = parseDragonTigerPayload(billboardPayload, "2026-09-10");
  assert.equal(rows.length, 2);
  const tourism = rows.find((row) => row.code === "000978")!;
  assert.equal(tourism.netAmount, 12_000_000);
  assert.equal(tourism.dealAmount, 48_000_000);
  assert.equal(tourism.listCount, 2);
  assert.deepEqual(tourism.reasons, ["日涨幅偏离值达到7%的前5只证券", "连续三个交易日内涨幅偏离值累计达到20%"]);
  assert.equal(rows.find((row) => row.code === "600318")!.netAmount, -4_000_000);
});

test("derives market and industry leaders only from today's certified limit-up facts", () => {
  const row = (code: string, boardCount: number, firstSealTime: string | null, industryName: string | null, amount = 100_000_000): LeadershipDayRow => ({
    code, name: code, tradeDate: "2026-09-10", industryName, boardCount, firstSealTime, lastSealTime: firstSealTime,
    breakCount: 0, sealAmount: null, amount, dragonTiger: null,
  });
  const leaders = deriveDailyLeaders([
    row("600001", 5, "09:25:00", "半导体", 900_000_000),
    row("600002", 4, "09:30:00", "半导体"),
    row("600003", 4, "09:31:00", "半导体"),
    row("600004", 3, "10:00:00", "半导体"),
    row("600005", 2, "09:26:00", "汽车零部件"),
    row("600006", 2, "09:40:00", "汽车零部件"),
    row("600007", 1, "09:25:00", "半导体"),
  ], "2026-09-10");

  assert.equal(leaders.maxBoardCount, 5);
  assert.equal(leaders.limitUpCount, 7);
  assert.equal(leaders.industryLimitUpCounts["半导体"], 5);
  // 市场龙头取最高梯队（5 板时取 4–5 板），按连板、封板时间、成交额排序，最多三只。
  assert.deepEqual(Object.keys(leaders.marks).sort(), ["600001", "600002", "600003", "600004", "600005"]);
  assert.equal(leaders.marks["600001"]!.tier, "market");
  assert.match(leaders.marks["600001"]!.reasons.join(" "), /全市场最高梯队（最高 5 板）/);
  assert.equal(leaders.marks["600002"]!.tier, "market");
  assert.equal(leaders.marks["600004"]!.tier, "industry", "三板的 600004 只在本行业内称龙头");
  assert.match(leaders.marks["600004"]!.reasons.join(" "), /半导体 当日涨停 5 家/);
  assert.equal(leaders.marks["600005"]!.tier, "industry");
  assert.equal(leaders.marks["600007"], undefined, "首板不标龙头");
  assert.equal(leadershipLabel("market", 5), "5 连板 · 市场龙头");
  assert.equal(leadershipLabel("industry", 2), "2 连板 · 行业龙头");
  assert.equal(leadershipLabel("none", 1), "1 连板");
  assert.equal(leadershipLabel("none", 0), null);
});

test("marks nothing when the session has no limit-up of at least two boards", () => {
  const leaders = deriveDailyLeaders([{
    code: "600001", name: "首板", tradeDate: "2026-09-10", industryName: "半导体", boardCount: 1,
    firstSealTime: "09:25:00", lastSealTime: "09:25:00", breakCount: 0, sealAmount: null, amount: 1, dragonTiger: null,
  }], "2026-09-10");
  assert.equal(leaders.maxBoardCount, 1);
  assert.deepEqual(leaders.marks, {});
});

test("merges limit-up and dragon-tiger facts per stock and keeps industry overrides", () => {
  const limitUp = parseLimitUpPoolPayload(ztPayload, "2026-09-10");
  const dragonTiger = parseDragonTigerPayload(billboardPayload, "2026-09-10");
  const rows = mergeLeadershipDay(limitUp, dragonTiger, "2026-09-10", new Map([["000978", "旅游及景区"]]));
  assert.equal(rows.length, 3);
  const tourism = rows.find((row) => row.code === "000978")!;
  assert.equal(tourism.industryName, "旅游及景区", "本地已分类行业名优先于涨停池短名");
  assert.equal(tourism.dragonTiger?.netAmount, 12_000_000);
  const financial = rows.find((row) => row.code === "600318")!;
  assert.equal(financial.dragonTiger?.netAmount, -4_000_000);
});

test("rejects an unverifiable limit-up batch instead of trusting the requested date", () => {
  const rows = parseLimitUpPoolPayload(ztPayload, "2026-09-10");
  const matching = verifyLimitUpAgainstQuotes(rows, [
    { code: "000978", price: 9.69, pctChange: 9.99 },
    { code: "600318", price: 8.09, pctChange: 10.07 },
    { code: "830001", price: 12, pctChange: 29.9 },
  ]);
  assert.equal(matching.verified, true);
  assert.equal(matching.matched, 3);

  const mismatched = verifyLimitUpAgainstQuotes(rows, [
    { code: "000978", price: 9.69, pctChange: 9.99 },
    { code: "600318", price: 7.5, pctChange: 2 },
    { code: "830001", price: 12, pctChange: 29.9 },
  ]);
  assert.equal(mismatched.verified, false);
  assert.match(mismatched.reason!, /不一致/);

  const emptyReference = verifyLimitUpAgainstQuotes(rows, []);
  assert.equal(emptyReference.verified, false);
  assert.match(emptyReference.reason!, /无法证明/);

  assert.equal(verifyLimitUpAgainstQuotes([], []).verified, false);
});

test("keeps the record shape stable for downstream scoring", () => {
  const row: LimitUpRecord = parseLimitUpPoolPayload(ztPayload, "2026-09-10")[0]!;
  assert.deepEqual(Object.keys(row).sort(), [
    "amount", "boardCount", "breakCount", "close", "code", "exchange", "firstSealTime", "floatMarketCap",
    "industryName", "lastSealTime", "name", "pctChange", "sealAmount", "sourceUrl", "statCount", "statDays",
    "tradeDate", "turnover",
  ]);
});
