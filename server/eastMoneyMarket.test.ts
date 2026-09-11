import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fetchEastMoneyMarketSnapshot } from "./eastMoneyMarket.ts";

function marketRows() {
  return Array.from({ length: 4_000 }, (_, index) => {
    const code = index === 0 ? "600000" : index === 1 ? "000001" : index === 2 ? "430001" : String(100_000 + index);
    const row: Record<string, unknown> = {
      f2: 10,
      f3: 1,
      f5: 100,
      f6: 1_000,
      f8: 2,
      f12: code,
      f13: 0,
      f14: `测试${index}`,
      f15: 11,
      f16: 9,
      f17: 9.5,
      f18: 9.9,
      f20: 10_000,
      f124: 1_714_566_400,
    };
    if (index === 0) row.f26 = 1_704_067_200_000;
    if (index === 1) row.f26 = "20240202";
    if (index === 2) row.f26 = "2024-02-31";
    if (index === 3) row.f26 = Date.UTC(2023, 11, 31, 16);
    if (index === 4) row.f26 = "19900101";
    if (index === 5) row.f26 = "20991231";
    return row;
  });
}

test("EastMoney market snapshot requests f26 and normalizes listing dates", async () => {
  const rows = marketRows();
  const originalFetch = globalThis.fetch;
  const requestedFields: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requestedFields.push(url.searchParams.get("fields") ?? "");
    const page = Number(url.searchParams.get("pn"));
    const pageSize = Number(url.searchParams.get("pz"));
    return new Response(JSON.stringify({
      rc: 0,
      data: { total: rows.length, diff: rows.slice((page - 1) * pageSize, page * pageSize) },
    }));
  };
  try {
    const snapshot = await fetchEastMoneyMarketSnapshot({ pageSize: 500, concurrency: 8 });
    const listingDateFor = (code: string) => (snapshot.items.find((item) => item.code === code) as unknown as { listingDate?: string | null }).listingDate;
    assert.ok(requestedFields.every((fields) => fields.split(",").includes("f26")));
    assert.equal(listingDateFor("600000"), "2024-01-01");
    assert.equal(listingDateFor("000001"), "2024-02-02");
    assert.equal(listingDateFor("430001"), null);
    assert.equal(listingDateFor("100003"), "2024-01-01");
    assert.equal(listingDateFor("100004"), null);
    assert.equal(listingDateFor("100005"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

interface WorkerRuntime {
  spawn: typeof spawn;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

const defaultWorkerRuntime: WorkerRuntime = { spawn, setTimeout, clearTimeout };

function createV7Database(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE market_quote_snapshots (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, source_tier TEXT NOT NULL, endpoint TEXT NOT NULL,
      trade_date TEXT NOT NULL, quote_at TEXT NOT NULL, fetched_at TEXT NOT NULL,
      expected_count INTEGER NOT NULL, row_count INTEGER NOT NULL, status TEXT NOT NULL, error TEXT
    );
    CREATE TABLE market_daily_quotes (
      code TEXT NOT NULL, trade_date TEXT NOT NULL, name TEXT NOT NULL, exchange TEXT NOT NULL,
      market TEXT NOT NULL, price REAL, pct_change REAL, open REAL, high REAL, low REAL,
      previous_close REAL, volume REAL, amount REAL, turnover REAL, market_cap REAL, industry_name TEXT,
      quote_at TEXT NOT NULL, fetched_at TEXT NOT NULL, snapshot_id TEXT NOT NULL, provider TEXT NOT NULL,
      source_tier TEXT NOT NULL, quote_url TEXT NOT NULL, PRIMARY KEY(code, trade_date)
    );
    CREATE TABLE market_daily_bars (
      code TEXT NOT NULL, trade_date TEXT NOT NULL, name TEXT NOT NULL, exchange TEXT NOT NULL,
      open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL,
      amount REAL, amplitude REAL, pct_change REAL, change REAL, turnover REAL, adjustment TEXT NOT NULL,
      provider TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY(code, trade_date, adjustment)
    );
    CREATE TABLE provider_state (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, last_attempt_at TEXT,
      last_success_at TEXT, last_record_count INTEGER NOT NULL DEFAULT 0, cursor_json TEXT,
      latency_ms INTEGER, error TEXT, meta_json TEXT
    );
    CREATE TABLE industries (
      industry_code TEXT PRIMARY KEY, name TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1,
      parent_code TEXT, taxonomy TEXT NOT NULL DEFAULT 'eastmoney', taxonomy_version TEXT,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
    );
    CREATE TABLE stock_industry_membership (
      code TEXT NOT NULL, industry_code TEXT NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT,
      source TEXT NOT NULL DEFAULT 'eastmoney', source_field TEXT, confidence REAL NOT NULL DEFAULT 1,
      PRIMARY KEY(code, industry_code, effective_from)
    );
    CREATE TABLE clue_industry_links (
      clue_id TEXT NOT NULL, industry_code TEXT NOT NULL, relevance REAL NOT NULL,
      influence_direction INTEGER NOT NULL, chain_position TEXT, evidence TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(clue_id, industry_code)
    );
    CREATE TABLE industry_daily_snapshots (
      industry_code TEXT NOT NULL, trade_date TEXT NOT NULL, observed_at TEXT NOT NULL, clue_as_of TEXT,
      text_heat REAL NOT NULL, text_direction REAL NOT NULL, text_confidence REAL NOT NULL,
      market_strength REAL NOT NULL, industry_return REAL NOT NULL, market_return REAL NOT NULL,
      market_excess REAL NOT NULL, breadth REAL NOT NULL, amount_share REAL NOT NULL, relation TEXT NOT NULL,
      stage TEXT NOT NULL, driver TEXT NOT NULL, information_categories_json TEXT NOT NULL,
      independent_events INTEGER NOT NULL, mention_count INTEGER NOT NULL, discussion_count INTEGER NOT NULL,
      source_count INTEGER NOT NULL, stock_coverage INTEGER NOT NULL, eligible_stock_count INTEGER NOT NULL,
      methodology_version TEXT NOT NULL, saved_at TEXT NOT NULL, PRIMARY KEY(industry_code, trade_date)
    );
    CREATE TABLE industry_daily_snapshot_members (
      industry_code TEXT NOT NULL, trade_date TEXT NOT NULL, code TEXT NOT NULL,
      PRIMARY KEY(industry_code, trade_date, code)
    );
    CREATE TABLE industry_forward_outcomes (
      industry_code TEXT NOT NULL, signal_trade_date TEXT NOT NULL, horizon INTEGER NOT NULL,
      status TEXT NOT NULL, available_days INTEGER NOT NULL DEFAULT 0, start_trade_date TEXT,
      end_trade_date TEXT, industry_return REAL, market_return REAL, excess_return REAL,
      observed_through TEXT, completed_at TEXT, reason TEXT, saved_at TEXT NOT NULL,
      PRIMARY KEY(industry_code, signal_trade_date, horizon)
    );
    PRAGMA user_version = 7;
  `);
  db.close();
}

async function runDatabaseMigrationWorker(path: string, worker: number, runtime = defaultWorkerRuntime) {
  const moduleUrl = new URL(`./database.ts?parallel-migration-worker=${worker}-${Date.now()}`, import.meta.url).href;
  const child = runtime.spawn(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(moduleUrl)});`,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, TIDE_DATABASE_PATH: path },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const transcript = () => Buffer.concat(output).toString();
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      runtime.clearTimeout(timer);
      callback();
    };
    timer = runtime.setTimeout(() => settle(() => {
      child.kill("SIGTERM");
      reject(new Error(`migration worker ${worker} timed out: ${transcript()}`));
    }), 5_000);
    child.once("error", (error) => settle(() => reject(new Error(`migration worker ${worker} errored: ${error.message}; ${transcript()}`))));
    child.once("close", (code) => {
      settle(() => {
        if (code === 0) resolve();
        else reject(new Error(`migration worker ${worker} exited ${code}: ${transcript()}`));
      });
    });
  });
}

function startDatabaseLockHolder(path: string) {
  return spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    `
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(${JSON.stringify(path)});
      database.exec("BEGIN EXCLUSIVE;");
      console.log("locked");
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      database.exec("ROLLBACK;");
      database.close();
    `,
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
}

async function waitForOutput(child: ReturnType<typeof spawn>, value: string, timeoutMs = 2_000) {
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) throw new Error("lock holder must expose stdout and stderr pipes");
  let output = "";
  let errors = "";
  const failure = (reason: string) => new Error(`${reason}; stdout=${JSON.stringify(output)} stderr=${JSON.stringify(errors)}`);
  if (child.exitCode !== null) throw failure(`lock holder exited ${child.exitCode} before announcing ${value}`);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => settle(() => reject(failure(`lock holder timed out after ${timeoutMs}ms before announcing ${value}`))), timeoutMs);
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(value)) settle(resolve);
    });
    stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    child.once("error", (error) => settle(() => reject(failure(`lock holder errored before announcing ${value}: ${error.message}`))));
    child.once("close", (code) => settle(() => reject(failure(`lock holder exited ${code} before announcing ${value}`))));
    if (child.exitCode !== null) settle(() => reject(failure(`lock holder exited ${child.exitCode} before announcing ${value}`)));
  });
}

async function stopChild(child: ReturnType<typeof spawn>, label: string, timeoutMs: number) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error(`${label} did not exit within ${timeoutMs}ms after SIGTERM`)), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${label} errored while stopping: ${error.message}`));
    });
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    if (child.exitCode !== null) {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function runMigrationWorkerWithin(path: string, worker: number, timeoutMs: number) {
  const moduleUrl = new URL(`./database.ts?bounded-migration-worker=${worker}-${Date.now()}`, import.meta.url).href;
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(moduleUrl)});`,
  ], { cwd: process.cwd(), env: { ...process.env, TIDE_DATABASE_PATH: path }, stdio: ["ignore", "pipe", "pipe"] });
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
  const startedAt = Date.now();
  return await new Promise<{ code: number | null; elapsedMs: number; output: string; timedOut: boolean }>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, elapsedMs: Date.now() - startedAt, output: Buffer.concat(output).toString(), timedOut });
    });
  });
}

async function runReplayWorker(path: string, runtime = defaultWorkerRuntime) {
  const moduleUrl = new URL("./database.ts", import.meta.url).href;
  const suffix = Date.now();
  const script = `
    const database = await import(${JSON.stringify(`${moduleUrl}?replay-primary=${suffix}`)});
    await import(${JSON.stringify(`${moduleUrl}?replay-reload=${suffix}`)});
    function quote(code, tradeDate, listingDate) {
      return {
        code, name: \`测试\${code}\`, exchange: code.startsWith("6") ? "SH" : code.startsWith("4") ? "BJ" : "SZ",
        market: code.startsWith("6") ? "沪市" : code.startsWith("4") ? "北交所" : "深市",
        price: 10, pctChange: 1, open: 9.5, high: 11, low: 9, previousClose: 9.9,
        volume: 100, amount: 1000, turnover: 2, marketCap: 10000, listingDate, industryName: null,
        quoteAt: \`\${tradeDate}T07:00:00.000Z\`, tradeDate,
        quoteUrl: \`https://quote.eastmoney.com/\${code}.html\`, provider: "eastmoney", sourceTier: "primary",
      };
    }
    function snapshotItems(tradeDate, listingDate, listingCode = "600000") {
      return Array.from({ length: 4000 }, (_, index) => quote(
        index === 0 ? listingCode : index === 1 ? "430001" : String(100000 + index),
        tradeDate,
        index === 0 ? listingDate : null,
      ));
    }
    function snapshotFor(tradeDate, items) {
      return {
        provider: "eastmoney", sourceTier: "primary", endpoint: "https://push2.eastmoney.com/api/qt/clist/get",
        expectedCount: items.length, fetchedAt: \`\${tradeDate}T07:00:00.000Z\`, quoteAt: \`\${tradeDate}T07:00:00.000Z\`, tradeDate, items,
      };
    }
    database.saveCompleteMarketSnapshot(snapshotFor("2024-02-02", snapshotItems("2024-02-02", "2024-01-01")));
    database.saveCompleteMarketSnapshot(snapshotFor("2024-02-03", snapshotItems("2024-02-03", null)));
    database.saveCompleteMarketSnapshot(snapshotFor("2024-02-05", snapshotItems("2024-02-05", "2024-01-01", "600001")));
    database.saveCompleteMarketSnapshot(snapshotFor("2024-02-04", snapshotItems("2024-02-04", null, "600001")));
    console.log(JSON.stringify({
      replayed: database.getMarketQuotesByTradeDate("2024-02-03").find((item) => item.code === "600000")?.listingDate,
      backfilled: database.getMarketQuotesByTradeDate("2024-02-04").find((item) => item.code === "600001")?.listingDate,
    }));
  `;
  const child = runtime.spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(), env: { ...process.env, TIDE_DATABASE_PATH: path }, stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) throw new Error("replay worker must expose stdout and stderr pipes");
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const transcript = () => Buffer.concat(stderr).toString();
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      runtime.clearTimeout(timer);
      callback();
    };
    timer = runtime.setTimeout(() => settle(() => {
      child.kill("SIGTERM");
      reject(new Error(`replay worker timed out: ${transcript()}`));
    }), 5_000);
    child.once("error", (error) => settle(() => reject(new Error(`replay worker errored: ${error.message}; ${transcript()}`))));
    child.once("close", (exitCode) => {
      settle(() => resolve(exitCode));
    });
  });
  if (code !== 0) throw new Error(`replay worker exited ${code}: ${Buffer.concat(stderr).toString()}`);
  return JSON.parse(Buffer.concat(stdout).toString()) as { replayed?: string | null; backfilled?: string | null };
}

test("v8-to-v11 migration is reload-safe and replays prior listing dates when f26 is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tide-listing-date-"));
  const path = join(directory, "market.sqlite");
  createV7Database(path);
  try {
    await Promise.all([runDatabaseMigrationWorker(path, 1), runDatabaseMigrationWorker(path, 2)]);
    const postWorkers = new DatabaseSync(path);
    const workerVersion = postWorkers.prepare("PRAGMA user_version").get() as { user_version: number };
    const listingColumns = (postWorkers.prepare("PRAGMA table_info(market_daily_quotes)").all() as Array<{ name: string }>)
      .filter((column) => column.name === "listing_date");
    postWorkers.close();
    assert.equal(workerVersion.user_version, 17);
    assert.equal(listingColumns.length, 1);
    const replay = await runReplayWorker(path);
    assert.equal(replay.replayed, "2024-01-01");
    assert.equal(replay.backfilled, "2024-01-01");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("database startup lock contention fails within a short bounded deadline", async () => {
  const deadlineMs = 2_500;
  const directory = await mkdtemp(join(tmpdir(), "tide-startup-lock-"));
  const path = join(directory, "market.sqlite");
  createV7Database(path);
  const holder = startDatabaseLockHolder(path);
  try {
    await waitForOutput(holder, "locked");
    const result = await runMigrationWorkerWithin(path, 3, deadlineMs);
    assert.equal(result.timedOut, false, `startup retry exceeded deadline: ${result.output}`);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /database is locked|SQLITE_BUSY/i);
    assert.ok(result.elapsedMs <= deadlineMs, `startup retry took ${result.elapsedMs}ms`);
  } finally {
    await stopChild(holder, "startup lock holder", 1_000);
    await rm(directory, { recursive: true, force: true });
  }
});

test("lock-holder lifecycle reports early exits and cleanup never waits for a past close event", async () => {
  const holder = spawn(process.execPath, ["--eval", "console.error('simulated holder crash'); process.exit(17)"], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
  });
  await assert.rejects(waitForOutput(holder, "locked"), /lock holder exited 17 before announcing locked/);
  const cleanupStartedAt = Date.now();
  await stopChild(holder, "early-exit lock holder", 200);
  assert.ok(Date.now() - cleanupStartedAt < 200, "cleanup waited for a close event that had already fired");
});

function spawnErrorRuntime() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    kill: () => true,
  }) as unknown as ReturnType<typeof spawn>;
  const timer = {} as ReturnType<typeof setTimeout>;
  let scheduled = 0;
  let cleared = 0;
  const runtime: WorkerRuntime = {
    spawn: (() => {
      queueMicrotask(() => child.emit("error", new Error("synthetic spawn failure")));
      return child;
    }) as typeof spawn,
    setTimeout: (() => {
      scheduled += 1;
      return timer;
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => { cleared += 1; }) as typeof clearTimeout,
  };
  return { runtime, timers: () => ({ scheduled, cleared }) };
}

test("worker spawn errors clear their watchdogs through the controlled settle path", async () => {
  const migration = spawnErrorRuntime();
  await assert.rejects(runDatabaseMigrationWorker("/ignored.sqlite", 9, migration.runtime), /synthetic spawn failure/);
  assert.deepEqual(migration.timers(), { scheduled: 1, cleared: 1 });

  const replay = spawnErrorRuntime();
  await assert.rejects(runReplayWorker("/ignored.sqlite", replay.runtime), /synthetic spawn failure/);
  assert.deepEqual(replay.timers(), { scheduled: 1, cleared: 1 });
});
