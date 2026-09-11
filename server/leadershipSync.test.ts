import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EastMoneyMarketQuote, EastMoneyMarketSnapshot } from "./eastMoneyMarket.ts";

const directory = await mkdtemp(join(tmpdir(), "tide-leadership-"));
process.env.TIDE_DATABASE_PATH = join(directory, "leadership.sqlite");
const database = await import("./database.ts");
const { syncDailyLeadership, readLeadershipDayRows, leadershipCoverage } = await import("./leadershipSync.ts");

test.after(async () => {
  database.closeDatabaseForTests();
  await rm(directory, { recursive: true, force: true });
});

const quote = (code: string, tradeDate: string, price: number, pctChange: number): EastMoneyMarketQuote => ({
  code,
  name: `测试${code}`,
  exchange: code.startsWith("6") ? "SH" : "SZ",
  market: code.startsWith("6") ? "沪市" : "深市",
  price,
  pctChange,
  open: price - 0.1,
  high: price,
  low: price - 0.2,
  previousClose: price / (1 + pctChange / 100),
  volume: 100,
  amount: 1_000_000,
  turnover: 2,
  marketCap: 10_000,
  listingDate: "2020-01-01",
  industryName: "半导体",
  quoteAt: `${tradeDate}T07:00:00.000Z`,
  tradeDate,
  quoteUrl: `https://quote.eastmoney.com/${code}.html`,
  provider: "eastmoney",
  sourceTier: "primary",
});

function seedMarket(tradeDate: string, overrides: Array<{ code: string; price: number; pctChange: number }> = []): void {
  const byCode = new Map(overrides.map((item) => [item.code, item]));
  const items = Array.from({ length: 4_000 }, (_, index) => {
    const code = String(100_000 + index);
    const override = byCode.get(code);
    return override ? quote(code, tradeDate, override.price, override.pctChange) : quote(code, tradeDate, 10, 1);
  });
  const snapshot: EastMoneyMarketSnapshot = {
    provider: "eastmoney",
    sourceTier: "primary",
    endpoint: "https://push2.eastmoney.com/api/qt/clist/get",
    expectedCount: items.length,
    fetchedAt: `${tradeDate}T07:00:00.000Z`,
    quoteAt: `${tradeDate}T07:00:00.000Z`,
    tradeDate,
    items,
  };
  database.saveCompleteMarketSnapshot(snapshot);
}

const ztPayload = (rows: Array<{ code: string; price: number; pctChange: number; boards: number; seal?: number }>) => ({
  rc: 0,
  data: {
    tc: rows.length,
    pool: rows.map((row) => ({
      c: row.code,
      m: row.code.startsWith("6") ? 1 : 0,
      n: `测试${row.code}`,
      p: Math.round(row.price * 1000),
      zdp: row.pctChange,
      amount: 500_000_000,
      hs: 10,
      lbc: row.boards,
      fbt: row.seal ?? 93000,
      lbt: row.seal ?? 93000,
      zbc: 0,
      hybk: "半导体",
    })),
  },
});

const billboardPayload = (codes: string[]) => ({
  result: {
    pages: 1,
    data: codes.map((code) => ({
      SECURITY_CODE: code,
      SECURITY_NAME_ABBR: `测试${code}`,
      CLOSE_PRICE: 11,
      CHANGE_RATE: 10,
      BILLBOARD_NET_AMT: 5_000_000,
      BILLBOARD_BUY_AMT: 8_000_000,
      BILLBOARD_SELL_AMT: 3_000_000,
      BILLBOARD_DEAL_AMT: 11_000_000,
      TURNOVERRATE: 12,
      EXPLANATION: "日涨幅偏离值达到7%的前5只证券",
      EXPLAIN: "1家机构买入",
    })),
  },
});

function fakeFetch(handler: (url: string) => unknown) {
  const urls: string[] = [];
  const impl = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    return { json: async () => handler(url) } as Response;
  }) as unknown as typeof fetch;
  return { impl, urls };
}

test("saves a limit-up batch only after it matches the local same-day quotes", async () => {
  seedMarket("2026-09-10", [
    { code: "100000", price: 11, pctChange: 10 },
    { code: "100001", price: 22, pctChange: 20 },
    { code: "100002", price: 33, pctChange: 9.9 },
  ]);
  const { impl, urls } = fakeFetch((url) => url.includes("getTopicZTPool")
    ? ztPayload([
      { code: "100000", price: 11, pctChange: 10, boards: 3, seal: 92500 },
      { code: "100001", price: 22, pctChange: 20, boards: 2 },
      { code: "100002", price: 33, pctChange: 9.9, boards: 1 },
    ])
    : billboardPayload(["100000"]));

  const result = await syncDailyLeadership("2026-09-10", { force: true, fetchImpl: impl });
  assert.equal(result.verification, "verified");
  assert.equal(result.poolCount, 3);
  assert.equal(result.billboardCount, 1);
  assert.equal(urls.length, 2, "涨停池与龙虎榜各抓一次");

  const rows = readLeadershipDayRows("2026-09-10");
  assert.equal(rows.length, 3);
  const top = rows.find((row) => row.code === "100000")!;
  assert.equal(top.boardCount, 3);
  assert.equal(top.firstSealTime, "09:25:00");
  assert.equal(top.dragonTiger?.netAmount, 5_000_000);
  const coverage = leadershipCoverage(["2026-09-10"]).find((item) => item.tradeDate === "2026-09-10")!;
  assert.equal(coverage.verification, "verified");
  assert.equal(coverage.rows, 3);
  assert.match(coverage.note!, /核对通过/);
});

test("a finalized session is served from storage instead of refetching", async () => {
  const { impl, urls } = fakeFetch(() => ztPayload([]));
  const result = await syncDailyLeadership("2026-09-10", { fetchImpl: impl });
  assert.equal(result.skipped, true);
  assert.equal(result.verification, "verified");
  assert.equal(urls.length, 0, "收盘后已定稿的交易日不再重复抓取");
});

test("rejects a batch whose prices do not match the local quotes and keeps prior data intact", async () => {
  seedMarket("2026-09-11", [
    { code: "100000", price: 11, pctChange: 10 },
    { code: "100001", price: 22, pctChange: 20 },
  ]);
  const { impl } = fakeFetch((url) => url.includes("getTopicZTPool")
    ? ztPayload([
      { code: "100000", price: 8.8, pctChange: 3.3, boards: 3 },
      { code: "100001", price: 5.5, pctChange: 1.1, boards: 2 },
    ])
    : billboardPayload(["100000"]));

  const result = await syncDailyLeadership("2026-09-11", { force: true, fetchImpl: impl });
  assert.equal(result.verification, "unverified");
  assert.match(result.note!, /不一致/);
  assert.deepEqual(database.getLimitUpPoolByTradeDate("2026-09-11"), [], "未通过的批次不写入任何涨停记录");
  assert.deepEqual(database.getDragonTigerByTradeDate("2026-09-11"), []);
  const coverage = leadershipCoverage(["2026-09-11"]).find((item) => item.tradeDate === "2026-09-11")!;
  assert.equal(coverage.verification, "unverified");
  assert.equal(coverage.rows, 0);
});

test("a close batch with no overlapping codes cannot certify the requested date", async () => {
  const { impl } = fakeFetch((url) => url.includes("getTopicZTPool")
    ? ztPayload([{ code: "100000", price: 11, pctChange: 10, boards: 3 }])
    : billboardPayload([]));
  const result = await syncDailyLeadership("2026-09-09", {
    force: true,
    fetchImpl: impl,
    quotes: [{ code: "999999", price: 10, pctChange: 1, quoteAt: "2026-09-09T07:00:00.000Z" }],
    now: Date.parse("2026-09-11T02:05:00.000Z"),
  });
  assert.equal(result.verification, "unverified");
  assert.match(result.note!, /无法证明涨停池日期/);
  assert.deepEqual(database.getLimitUpPoolByTradeDate("2026-09-09"), []);
});

test("certifies an intraday batch only for the current session and records the timing gap", async () => {
  seedMarket("2026-09-11", [
    { code: "100000", price: 11, pctChange: 10 },
    { code: "100001", price: 10.5, pctChange: 5 },
    { code: "100002", price: 33, pctChange: 9.9 },
  ]);
  const now = Date.parse("2026-09-11T02:05:00.000Z");
  const quotes = [
    { code: "100000", price: 11, pctChange: 10, quoteAt: "2026-09-11T02:00:00.000Z" },
    // 行情批次取在封板之前：只允许「本地价格不高于涨停池价格」这一种时点差。
    { code: "100001", price: 10.5, pctChange: 5, quoteAt: "2026-09-11T02:00:00.000Z" },
    { code: "100002", price: 33, pctChange: 9.9, quoteAt: "2026-09-11T02:00:00.000Z" },
  ];
  const { impl } = fakeFetch((url) => url.includes("getTopicZTPool")
    ? ztPayload([
      { code: "100000", price: 11, pctChange: 10, boards: 3 },
      { code: "100001", price: 11, pctChange: 10, boards: 2 },
      { code: "100002", price: 33, pctChange: 9.9, boards: 1 },
    ])
    : billboardPayload([]));
  const result = await syncDailyLeadership("2026-09-11", { force: true, fetchImpl: impl, quotes, now });
  assert.equal(result.verification, "verified");
  assert.match(result.note!, /盘中同批行情核对/);
  assert.match(result.note!, /1 条为盘中封板时点差/);
  assert.equal(database.getLimitUpPoolByTradeDate("2026-09-11").length, 3);
});

test("refuses a final limit-up pool when the local batch is not a close batch", async () => {
  const { impl } = fakeFetch((url) => url.includes("getTopicZTPool")
    ? ztPayload([{ code: "100000", price: 11, pctChange: 10, boards: 3 }])
    : billboardPayload([]));
  const result = await syncDailyLeadership("2026-09-07", {
    force: true,
    fetchImpl: impl,
    quotes: [{ code: "100000", price: 10, pctChange: 1, quoteAt: "2026-09-07T02:00:00.000Z" }],
    now: Date.parse("2026-09-11T02:05:00.000Z"),
  });
  assert.equal(result.verification, "unverified");
  assert.match(result.note!, /不是收盘批次/);
  assert.deepEqual(database.getLimitUpPoolByTradeDate("2026-09-07"), []);
});

test("network failures are recorded without inventing limit-up rows", async () => {
  seedMarket("2026-09-08", [{ code: "100000", price: 11, pctChange: 10 }]);
  const failing = (async () => { throw new Error("connection reset"); }) as unknown as typeof fetch;
  const result = await syncDailyLeadership("2026-09-08", { force: true, fetchImpl: failing });
  assert.equal(result.verification, "unverified");
  assert.match(result.note!, /connection reset/);
  assert.deepEqual(database.getLimitUpPoolByTradeDate("2026-09-08"), []);
});
