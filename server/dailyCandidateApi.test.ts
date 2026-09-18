import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";

type Database = typeof import("./database.ts");
const { DAILY_FOCUS_VERSION } = await import("./dailyCandidateStrategyV7.ts");

const entry = (code: string, rank: number) => ({ code, rank, grade: "A" as const, isHotIndustry: true, baseScore: 80, overheatPenalty: 0, finalScore: 80, scores: {}, snapshot: {}, reasons: [] });
const list = (tradeDate: string, origin: "prospective" | "reconstructed") => ({
  tradeDate, methodologyVersion: "daily-focus-v1", status: origin === "reconstructed" ? "reconstructed" as const : "frozen" as const, origin,
  featureCutoff: `${tradeDate}T07:00:00.000Z`, marketAsOf: `${tradeDate}T07:00:00.000Z`, clueAsOf: `${tradeDate}T07:00:00.000Z`, frozenAt: `${tradeDate}T07:10:00.000Z`,
  universeCount: 10, eligibleCount: 3, selectedCount: 3, methodology: {}, dataQuality: {}, exclusionCounts: {}, reason: null,
  benchmarkMembers: ["600001", "600002", "600003"].map((code) => ({ code, industryCode: "electronics", industryName: "电子" })),
  items: [entry("600001", 1), entry("600002", 2), entry("600003", 3)],
});

test("daily-candidate HTTP routes validate parameters, expose reconstructed records, and isolate performance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tide-daily-candidate-api-"));
  const previousPath = process.env.TIDE_DATABASE_PATH;
  const previousListen = process.env.TIDE_DISABLE_LISTEN;
  process.env.TIDE_DATABASE_PATH = join(directory, "api.sqlite");
  process.env.TIDE_DISABLE_LISTEN = "1";
  let database: Database | null = null;
  let instance: import("node:http").Server | null = null;
  try {
    database = await import(`./database.ts?daily-candidate-api=${Date.now()}`) as Database;
    const seed = new DatabaseSync(join(directory, "api.sqlite"));
    seed.prepare(`INSERT INTO market_quote_snapshots(id, provider, source_tier, endpoint, trade_date, quote_at, fetched_at, expected_count, row_count, status, error) VALUES (?, 'eastmoney', 'primary', 'fixture', '2026-08-25', '2026-08-25T07:00:00.000Z', '2026-08-25T07:00:00.000Z', 4000, 4000, 'complete', NULL)`).run("preview-snapshot");
    const seedQuote = seed.prepare(`INSERT INTO market_daily_quotes(code, trade_date, name, exchange, market, price, pct_change, open, high, low, previous_close, volume, amount, turnover, market_cap, listing_date, industry_name, quote_at, fetched_at, snapshot_id, provider, source_tier, quote_url) VALUES (?, '2026-08-25', ?, 'SH', '沪市', 10, 0, 10, 10.1, 9.9, 10, 1, 100000000, 1, 1, '2020-01-01', '电子', '2026-08-25T07:00:00.000Z', '2026-08-25T07:00:00.000Z', 'preview-snapshot', 'eastmoney', 'primary', '')`);
    seed.exec("BEGIN");
    for (let index = 0; index < 4000; index += 1) seedQuote.run(String(600000 + index), `预览${index}`);
    seed.exec("COMMIT");
    seed.close();
    database.saveDailyCandidateList(list("2026-08-25", "prospective"));
    database.saveDailyCandidateList(list("2026-08-24", "reconstructed"));
    for (const code of ["600001", "600002", "600003"]) {
      database.saveDailyCandidateOutcomes([{ signalTradeDate: "2026-08-25", code, horizon: 3, status: "observing", entryTradeDate: null, entryOpen: null, exitTradeDate: null, exitClose: null, stockReturn: null, marketReturn: null, marketExcess: null, industryReturn: null, industryExcess: null, maxAdverse: null, coverage: null, dataAsOf: null, completedAt: null, reason: "等待 T+3" }]);
      database.saveDailyCandidateOutcomes([{ signalTradeDate: "2026-08-25", code, horizon: 3, status: "completed", entryTradeDate: "2026-08-26", entryOpen: 10, exitTradeDate: "2026-08-28", exitClose: 11, stockReturn: .1, marketReturn: .02, marketExcess: .08, industryReturn: null, industryExcess: null, maxAdverse: -.01, coverage: 1, dataAsOf: "2026-08-28T07:00:00.000Z", completedAt: "2026-08-28T07:00:00.000Z", reason: null }]);
    }
    for (const code of ["600001", "600002"]) {
      database.saveDailyCandidateOutcomes([{ signalTradeDate: "2026-08-24", code, horizon: 3, status: "observing", entryTradeDate: null, entryOpen: null, exitTradeDate: null, exitClose: null, stockReturn: null, marketReturn: null, marketExcess: null, industryReturn: null, industryExcess: null, maxAdverse: null, coverage: null, dataAsOf: null, completedAt: null, reason: "等待 T+3" }]);
    }
    database.saveDailyCandidateOutcomes([{ signalTradeDate: "2026-08-24", code: "600002", horizon: 3, status: "unavailable", entryTradeDate: null, entryOpen: null, exitTradeDate: null, exitClose: null, stockReturn: null, marketReturn: null, marketExcess: null, industryReturn: null, industryExcess: null, maxAdverse: null, coverage: .82, dataAsOf: "2026-08-27T07:00:00.000Z", completedAt: "2026-08-27T07:00:00.000Z", reason: "冻结市场基准覆盖率低于 90%" }]);
    const api = await import(`./index.ts?daily-candidate-api=${Date.now()}`);
    assert.equal(
      (api as any).shouldServeLiveDailyPreview("2026-08-25", "2026-08-25", new Date("2026-08-25T02:00:00.000Z")),
      true,
      "an explicitly selected current trading day remains a live preview while the market is open",
    );
    assert.equal(
      (api as any).shouldServeLiveDailyPreview("2026-08-25", "2026-08-25", new Date("2026-08-25T07:05:00.000Z")),
      false,
      "after the session the same date can return its immutable frozen record",
    );
    assert.equal(
      (api as any).shouldServeLiveDailyPreview(null, "2026-08-25", new Date("2026-08-26T02:00:00.000Z")),
      false,
      "a snapshot from a previous date never becomes a live preview during a later session",
    );
    const started = api.server;
    instance = started;
    started.listen(0, "127.0.0.1");
    await once(started, "listening");
    const base = `http://127.0.0.1:${(started.address() as AddressInfo).port}`;
    const get = async (path: string) => fetch(`${base}${path}`);

    const current = await get("/api/daily-candidates");
    assert.equal(current.status, 200);
    const currentPayload = await current.json();
    assert.equal(currentPayload.tradeDate, "2026-08-25");
    assert.equal(currentPayload.items[0]?.snapshot?.industry?.name, "电子", "a frozen benchmark industry fills legacy entries whose score snapshot omitted the industry label");
    const poolResponse = await get("/api/daily-focus-pool");
    assert.equal(poolResponse.status, 200);
    const pool = await poolResponse.json();
    assert.deepEqual(pool.items.map((item: { code: string }) => item.code), ["600001", "600002", "600003"]);
    assert.deepEqual(pool.window.tradeDates, ["2026-08-25"]);
    assert.equal(pool.items[0].consecutiveDays, 1);
    assert.equal(pool.items[0].industries[0].name, "电子", "the pool exposes current quote industries as stock tags");
    const twoDayPoolResponse = await get("/api/daily-focus-pool?sessions=2");
    assert.equal(twoDayPoolResponse.status, 200);
    assert.equal((await twoDayPoolResponse.json()).window.sessions, 2);
    assert.equal((await get("/api/daily-focus-pool?sessions=1")).status, 400);
    const historical = await get("/api/daily-candidates?date=2026-08-24");
    assert.equal(historical.status, 200);
    const reconstructed = await historical.json();
    assert.equal(reconstructed.origin, "reconstructed", "historical reconstruction remains auditable/readable");
    assert.deepEqual(
      { target: reconstructed.items[0]?.nextDayTrend?.targetTradeDate, status: reconstructed.items[0]?.nextDayTrend?.actual?.status },
      { target: "2026-08-25", status: "flat" },
      "historical responses compare the frozen bullish signal with the next trading day's actual move",
    );
    assert.deepEqual(reconstructed.outcomes.map((outcome: { code: string; status: string }) => [outcome.code, outcome.status]), [["600001", "observing"], ["600002", "unavailable"]], "candidate route exposes immutable per-stock T+3 audit outcomes without changing record origin");
    const missingDate = await get("/api/daily-candidates?date=2026-08-23");
    assert.equal(missingDate.status, 404);
    assert.equal((await missingDate.json()).code, "NO_CANDIDATE_LIST_FOR_DATE", "a selected date without a frozen/reconstructed list is distinguishable from current preview");
    assert.equal((await get("/api/daily-candidates?date=bad")).status, 400);
    assert.equal((await get("/api/daily-candidates?date=2026-02-30")).status, 400, "impossible calendar dates never escape as a database 500");
    assert.equal((await get("/api/daily-candidates/performance?window=7")).status, 400);
    assert.equal((await get("/api/daily-candidates/performance?window=20&cost_bps=-1")).status, 400);
    assert.equal((await get("/api/daily-candidates/performance?window=20&cost_bps=1.5")).status, 400);
    const performance = await get("/api/daily-candidates/performance?window=20&cost_bps=15");
    assert.equal(performance.status, 200);
    const performancePayload = await performance.json();
    assert.equal(performancePayload.sampleDays, 1, "reconstructed records never enter prospective performance");
    assert.equal(performancePayload.costBps, 15);
    assert.equal(performancePayload.netAverageMarketExcess, .0785, "net excess deducts the requested basis-point cost");

    // Current view is a live preview when persistence has not frozen any prospective list yet.
    const raw = new DatabaseSync(join(directory, "api.sqlite"));
    raw.exec("DELETE FROM daily_candidate_lists");
    raw.close();
    const previewResponse = await get("/api/daily-candidates");
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.status, "preview", "current route builds a non-persisted preview instead of returning 404");
    assert.equal(preview.methodologyVersion, DAILY_FOCUS_VERSION, "new previews expose the market-first one-to-ten selection methodology");
    assert.deepEqual(preview.outcomes, []);
    const explicitCurrent = await get("/api/daily-candidates?date=2026-08-25");
    assert.equal(explicitCurrent.status, 200, "explicitly selecting the current trading day returns its preview instead of a historical-list 404");
    assert.equal((await explicitCurrent.json()).status, "preview");
    database.saveDailyCandidateList(list("2026-08-24", "prospective"));
    const todayStillPreview = await get("/api/daily-candidates");
    assert.equal(todayStillPreview.status, 200);
    assert.equal((await todayStillPreview.json()).status, "preview", "a previous frozen list never replaces the current snapshot date while today remains unfrozen");
  } finally {
    if (instance?.listening) await new Promise<void>((resolve) => instance!.close(() => resolve()));
    database?.closeDatabaseForTests();
    if (previousPath === undefined) delete process.env.TIDE_DATABASE_PATH; else process.env.TIDE_DATABASE_PATH = previousPath;
    if (previousListen === undefined) delete process.env.TIDE_DISABLE_LISTEN; else process.env.TIDE_DISABLE_LISTEN = previousListen;
    await rm(directory, { recursive: true, force: true });
  }
});
