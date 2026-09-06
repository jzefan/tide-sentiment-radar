import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { RawClue } from "./eastMoney.ts";

type Database = typeof import("./database.ts");

async function withDatabase(run: (database: Database, path: string) => Promise<void> | void) {
  const directory = await mkdtemp(join(tmpdir(), "tide-daily-candidates-"));
  const path = join(directory, "daily-candidates.sqlite");
  const previous = process.env.TIDE_DATABASE_PATH;
  process.env.TIDE_DATABASE_PATH = path;
  let database: Database | null = null;
  try {
    database = await import(`./database.ts?daily-candidate-persistence=${Date.now()}-${Math.random()}`) as Database;
    await run(database, path);
  } finally {
    database?.closeDatabaseForTests();
    if (previous === undefined) delete process.env.TIDE_DATABASE_PATH;
    else process.env.TIDE_DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function entry(code = "600001", rank = 1) {
  return {
    code,
    rank,
    grade: "A" as const,
    isHotIndustry: true,
    baseScore: 82,
    overheatPenalty: 2,
    finalScore: 80,
    scores: { turnover: 24, direction: 15 },
    snapshot: { close: 10.5, industry: { code: "I1", name: "测试行业" } },
    reasons: ["成交确认", "文本正向"],
  };
}

function frozenList(overrides: Record<string, unknown> = {}) {
  return {
    tradeDate: "2026-08-25",
    methodologyVersion: "daily-focus-v1",
    status: "frozen" as const,
    origin: "prospective" as const,
    featureCutoff: "2026-08-25T07:00:00.000Z",
    marketAsOf: "2026-08-25T07:00:00.000Z",
    clueAsOf: "2026-08-25T06:59:00.000Z",
    frozenAt: "2026-08-25T07:10:00.000Z",
    universeCount: 5_000,
    eligibleCount: 20,
    selectedCount: 3,
    methodology: { version: 1, thresholds: { amount: 100_000_000 } },
    dataQuality: { market: "complete", clues: "complete" },
    exclusionCounts: { amount: 4 },
    reason: null,
    benchmarkMembers: [
      { code: "600001", industryCode: "I1", industryName: "测试行业" },
      { code: "600002", industryCode: "I1", industryName: "测试行业" },
      { code: "600003", industryCode: "I1", industryName: "测试行业" },
    ],
    items: [entry("600001", 1), entry("600002", 2), entry("600003", 3)],
    ...overrides,
  };
}

function observingOutcome(overrides: Record<string, unknown> = {}) {
  return {
    signalTradeDate: "2026-08-25", code: "600001", horizon: 3 as const, status: "observing" as const,
    entryTradeDate: null, entryOpen: null, exitTradeDate: null, exitClose: null,
    stockReturn: null, marketReturn: null, marketExcess: null, industryReturn: null,
    industryExcess: null, maxAdverse: null, coverage: null, dataAsOf: null, completedAt: null, reason: "等待 T+3",
    ...overrides,
  };
}

function completedOutcome(overrides: Record<string, unknown> = {}) {
  return {
    ...observingOutcome({
      status: "completed",
      entryTradeDate: "2026-08-26", entryOpen: 10, exitTradeDate: "2026-08-28", exitClose: 11,
      stockReturn: 0.1, marketReturn: 0.02, marketExcess: 0.08, maxAdverse: -0.02, coverage: 1,
      dataAsOf: "2026-08-28T07:00:00.000Z", completedAt: "2026-08-28T07:00:00.000Z", reason: null,
    }),
    ...overrides,
  };
}

test("literal v10 to v11 adds data_as_of without losing a completed outcome and reloads idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tide-daily-candidates-v10-"));
  const path = join(directory, "v10.sqlite");
  const previous = process.env.TIDE_DATABASE_PATH;
  process.env.TIDE_DATABASE_PATH = path;
  let current: Database | null = null;
  let migrated: Database | null = null;
  let reloaded: Database | null = null;
  let raw: DatabaseSync | null = null;
  try {
    current = await import(`./database.ts?daily-candidate-v10-base=${Date.now()}`) as Database;
    current.saveDailyCandidateList(frozenList());
    current.saveDailyCandidateOutcomes([observingOutcome()]);
    current.saveDailyCandidateOutcomes([completedOutcome()]);
    current.closeDatabaseForTests();
    current = null;
    raw = new DatabaseSync(path);
    raw.exec("ALTER TABLE daily_candidate_outcomes DROP COLUMN data_as_of; PRAGMA user_version = 10;");
    assert.equal((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 10);
    raw.close();
    raw = null;
    migrated = await import(`./database.ts?daily-candidate-v11-upgrade=${Date.now()}`) as Database;
    const upgraded = migrated.getDailyCandidateOutcomes("2026-08-25")[0]!;
    assert.equal(upgraded.status, "completed");
    assert.equal(upgraded.stockReturn, 0.1, "completed payload survives the literal v10 table upgrade");
    assert.equal(upgraded.dataAsOf, null, "new v11 column is nullable for historical v10 outcomes");
    migrated.closeDatabaseForTests();
    migrated = null;
    reloaded = await import(`./database.ts?daily-candidate-v11-reload=${Date.now()}`) as Database;
    assert.equal(reloaded.getDailyCandidateOutcomes("2026-08-25")[0]?.dataAsOf, null);
    raw = new DatabaseSync(path);
    assert.equal((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 16);
  } finally {
    raw?.close();
    reloaded?.closeDatabaseForTests();
    migrated?.closeDatabaseForTests();
    current?.closeDatabaseForTests();
    if (previous === undefined) delete process.env.TIDE_DATABASE_PATH; else process.env.TIDE_DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("literal v11 to v12 creates the code/date history index and reloads idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tide-daily-candidates-v11-"));
  const path = join(directory, "v11.sqlite");
  const previous = process.env.TIDE_DATABASE_PATH;
  process.env.TIDE_DATABASE_PATH = path;
  let baseline: Database | null = null;
  let migrated: Database | null = null;
  let reloaded: Database | null = null;
  let raw: DatabaseSync | null = null;
  try {
    baseline = await import(`./database.ts?daily-candidate-v11-base=${Date.now()}`) as Database;
    baseline.closeDatabaseForTests();
    baseline = null;
    raw = new DatabaseSync(path);
    raw.exec("DROP INDEX market_quotes_code_trade_date; PRAGMA user_version = 11;");
    raw.close();
    raw = null;
    migrated = await import(`./database.ts?daily-candidate-v12-upgrade=${Date.now()}`) as Database;
    migrated.closeDatabaseForTests();
    migrated = null;
    raw = new DatabaseSync(path);
    const index = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='market_quotes_code_trade_date'").get() as { name: string } | undefined;
    const plan = raw.prepare("EXPLAIN QUERY PLAN SELECT code, trade_date FROM market_daily_quotes WHERE code = ? ORDER BY trade_date DESC LIMIT 5").all("600001") as Array<{ detail: string }>;
    assert.equal(index?.name, "market_quotes_code_trade_date");
    assert.ok(plan.some((row) => row.detail.includes("market_quotes_code_trade_date")), JSON.stringify(plan));
    assert.equal((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 16);
    raw.close();
    raw = null;
    reloaded = await import(`./database.ts?daily-candidate-v12-reload=${Date.now()}`) as Database;
  } finally {
    raw?.close();
    reloaded?.closeDatabaseForTests();
    migrated?.closeDatabaseForTests();
    baseline?.closeDatabaseForTests();
    if (previous === undefined) delete process.env.TIDE_DATABASE_PATH; else process.env.TIDE_DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("board-limit metadata resolves only a source-versioned effective rule", async () => {
  await withDatabase((database) => {
    database.saveBoardLimitMetadata([{
      code: "300001", limitPercent: 20, effectiveFrom: "2025-01-01", effectiveTo: "2026-08-25",
      source: "exchange-rulebook", sourceVersion: "2026.1", sourceUrl: "https://rules.example.test/v1",
    }]);
    assert.equal(database.resolveBoardLimitMetadata("300001", "2024-12-31"), null, "no prior effective metadata means unknown, not a code-prefix guess");
    assert.deepEqual(database.resolveBoardLimitMetadata("300001", "2026-08-25"), {
      code: "300001", limitPercent: 20, effectiveFrom: "2025-01-01", effectiveTo: "2026-08-25",
      source: "exchange-rulebook", sourceVersion: "2026.1", sourceUrl: "https://rules.example.test/v1",
    });
    assert.equal(database.resolveBoardLimitMetadata("300001", "2026-08-26"), null, "expired metadata cannot leak into a later quote date");
  });
});

async function createV9OutcomeFixture(path: string, outcomeCode = "600001") {
  const baseline = await import(`./database.ts?daily-candidate-v9-fixture-base=${Date.now()}-${Math.random()}`) as Database;
  baseline.closeDatabaseForTests();
  const raw = new DatabaseSync(path);
  raw.exec(`
    PRAGMA foreign_keys = OFF;
    DELETE FROM daily_candidate_lists;
    DROP INDEX IF EXISTS daily_candidate_outcomes_observing;
    DROP TABLE daily_candidate_outcomes;
    CREATE TABLE daily_candidate_outcomes (
      signal_trade_date TEXT NOT NULL, code TEXT NOT NULL, horizon INTEGER NOT NULL CHECK(horizon = 3),
      status TEXT NOT NULL CHECK(status IN ('observing', 'completed', 'unavailable')),
      entry_trade_date TEXT, entry_open REAL, exit_trade_date TEXT, exit_close REAL,
      stock_return REAL, market_return REAL, market_excess REAL, industry_return REAL,
      industry_excess REAL, max_adverse REAL, coverage REAL, completed_at TEXT, reason TEXT,
      PRIMARY KEY(signal_trade_date, code, horizon)
    );
    INSERT INTO daily_candidate_lists(
      trade_date, methodology_version, status, origin, feature_cutoff, market_as_of, clue_as_of, frozen_at,
      universe_count, eligible_count, selected_count, methodology_json, data_quality_json, exclusion_counts_json, reason
    ) VALUES ('2026-08-25', 'daily-focus-v1', 'frozen', 'prospective', '2026-08-25T07:00:00.000Z', NULL, NULL, NULL, 3, 3, 3, '{}', '{}', '{}', NULL);
    INSERT INTO daily_candidate_entries(
      trade_date, code, rank, grade, is_hot_industry, base_score, overheat_penalty, final_score, scores_json, snapshot_json, reasons_json
    ) VALUES
      ('2026-08-25', '600001', 1, 'A', 0, 80, 0, 80, '{}', '{}', '[]'),
      ('2026-08-25', '600002', 2, 'A', 0, 80, 0, 80, '{}', '{}', '[]'),
      ('2026-08-25', '600003', 3, 'A', 0, 80, 0, 80, '{}', '{}', '[]');
    INSERT INTO daily_candidate_outcomes(signal_trade_date, code, horizon, status, reason)
      VALUES ('2026-08-25', '${outcomeCode}', 3, 'observing', 'v9 fixture');
    PRAGMA user_version = 9;
  `);
  raw.close();
}

test("v8 to v11 migration creates daily candidate tables, outcome FK, and is reload-safe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tide-daily-candidates-v8-"));
  const path = join(directory, "v8.sqlite");
  const previous = process.env.TIDE_DATABASE_PATH;
  process.env.TIDE_DATABASE_PATH = path;
  let v8: DatabaseSync | null = null;
  let baseline: Database | null = null;
  let firstLoad: Database | null = null;
  let secondLoad: Database | null = null;
  try {
    // 先建立当前基线，再按外键依赖顺序移除 v9 对象，得到真实的 v8 fixture。
    baseline = await import(`./database.ts?daily-candidate-v8-baseline=${Date.now()}`) as Database;
    baseline.closeDatabaseForTests();
    baseline = null;
    v8 = new DatabaseSync(path);
    const fixture = v8;
    fixture.exec(`
      INSERT INTO clues(id, source, source_kind, title, summary, published_at, url, stock_codes_json, interaction_count, fetched_at)
      VALUES ('v8-sentinel', 'fixture', 'news', 'v8 sentinel', 'must survive', '2026-08-25T00:00:00.000Z', '', '[]', 0, '2026-08-25T00:00:00.000Z');
      DROP INDEX IF EXISTS daily_candidate_outcomes_observing;
      DROP INDEX IF EXISTS daily_candidate_lists_origin_date;
      DROP TABLE IF EXISTS daily_candidate_outcomes;
      DROP TABLE IF EXISTS daily_candidate_entries;
      DROP TABLE IF EXISTS daily_candidate_benchmark_members;
      DROP TABLE IF EXISTS daily_candidate_lists;
      PRAGMA user_version = 8;
    `);
    firstLoad = await import(`./database.ts?daily-candidate-v10-first=${Date.now()}`) as Database;
    const version = fixture.prepare("PRAGMA user_version").get() as { user_version: number };
    const objects = (fixture.prepare(`
      SELECT type, name FROM sqlite_master
      WHERE name IN (
        'daily_candidate_lists', 'daily_candidate_benchmark_members', 'daily_candidate_entries', 'daily_candidate_outcomes',
        'daily_candidate_lists_origin_date', 'daily_candidate_outcomes_observing'
      ) ORDER BY type, name
    `).all() as Array<{ type: string; name: string }>).map(({ type, name }) => ({ type, name }));
    const readSentinel = () => {
      const row = fixture.prepare("SELECT source, title, summary, published_at FROM clues WHERE id = 'v8-sentinel'").get() as Record<string, unknown> | undefined;
      return row ? { source: String(row.source), title: String(row.title), summary: String(row.summary), published_at: String(row.published_at) } : null;
    };
    const sentinelAfterFirstLoad = readSentinel();
    secondLoad = await import(`./database.ts?daily-candidate-v10-second=${Date.now()}`) as Database;
    const sentinelAfterSecondLoad = readSentinel();
    const secondLoadObjects = (fixture.prepare(`
      SELECT type, name FROM sqlite_master
      WHERE name IN (
        'daily_candidate_lists', 'daily_candidate_benchmark_members', 'daily_candidate_entries', 'daily_candidate_outcomes',
        'daily_candidate_lists_origin_date', 'daily_candidate_outcomes_observing'
      ) ORDER BY type, name
    `).all() as Array<{ type: string; name: string }>).map(({ type, name }) => ({ type, name }));
    const secondLoadVersion = fixture.prepare("PRAGMA user_version").get();
    secondLoad.closeDatabaseForTests();
    secondLoad = null;
    firstLoad.closeDatabaseForTests();
    firstLoad = null;
    fixture.close();
    v8 = null;
    assert.equal(version.user_version, 16);
    assert.deepEqual(objects, [
      { type: "index", name: "daily_candidate_lists_origin_date" },
      { type: "index", name: "daily_candidate_outcomes_observing" },
      { type: "table", name: "daily_candidate_benchmark_members" },
      { type: "table", name: "daily_candidate_entries" },
      { type: "table", name: "daily_candidate_lists" },
      { type: "table", name: "daily_candidate_outcomes" },
    ]);
    assert.deepEqual(sentinelAfterFirstLoad, { source: "fixture", title: "v8 sentinel", summary: "must survive", published_at: "2026-08-25T00:00:00.000Z" });
    assert.deepEqual(sentinelAfterSecondLoad, sentinelAfterFirstLoad);
    assert.deepEqual(secondLoadObjects, objects);
    assert.deepEqual(secondLoadVersion, version);
  } finally {
    secondLoad?.closeDatabaseForTests();
    firstLoad?.closeDatabaseForTests();
    baseline?.closeDatabaseForTests();
    v8?.close();
    if (previous === undefined) delete process.env.TIDE_DATABASE_PATH;
    else process.env.TIDE_DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("v9 to v10 preserves valid outcomes and rejects orphan outcomes without data loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tide-daily-candidates-v9-"));
  const validPath = join(directory, "valid.sqlite");
  const orphanPath = join(directory, "orphan.sqlite");
  const previous = process.env.TIDE_DATABASE_PATH;
  try {
    process.env.TIDE_DATABASE_PATH = validPath;
    await createV9OutcomeFixture(validPath);
    const migrated = await import(`./database.ts?daily-candidate-v10-valid=${Date.now()}`) as Database;
    assert.deepEqual(migrated.getObservingDailyCandidateOutcomes().map((outcome) => ({ code: outcome.code, reason: outcome.reason })), [{ code: "600001", reason: "v9 fixture" }]);
    migrated.closeDatabaseForTests();

    process.env.TIDE_DATABASE_PATH = orphanPath;
    await createV9OutcomeFixture(orphanPath, "600099");
    const moduleUrl = new URL(`./database.ts?daily-candidate-v10-orphan=${Date.now()}`, import.meta.url).href;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `await import(${JSON.stringify(moduleUrl)});`], {
      cwd: process.cwd(), env: { ...process.env, TIDE_DATABASE_PATH: orphanPath }, encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /orphan|孤儿/i);
    const raw = new DatabaseSync(orphanPath);
    assert.deepEqual(raw.prepare("SELECT code, reason FROM daily_candidate_outcomes").all().map((row) => ({ ...row })), [{ code: "600099", reason: "v9 fixture" }]);
    assert.equal((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 9);
    raw.close();
  } finally {
    if (previous === undefined) delete process.env.TIDE_DATABASE_PATH;
    else process.env.TIDE_DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("frozen list is normalized-idempotent, immutable, and rereads its frozen benchmark", async () => {
  await withDatabase((database) => {
    const saved = database.saveDailyCandidateList(frozenList());
    assert.equal(saved.items[0]?.code, "600001");
    database.saveDailyCandidateList(frozenList({
      methodology: { thresholds: { amount: 100_000_000 }, version: 1 },
      dataQuality: { clues: "complete", market: "complete" },
    }));
    assert.throws(() => database.saveDailyCandidateList(frozenList({
      items: [entry("600002", 1), entry("600003", 2), entry("600004", 3)],
    })), /immutable|冻结|conflict/i);
    const reread = database.getDailyCandidateList("2026-08-25");
    assert.deepEqual(reread?.benchmarkMembers, [
      { code: "600001", industryCode: "I1", industryName: "测试行业" },
      { code: "600002", industryCode: "I1", industryName: "测试行业" },
      { code: "600003", industryCode: "I1", industryName: "测试行业" },
    ]);
    assert.equal(reread?.items[0]?.code, "600001");
  });
});

test("unavailable list is immutable and cannot become frozen", async () => {
  await withDatabase((database) => {
    assert.throws(() => database.saveDailyCandidateList(frozenList({
      status: "unavailable", selectedCount: 0, reason: null, benchmarkMembers: [], items: [],
    })), /reason/i);
    const unavailable = frozenList({
      status: "unavailable",
      selectedCount: 0,
      reason: "行情数据未完整",
      benchmarkMembers: [],
      items: [],
    });
    database.saveDailyCandidateList(unavailable);
    database.saveDailyCandidateList({ ...unavailable, dataQuality: { clues: "complete", market: "complete" } });
    assert.throws(() => database.saveDailyCandidateList(frozenList()), /immutable|冻结|conflict/i);
    assert.equal(database.getDailyCandidateList("2026-08-25")?.status, "unavailable");
  });
});

test("daily list status enforces unavailable emptiness and 1-to-10 continuous frozen entries", async () => {
  await withDatabase((database) => {
    assert.throws(() => database.saveDailyCandidateList(frozenList({
      status: "unavailable", selectedCount: 1, reason: "数据不足", items: [entry()],
    })), /unavailable|selected|entries/i);
    assert.throws(() => database.saveDailyCandidateList(frozenList({
      status: "unavailable", selectedCount: 0, reason: "数据不足", items: [entry()],
    })), /unavailable|selected|entries/i);
    const one = database.saveDailyCandidateList(frozenList({
      selectedCount: 1, eligibleCount: 1, items: [entry("600001", 1)],
    }));
    assert.equal(one.items.length, 1);
    const reconstructed = database.saveDailyCandidateList(frozenList({
      tradeDate: "2026-08-24", status: "reconstructed", origin: "reconstructed", frozenAt: null,
      selectedCount: 2, eligibleCount: 2, items: [entry("600001", 1), entry("600002", 2)],
    }));
    assert.equal(reconstructed.items.length, 2);
    assert.throws(() => database.saveDailyCandidateList(frozenList({
      items: [entry("600001", 1), entry("600002", 3), entry("600003", 4)],
    })), /rank|连续|entries/i);
  });
});

test("list rejects duplicate entry codes or ranks", async () => {
  await withDatabase((database) => {
    assert.throws(() => database.saveDailyCandidateList(frozenList({
      items: [entry("600001", 1), entry("600001", 2), entry("600003", 3)],
    })), /duplicate|唯一|unique/i);
    assert.throws(() => database.saveDailyCandidateList(frozenList({
      benchmarkMembers: [
        { code: "600001", industryCode: null, industryName: null },
        { code: "600002", industryCode: null, industryName: null },
        { code: "600003", industryCode: null, industryName: null },
      ],
      items: [entry("600001", 1), entry("600002", 1), entry("600003", 3)],
    })), /duplicate|唯一|unique/i);
  });
});

test("reconstructed lists stay out of default prospective list queries", async () => {
  await withDatabase((database) => {
    database.saveDailyCandidateList(frozenList());
    database.saveDailyCandidateList(frozenList({
      tradeDate: "2026-08-22",
      status: "reconstructed",
      origin: "reconstructed",
      frozenAt: null,
    }));
    assert.deepEqual(database.listDailyCandidateLists().map((item) => item.tradeDate), ["2026-08-25"]);
    assert.deepEqual(database.listDailyCandidateLists({ includeReconstructed: true }).map((item) => item.tradeDate), ["2026-08-25", "2026-08-22"]);
    assert.equal(database.getDailyCandidateList("2026-08-22")?.origin, "reconstructed");
  });
});

test("outcomes can advance once from observing to a final state but cannot be rewritten", async () => {
  await withDatabase((database) => {
    database.saveDailyCandidateList(frozenList());
    database.saveDailyCandidateOutcomes([{
      signalTradeDate: "2026-08-25", code: "600001", horizon: 3, status: "observing",
      entryTradeDate: null, entryOpen: null, exitTradeDate: null, exitClose: null,
      stockReturn: null, marketReturn: null, marketExcess: null, industryReturn: null,
      industryExcess: null, maxAdverse: null, coverage: null, dataAsOf: null, completedAt: null, reason: "等待 T+3",
    }]);
    assert.equal(database.getObservingDailyCandidateOutcomes()[0]?.code, "600001");
    database.saveDailyCandidateOutcomes([{
      signalTradeDate: "2026-08-25", code: "600001", horizon: 3, status: "completed",
      entryTradeDate: "2026-08-26", entryOpen: 10, exitTradeDate: "2026-08-28", exitClose: 11,
      stockReturn: 0.1, marketReturn: 0.02, marketExcess: 0.08, industryReturn: 0.03,
      industryExcess: 0.07, maxAdverse: -0.02, coverage: 1, dataAsOf: "2026-08-28T07:00:00.000Z", completedAt: "2026-08-28T07:00:00.000Z", reason: null,
    }]);
    assert.deepEqual(database.getObservingDailyCandidateOutcomes(), []);
    assert.throws(() => database.saveDailyCandidateOutcomes([{
      signalTradeDate: "2026-08-25", code: "600001", horizon: 3, status: "completed",
      entryTradeDate: "2026-08-26", entryOpen: 10, exitTradeDate: "2026-08-28", exitClose: 12,
      stockReturn: 0.2, marketReturn: 0.02, marketExcess: 0.18, industryReturn: 0.03,
      industryExcess: 0.17, maxAdverse: -0.02, coverage: 1, dataAsOf: "2026-08-28T07:00:00.000Z", completedAt: "2026-08-28T07:00:00.000Z", reason: null,
    }]), /final|completed|immutable|conflict/i);
  });
});

test("completed outcomes require every settlement field and bounded coverage", async (context) => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["entry trade date", { entryTradeDate: null }],
    ["entry open", { entryOpen: null }],
    ["exit trade date", { exitTradeDate: null }],
    ["exit close", { exitClose: null }],
    ["stock return", { stockReturn: null }],
    ["market return", { marketReturn: null }],
    ["market excess", { marketExcess: null }],
    ["max adverse", { maxAdverse: null }],
    ["coverage", { coverage: null }],
    ["data as of", { dataAsOf: null }],
    ["coverage below zero", { coverage: -0.01 }],
    ["coverage below completion threshold", { coverage: 0.899999 }],
    ["coverage above one", { coverage: 1.01 }],
    ["non-calendar entry date", { entryTradeDate: "2026-02-30" }],
    ["entry date is not after signal date", { entryTradeDate: "2026-08-25" }],
    ["entry date is after exit date", { entryTradeDate: "2026-08-29" }],
    ["positive max adverse", { maxAdverse: 0.0001 }],
    ["completed at", { completedAt: null }],
  ];
  for (const [name, overrides] of cases) await context.test(name, async () => {
    await withDatabase((database) => {
      database.saveDailyCandidateList(frozenList());
      database.saveDailyCandidateOutcomes([observingOutcome()]);
      assert.throws(() => database.saveDailyCandidateOutcomes([completedOutcome(overrides)]), /completed|settlement|coverage|outcome/i);
    });
  });
});

test("completed outcome accepts exactly 90 percent coverage", async () => {
  await withDatabase((database) => {
    database.saveDailyCandidateList(frozenList());
    database.saveDailyCandidateOutcomes([observingOutcome()]);
    assert.equal(database.saveDailyCandidateOutcomes([completedOutcome({ coverage: 0.9 })])[0]?.status, "completed");
  });
});

test("observing outcomes reject final timestamps and settlement fields", async () => {
  await withDatabase((database) => {
    database.saveDailyCandidateList(frozenList());
    assert.throws(() => database.saveDailyCandidateOutcomes([observingOutcome({ completedAt: "2026-08-28T07:00:00.000Z" })]), /observing|outcome/i);
    assert.throws(() => database.saveDailyCandidateOutcomes([observingOutcome({ entryTradeDate: "2026-08-26" })]), /observing|outcome/i);
    assert.throws(() => database.saveDailyCandidateOutcomes([observingOutcome({ stockReturn: 0.1 })]), /observing|outcome/i);
    assert.throws(() => database.saveDailyCandidateOutcomes([observingOutcome({ coverage: 0.9 })]), /observing|outcome/i);
  });
});

test("unavailable outcomes require a reason, may retain partial settlement data, and become immutable", async () => {
  await withDatabase((database) => {
    database.saveDailyCandidateList(frozenList());
    database.saveDailyCandidateOutcomes([observingOutcome()]);
    assert.throws(() => database.saveDailyCandidateOutcomes([observingOutcome({ status: "unavailable", reason: "  " })]), /unavailable|reason|outcome/i);
    const unavailable = observingOutcome({
      status: "unavailable",
      entryTradeDate: "2026-08-26",
      entryOpen: 10,
      coverage: 0.5,
      reason: "T+3 行情覆盖不足",
    });
    assert.equal(database.saveDailyCandidateOutcomes([unavailable])[0]?.status, "unavailable");
    assert.throws(() => database.saveDailyCandidateOutcomes([{
      ...unavailable,
      reason: "不同的终态原因",
    }]), /final|immutable|conflict/i);
  });
});

test("unavailable partial outcomes validate every supplied settlement field", async (context) => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["non-calendar entry date", { entryTradeDate: "2026-02-30" }],
    ["entry date not after signal", { entryTradeDate: "2026-08-25" }],
    ["entry after exit", { entryTradeDate: "2026-08-29", exitTradeDate: "2026-08-28" }],
    ["zero entry open", { entryTradeDate: "2026-08-26", entryOpen: 0 }],
    ["negative exit close", { exitTradeDate: "2026-08-28", exitClose: -1 }],
    ["coverage below zero", { coverage: -0.01 }],
    ["coverage above one", { coverage: 1.01 }],
    ["positive max adverse", { maxAdverse: 0.01 }],
    ["invalid completed at", { completedAt: "not-a-timestamp" }],
  ];
  for (const [name, partial] of cases) await context.test(name, async () => {
    await withDatabase((database) => {
      database.saveDailyCandidateList(frozenList());
      database.saveDailyCandidateOutcomes([observingOutcome()]);
      assert.throws(() => database.saveDailyCandidateOutcomes([observingOutcome({ status: "unavailable", reason: "部分数据", ...partial })]), /outcome|日期|coverage|settlement/i);
    });
  });
});

test("outcomes require a frozen entry parent and cascade when its list is deleted", async () => {
  await withDatabase((database, path) => {
    database.saveDailyCandidateList(frozenList());
    assert.throws(() => database.saveDailyCandidateOutcomes([observingOutcome({ code: "600099" })]), /FOREIGN KEY|parent|entry/i);
    database.saveDailyCandidateOutcomes([observingOutcome()]);
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys = ON; DELETE FROM daily_candidate_lists WHERE trade_date = '2026-08-25';");
    raw.close();
    assert.deepEqual(database.getObservingDailyCandidateOutcomes(), []);
  });
});

test("daily candidate payloads only accept JSON primitives, arrays, and plain objects", async () => {
  class CustomPayload { value = 1; }
  const invalidPayloads = [new Date(), new Map([["key", "value"]]), new Set(["value"]), /pattern/, new CustomPayload()];
  for (const value of invalidPayloads) await withDatabase((database) => {
    assert.throws(() => database.saveDailyCandidateList(frozenList({ methodology: value })), /JSON payload|plain object/i);
  });
});

test("daily candidate date fields require real ISO calendar dates", async () => {
  await withDatabase((database) => {
    assert.throws(() => database.saveDailyCandidateList(frozenList({ tradeDate: "2026-02-30" })), /交易日|日期/i);
    assert.throws(() => database.saveDailyCandidateOutcomes([observingOutcome({ signalTradeDate: "2026-02-30" })]), /outcome|日期/i);
  });
});

test("test database modules expose an explicit close before temporary files are removed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tide-daily-candidates-close-"));
  const path = join(directory, "close.sqlite");
  const previous = process.env.TIDE_DATABASE_PATH;
  process.env.TIDE_DATABASE_PATH = path;
  try {
    const database = await import(`./database.ts?daily-candidate-close=${Date.now()}`) as Database;
    database.closeDatabaseForTests();
  } finally {
    if (previous === undefined) delete process.env.TIDE_DATABASE_PATH;
    else process.env.TIDE_DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("trade-date and clue window helpers return only their comparable window", async () => {
  await withDatabase((database, path) => {
    const now = Date.now();
    const from = new Date(now - 2 * 60 * 60_000).toISOString();
    const to = new Date(now).toISOString();
    const clues: RawClue[] = [
      { id: "in", source: "测试", sourceKind: "news", title: "窗口内", summary: "", publishedAt: new Date(now - 60 * 60_000).toISOString(), url: "", stockCodes: ["600001"], interactionCount: 1 },
      { id: "out", source: "测试", sourceKind: "news", title: "窗口外", summary: "", publishedAt: new Date(now - 3 * 60 * 60_000).toISOString(), url: "", stockCodes: ["600001"], interactionCount: 1 },
    ];
    database.saveClues(clues);
    assert.deepEqual(database.getCluesInWindow(from, to).map((item) => item.id), ["in"]);
    const raw = new DatabaseSync(path);
    raw.exec(`
      INSERT INTO market_quote_snapshots(id, provider, source_tier, endpoint, trade_date, quote_at, fetched_at, expected_count, row_count, status)
      VALUES
        ('s1', 'eastmoney', 'primary', 'test', '2026-08-26', '2026-08-26T07:00:00.000Z', '2026-08-26T07:00:00.000Z', 1, 1, 'complete'),
        ('s2', 'eastmoney', 'primary', 'test', '2026-08-27', '2026-08-27T07:00:00.000Z', '2026-08-27T07:00:00.000Z', 1, 1, 'complete');
      INSERT INTO market_daily_quotes(code, trade_date, name, exchange, market, quote_at, fetched_at, snapshot_id, provider, source_tier, quote_url)
      VALUES
        ('600001', '2026-08-26', '测试', 'SH', '沪A', '2026-08-26T07:00:00.000Z', '2026-08-26T07:00:00.000Z', 's1', 'eastmoney', 'primary', ''),
        ('600001', '2026-08-27', '测试', 'SH', '沪A', '2026-08-27T07:00:00.000Z', '2026-08-27T07:00:00.000Z', 's2', 'eastmoney', 'primary', '');
    `);
    raw.close();
    assert.deepEqual(database.getTradeDatesAfter("2026-08-25", 6), ["2026-08-26", "2026-08-27"]);
  });
});
