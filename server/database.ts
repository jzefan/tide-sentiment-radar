import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { DailySentimentSnapshot } from "../src/domain/types.ts";
import type { RawClue } from "./eastMoney.ts";
import type {
  EastMoneyAdjustment,
  EastMoneyDailyBar,
  EastMoneyDailyBarResult,
  EastMoneyEndpointTier,
  EastMoneyExchange,
  EastMoneyMarketName,
  EastMoneyMarketQuote,
  EastMoneyMarketSnapshot,
} from "./eastMoneyMarket.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const dataDir = join(root, "data");
mkdirSync(dataDir, { recursive: true });

const configuredDatabasePath = process.env.TIDE_DATABASE_PATH?.trim();
const databasePath = configuredDatabasePath ? resolve(configuredDatabasePath) : join(dataDir, "tide-live.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec("PRAGMA busy_timeout = 5000;");
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS watchlist (
    code TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS clues (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    published_at TEXT NOT NULL,
    url TEXT,
    stock_codes_json TEXT NOT NULL,
    interaction_count INTEGER NOT NULL DEFAULT 0,
    fetched_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS clues_published_at ON clues(published_at DESC);
`);

const schemaVersion = Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
if (schemaVersion < 2) {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS market_quote_snapshots (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK(provider = 'eastmoney'),
      source_tier TEXT NOT NULL CHECK(source_tier IN ('primary', 'delayed')),
      endpoint TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      quote_at TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      expected_count INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('complete', 'failed')),
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS market_snapshot_latest
      ON market_quote_snapshots(status, fetched_at DESC);

    CREATE TABLE IF NOT EXISTS market_daily_quotes (
      code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      name TEXT NOT NULL,
      exchange TEXT NOT NULL CHECK(exchange IN ('SH', 'SZ', 'BJ')),
      market TEXT NOT NULL,
      price REAL,
      pct_change REAL,
      open REAL,
      high REAL,
      low REAL,
      previous_close REAL,
      volume REAL,
      amount REAL,
      turnover REAL,
      market_cap REAL,
      quote_at TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES market_quote_snapshots(id),
      provider TEXT NOT NULL CHECK(provider = 'eastmoney'),
      source_tier TEXT NOT NULL CHECK(source_tier IN ('primary', 'delayed')),
      quote_url TEXT NOT NULL,
      PRIMARY KEY(code, trade_date)
    );
    CREATE INDEX IF NOT EXISTS market_quotes_snapshot
      ON market_daily_quotes(snapshot_id, code);
    CREATE INDEX IF NOT EXISTS market_quotes_trade_date
      ON market_daily_quotes(trade_date DESC, code);
    CREATE INDEX IF NOT EXISTS market_quotes_name
      ON market_daily_quotes(name);

    CREATE TABLE IF NOT EXISTS market_daily_bars (
      code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      name TEXT NOT NULL,
      exchange TEXT NOT NULL CHECK(exchange IN ('SH', 'SZ', 'BJ')),
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL,
      amount REAL,
      amplitude REAL,
      pct_change REAL,
      change REAL,
      turnover REAL,
      adjustment TEXT NOT NULL CHECK(adjustment IN ('none', 'forward', 'backward')),
      provider TEXT NOT NULL CHECK(provider = 'eastmoney'),
      fetched_at TEXT NOT NULL,
      PRIMARY KEY(code, trade_date, adjustment)
    );
    CREATE INDEX IF NOT EXISTS market_daily_bars_lookup
      ON market_daily_bars(code, adjustment, trade_date DESC);

    CREATE TABLE IF NOT EXISTS provider_state (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('connected', 'degraded', 'disabled')),
      last_attempt_at TEXT,
      last_success_at TEXT,
      last_record_count INTEGER NOT NULL DEFAULT 0,
      cursor_json TEXT,
      latency_ms INTEGER,
      error TEXT,
      meta_json TEXT
    );
    PRAGMA user_version = 2;
    COMMIT;
  `);
}

/**
 * v3：历史日线允许来自腾讯行情镜像（provider 从仅 eastmoney 放宽为
 * eastmoney / tencent-mirror）。东财历史主机在部分网络被拒时由镜像回填，
 * 数据内容同为交易所公开行情。
 */
if (schemaVersion < 3) {
  database.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE market_daily_bars RENAME TO market_daily_bars_v2;
    CREATE TABLE market_daily_bars (
      code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      name TEXT NOT NULL,
      exchange TEXT NOT NULL CHECK(exchange IN ('SH', 'SZ', 'BJ')),
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL,
      amount REAL,
      amplitude REAL,
      pct_change REAL,
      change REAL,
      turnover REAL,
      adjustment TEXT NOT NULL CHECK(adjustment IN ('none', 'forward', 'backward')),
      provider TEXT NOT NULL CHECK(provider IN ('eastmoney', 'tencent-mirror')),
      fetched_at TEXT NOT NULL,
      PRIMARY KEY(code, trade_date, adjustment)
    );
    INSERT INTO market_daily_bars(
      code, trade_date, name, exchange, open, high, low, close, volume, amount,
      amplitude, pct_change, change, turnover, adjustment, provider, fetched_at
    )
    SELECT code, trade_date, name, exchange, open, high, low, close, volume, amount,
      amplitude, pct_change, change, turnover, adjustment, provider, fetched_at
    FROM market_daily_bars_v2;
    DROP TABLE market_daily_bars_v2;
    CREATE INDEX IF NOT EXISTS market_daily_bars_lookup
      ON market_daily_bars(code, adjustment, trade_date DESC);
    PRAGMA user_version = 3;
    COMMIT;
  `);
}

/**
 * v4：新增「本机同步推送」的雪球讨论存储表。
 * 远程无头服务器无法稳定直连雪球（WAF / 机房 IP / 无 GUI），因此由本机受信任的
 * 浏览器抓取后通过 /api/xueqiu/push 推送到服务器，服务器只接收、存储、展示。
 */
if (schemaVersion < 4) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS xueqiu_discussions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      published_at TEXT NOT NULL,
      url TEXT,
      stock_codes_json TEXT NOT NULL,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      pushed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS xueqiu_discussions_published
      ON xueqiu_discussions(published_at DESC);
    PRAGMA user_version = 4;
  `);
}

/**
 * v5：新增「每日舆情快照」表。按“股票代码 + 交易日”沉淀当日线索聚合结果
 * （异动分、方向分、情绪因子、主题、摘要等），供异动候选页回看历史交易日的舆情。
 */
if (schemaVersion < 5) {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS stock_daily_sentiment (
      code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      sentiment_json TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      PRIMARY KEY(code, trade_date)
    );
    CREATE INDEX IF NOT EXISTS stock_sentiment_trade_date
      ON stock_daily_sentiment(trade_date, code);
    PRAGMA user_version = 5;
    COMMIT;
  `);
}

const DEFAULT_WATCHLIST = ["300308", "688256", "601138", "600519", "002594"];
const watchlistSeeded = database.prepare("SELECT value FROM app_meta WHERE key = 'watchlist_seeded'").get();
if (!watchlistSeeded) {
  const watchlistCount = Number((database.prepare("SELECT COUNT(*) AS count FROM watchlist").get() as { count: number }).count);
  const insert = database.prepare("INSERT OR IGNORE INTO watchlist(code, created_at) VALUES (?, ?)");
  const now = new Date().toISOString();
  if (watchlistCount === 0) {
    for (const code of DEFAULT_WATCHLIST) insert.run(code, now);
  }
  database.prepare("INSERT INTO app_meta(key, value) VALUES ('watchlist_seeded', ?)").run(now);
}

export function getWatchlist(): string[] {
  return (database.prepare("SELECT code FROM watchlist ORDER BY created_at ASC").all() as Array<{ code: string }>).map((row) => row.code);
}

export function addToWatchlist(code: string) {
  database.prepare("INSERT OR IGNORE INTO watchlist(code, created_at) VALUES (?, ?)").run(code, new Date().toISOString());
  return getWatchlist();
}

export function removeFromWatchlist(code: string) {
  database.prepare("DELETE FROM watchlist WHERE code = ?").run(code);
  return getWatchlist();
}

export function saveClues(clues: RawClue[]) {
  const statement = database.prepare(`
    INSERT INTO clues(id, source, source_kind, title, summary, published_at, url, stock_codes_json, interaction_count, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      summary=excluded.summary,
      published_at=excluded.published_at,
      url=excluded.url,
      stock_codes_json=excluded.stock_codes_json,
      interaction_count=excluded.interaction_count,
      fetched_at=excluded.fetched_at
  `);
  const fetchedAt = new Date().toISOString();
  database.exec("BEGIN");
  try {
    for (const clue of clues) {
      statement.run(clue.id, clue.source, clue.sourceKind, clue.title, clue.summary, clue.publishedAt, clue.url, JSON.stringify(clue.stockCodes), clue.interactionCount, fetchedAt);
    }
    // 只保留最近七天的线索，控制本地库体积；断网回退只需要最新窗口。
    database.prepare("DELETE FROM clues WHERE published_at < ?").run(new Date(Date.now() - 7 * 86_400_000).toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function getStoredClues(limit = 1_000): RawClue[] {
  return (database.prepare(`
    SELECT id, source, source_kind, title, summary, published_at, url, stock_codes_json, interaction_count
    FROM clues ORDER BY published_at DESC LIMIT ?
  `).all(limit) as Array<Record<string, string | number>>).map((row) => ({
    id: String(row.id),
    source: String(row.source),
    sourceKind: String(row.source_kind) as RawClue["sourceKind"],
    title: String(row.title),
    summary: String(row.summary),
    publishedAt: String(row.published_at),
    url: String(row.url || ""),
    stockCodes: JSON.parse(String(row.stock_codes_json)) as string[],
    interactionCount: Number(row.interaction_count),
  }));
}

export function getClueCount(): number {
  return Number((database.prepare("SELECT COUNT(*) AS count FROM clues").get() as { count: number }).count);
}

/** 写入本机同步推送过来的雪球讨论（upsert），并清理 7 天前的旧数据。 */
export function savePushedXueqiuDiscussions(clues: RawClue[]): number {
  if (!clues.length) return 0;
  const statement = database.prepare(`
    INSERT INTO xueqiu_discussions(id, title, summary, published_at, url, stock_codes_json, interaction_count, pushed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      summary=excluded.summary,
      published_at=excluded.published_at,
      url=excluded.url,
      stock_codes_json=excluded.stock_codes_json,
      interaction_count=excluded.interaction_count,
      pushed_at=excluded.pushed_at
  `);
  const pushedAt = new Date().toISOString();
  database.exec("BEGIN");
  try {
    for (const clue of clues) {
      statement.run(clue.id, clue.title, clue.summary, clue.publishedAt, clue.url, JSON.stringify(clue.stockCodes), clue.interactionCount, pushedAt);
    }
    database.prepare("DELETE FROM xueqiu_discussions WHERE published_at < ?").run(new Date(Date.now() - 7 * 86_400_000).toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return clues.length;
}

/** 读取最近 withinHours 小时内、由本机同步推送的雪球讨论（按发布时间倒序）。 */
export function getPushedXueqiuDiscussions(withinHours = 72): RawClue[] {
  const cutoff = new Date(Date.now() - withinHours * 3_600_000).toISOString();
  return (database.prepare(`
    SELECT id, title, summary, published_at, url, stock_codes_json, interaction_count
    FROM xueqiu_discussions WHERE published_at >= ? ORDER BY published_at DESC LIMIT 1000
  `).all(cutoff) as Array<Record<string, string | number>>).map((row) => ({
    id: String(row.id),
    source: "雪球讨论",
    sourceKind: "forum",
    title: String(row.title),
    summary: String(row.summary),
    publishedAt: String(row.published_at),
    url: String(row.url || ""),
    stockCodes: JSON.parse(String(row.stock_codes_json)) as string[],
    interactionCount: Number(row.interaction_count),
  }));
}

export interface MarketSnapshotInfo {
  id: string;
  provider: "eastmoney";
  sourceTier: EastMoneyEndpointTier;
  endpoint: string;
  tradeDate: string;
  quoteAt: string;
  fetchedAt: string;
  expectedCount: number;
  rowCount: number;
  status: "complete" | "failed";
  error: string | null;
}

export interface CompleteMarketSnapshot extends MarketSnapshotInfo {
  status: "complete";
  items: EastMoneyMarketQuote[];
}

export interface ProviderStateInput {
  id: string;
  kind: string;
  state: "connected" | "degraded" | "disabled";
  attemptedAt?: string | null;
  successAt?: string | null;
  recordCount?: number;
  cursor?: unknown;
  latencyMs?: number | null;
  error?: string | null;
  metadata?: unknown;
}

export interface ProviderStateRecord {
  id: string;
  kind: string;
  state: "connected" | "degraded" | "disabled";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastRecordCount: number;
  cursor: unknown;
  latencyMs: number | null;
  error: string | null;
  metadata: unknown;
}

const upsertMarketQuote = database.prepare(`
  INSERT INTO market_daily_quotes(
    code, trade_date, name, exchange, market, price, pct_change, open, high, low,
    previous_close, volume, amount, turnover, market_cap, quote_at, fetched_at,
    snapshot_id, provider, source_tier, quote_url
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'eastmoney', ?, ?)
  ON CONFLICT(code, trade_date) DO UPDATE SET
    name=excluded.name,
    exchange=excluded.exchange,
    market=excluded.market,
    price=excluded.price,
    pct_change=excluded.pct_change,
    open=excluded.open,
    high=excluded.high,
    low=excluded.low,
    previous_close=excluded.previous_close,
    volume=excluded.volume,
    amount=excluded.amount,
    turnover=excluded.turnover,
    market_cap=excluded.market_cap,
    quote_at=excluded.quote_at,
    fetched_at=excluded.fetched_at,
    snapshot_id=excluded.snapshot_id,
    provider=excluded.provider,
    source_tier=excluded.source_tier,
    quote_url=excluded.quote_url
`);

const upsertDailyBar = database.prepare(`
  INSERT INTO market_daily_bars(
    code, trade_date, name, exchange, open, high, low, close, volume, amount,
    amplitude, pct_change, change, turnover, adjustment, provider, fetched_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(code, trade_date, adjustment) DO UPDATE SET
    name=excluded.name,
    exchange=excluded.exchange,
    open=excluded.open,
    high=excluded.high,
    low=excluded.low,
    close=excluded.close,
    volume=excluded.volume,
    amount=excluded.amount,
    amplitude=excluded.amplitude,
    pct_change=excluded.pct_change,
    change=excluded.change,
    turnover=excluded.turnover,
    provider=excluded.provider,
    fetched_at=excluded.fetched_at
`);

const upsertProvider = database.prepare(`
  INSERT INTO provider_state(
    id, kind, state, last_attempt_at, last_success_at, last_record_count,
    cursor_json, latency_ms, error, meta_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    kind=excluded.kind,
    state=excluded.state,
    last_attempt_at=COALESCE(excluded.last_attempt_at, provider_state.last_attempt_at),
    last_success_at=COALESCE(excluded.last_success_at, provider_state.last_success_at),
    last_record_count=excluded.last_record_count,
    cursor_json=COALESCE(excluded.cursor_json, provider_state.cursor_json),
    latency_ms=excluded.latency_ms,
    error=excluded.error,
    meta_json=COALESCE(excluded.meta_json, provider_state.meta_json)
`);

/** Atomically publishes one fully validated EastMoney all-market snapshot. */
export function saveCompleteMarketSnapshot(snapshot: EastMoneyMarketSnapshot): MarketSnapshotInfo {
  if (snapshot.provider !== "eastmoney") throw new Error("行情批次仅接受东方财富数据");
  if (snapshot.items.length < 4_000) throw new Error(`完整行情至少需要 4000 条，当前 ${snapshot.items.length} 条`);
  // 占位行情（如盘前延迟接口返回 "-"）会被整批拒绝，避免污染「最新完整快照」导致全市场异动为空。
  if (snapshot.items.filter((item) => item.price !== null).length < 4_000) {
    throw new Error(`完整行情需要至少 4000 条含有效价格的记录，当前仅有 ${snapshot.items.filter((item) => item.price !== null).length} 条`);
  }
  const uniqueCodes = new Set(snapshot.items.map((item) => item.code));
  if (uniqueCodes.size !== snapshot.items.length) throw new Error("完整行情批次包含重复股票代码");
  if (snapshot.items.some((item) => item.tradeDate !== snapshot.tradeDate)) {
    throw new Error("完整行情批次内交易日期不一致");
  }

  const id = crypto.randomUUID();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      INSERT INTO market_quote_snapshots(
        id, provider, source_tier, endpoint, trade_date, quote_at, fetched_at,
        expected_count, row_count, status, error
      ) VALUES (?, 'eastmoney', ?, ?, ?, ?, ?, ?, ?, 'complete', NULL)
    `).run(
      id,
      snapshot.sourceTier,
      snapshot.endpoint,
      snapshot.tradeDate,
      snapshot.quoteAt,
      snapshot.fetchedAt,
      snapshot.expectedCount,
      snapshot.items.length,
    );
    for (const quote of snapshot.items) {
      upsertMarketQuote.run(
        quote.code,
        snapshot.tradeDate,
        quote.name,
        quote.exchange,
        quote.market,
        quote.price,
        quote.pctChange,
        quote.open,
        quote.high,
        quote.low,
        quote.previousClose,
        quote.volume,
        quote.amount,
        quote.turnover,
        quote.marketCap,
        quote.quoteAt,
        snapshot.fetchedAt,
        id,
        snapshot.sourceTier,
        quote.quoteUrl,
      );
    }
    writeProviderState({
      id: "eastmoney_market",
      kind: "market",
      state: "connected",
      attemptedAt: snapshot.fetchedAt,
      successAt: snapshot.fetchedAt,
      recordCount: snapshot.items.length,
      error: null,
      metadata: {
        snapshotId: id,
        sourceTier: snapshot.sourceTier,
        tradeDate: snapshot.tradeDate,
        quoteAt: snapshot.quoteAt,
        expectedCount: snapshot.expectedCount,
      },
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return {
    id,
    provider: "eastmoney",
    sourceTier: snapshot.sourceTier,
    endpoint: snapshot.endpoint,
    tradeDate: snapshot.tradeDate,
    quoteAt: snapshot.quoteAt,
    fetchedAt: snapshot.fetchedAt,
    expectedCount: snapshot.expectedCount,
    rowCount: snapshot.items.length,
    status: "complete",
    error: null,
  };
}

/** Records a failed all-market attempt without changing the last complete batch. */
export function recordMarketSnapshotFailure(input: {
  sourceTier: EastMoneyEndpointTier;
  endpoint: string;
  error: string;
  attemptedAt?: string;
}): MarketSnapshotInfo {
  const id = crypto.randomUUID();
  const attemptedAt = input.attemptedAt ?? new Date().toISOString();
  const tradeDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date(attemptedAt));
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      INSERT INTO market_quote_snapshots(
        id, provider, source_tier, endpoint, trade_date, quote_at, fetched_at,
        expected_count, row_count, status, error
      ) VALUES (?, 'eastmoney', ?, ?, ?, ?, ?, 0, 0, 'failed', ?)
    `).run(id, input.sourceTier, input.endpoint, tradeDate, attemptedAt, attemptedAt, input.error);
    writeProviderState({
      id: "eastmoney_market",
      kind: "market",
      state: "degraded",
      attemptedAt,
      recordCount: getProviderState("eastmoney_market")?.lastRecordCount ?? 0,
      error: input.error,
      metadata: { sourceTier: input.sourceTier, endpoint: input.endpoint },
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return {
    id,
    provider: "eastmoney",
    sourceTier: input.sourceTier,
    endpoint: input.endpoint,
    tradeDate,
    quoteAt: attemptedAt,
    fetchedAt: attemptedAt,
    expectedCount: 0,
    rowCount: 0,
    status: "failed",
    error: input.error,
  };
}

/** 有有效价格记录的完整快照数量下限（低于此值视为占位/异常批次，不当作完整行情）。 */
const MIN_VALID_PRICE_ROWS = 4_000;

export function getLatestCompleteMarketSnapshot(): CompleteMarketSnapshot | null {
  const row = database.prepare(`
    SELECT * FROM market_quote_snapshots
    WHERE status = 'complete'
      AND (SELECT COUNT(*) FROM market_daily_quotes q WHERE q.snapshot_id = market_quote_snapshots.id AND q.price IS NOT NULL) >= ?
    ORDER BY fetched_at DESC LIMIT 1
  `).get(MIN_VALID_PRICE_ROWS) as Record<string, unknown> | undefined;
  if (!row) return null;
  const info = marketSnapshotFromRow(row);
  return {
    ...info,
    status: "complete",
    items: getMarketQuotesBySnapshot(info.id),
  };
}

export function getLatestCompleteMarketQuotes(): EastMoneyMarketQuote[] {
  const snapshot = database.prepare(`
    SELECT id FROM market_quote_snapshots
    WHERE status = 'complete'
      AND (SELECT COUNT(*) FROM market_daily_quotes q WHERE q.snapshot_id = market_quote_snapshots.id AND q.price IS NOT NULL) >= ?
    ORDER BY fetched_at DESC LIMIT 1
  `).get(MIN_VALID_PRICE_ROWS) as { id: string } | undefined;
  return snapshot ? getMarketQuotesBySnapshot(snapshot.id) : [];
}

/** 批量读取一批股票最近若干交易日的成交额（升序，用于 5 天成交额柱状图）。可传 endDate 限定不晚于某交易日（历史异动视图）。 */
export function getRecentAmounts(codes: string[], days = 5, endDate?: string): Map<string, Array<{ tradeDate: string; amount: number }>> {
  const result = new Map<string, Array<{ tradeDate: string; amount: number }>>();
  if (!codes.length) return result;
  const placeholders = codes.map(() => "?").join(",");
  const endClause = endDate ? " AND trade_date <= ?" : "";
  const rows = database.prepare(`
    SELECT code, trade_date, amount FROM market_daily_quotes
    WHERE code IN (${placeholders})${endClause}
    ORDER BY code, trade_date DESC
  `).all(...(endDate ? [...codes, endDate] : codes)) as Array<{ code: string; trade_date: string; amount: number | null }>;
  for (const row of rows) {
    if (row.amount === null || !Number.isFinite(row.amount)) continue;
    const list = result.get(row.code) ?? [];
    if (list.length < days) list.push({ tradeDate: String(row.trade_date), amount: row.amount });
    result.set(row.code, list);
  }
  for (const list of result.values()) list.reverse();
  return result;
}

/** 列出所有已完整保存的交易日（降序，YYYY-MM-DD）。 */
export function listTradeDates(): string[] {
  return (database.prepare(`
    SELECT DISTINCT trade_date FROM market_daily_quotes ORDER BY trade_date DESC
  `).all() as Array<{ trade_date: string }>).map((row) => String(row.trade_date));
}

/** 读取某个交易日全市场的每日行情快照（用于历史每日异动）。 */
export function getMarketQuotesByTradeDate(tradeDate: string): EastMoneyMarketQuote[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error("交易日必须是 YYYY-MM-DD");
  return (database.prepare(`
    SELECT q.* FROM market_daily_quotes q
    WHERE q.trade_date = ?
    ORDER BY q.code
  `).all(tradeDate) as Array<Record<string, unknown>>).map(marketQuoteFromRow);
}

/** 原子写入某个交易日的每日舆情快照（upsert，同股票同日只保留最新一次聚合结果）。 */
export function saveDailySentiment(rows: Array<{ code: string; tradeDate: string; sentiment: DailySentimentSnapshot }>): number {
  if (!rows.length) return 0;
  const statement = database.prepare(`
    INSERT INTO stock_daily_sentiment(code, trade_date, sentiment_json, saved_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(code, trade_date) DO UPDATE SET
      sentiment_json = excluded.sentiment_json,
      saved_at = excluded.saved_at
  `);
  const savedAt = new Date().toISOString();
  database.exec("BEGIN");
  try {
    for (const row of rows) {
      statement.run(row.code, row.tradeDate, JSON.stringify(row.sentiment), savedAt);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return rows.length;
}

/** 读取某个交易日的每日舆情快照，按股票代码返回。 */
export function getDailySentiment(tradeDate: string): Map<string, DailySentimentSnapshot> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error("交易日必须是 YYYY-MM-DD");
  const rows = database.prepare(`
    SELECT code, sentiment_json FROM stock_daily_sentiment WHERE trade_date = ?
  `).all(tradeDate) as Array<{ code: string; sentiment_json: string }>;
  const result = new Map<string, DailySentimentSnapshot>();
  for (const row of rows) {
    try {
      result.set(String(row.code), JSON.parse(String(row.sentiment_json)) as DailySentimentSnapshot);
    } catch {
      // 单条损坏不影响整体读取。
    }
  }
  return result;
}

export function getLatestMarketQuote(code: string): EastMoneyMarketQuote | null {
  const normalized = validateCode(code);
  const row = database.prepare(`
    SELECT q.*
    FROM market_daily_quotes q
    JOIN market_quote_snapshots s ON s.id = q.snapshot_id
    WHERE q.code = ? AND s.status = 'complete'
    ORDER BY s.fetched_at DESC LIMIT 1
  `).get(normalized) as Record<string, unknown> | undefined;
  return row ? marketQuoteFromRow(row) : null;
}

/** Atomically upserts a validated daily-bar response and its provider state. */
export function saveEastMoneyDailyBars(result: EastMoneyDailyBarResult): number {
  if (result.provider !== "eastmoney" && result.provider !== "tencent-mirror") {
    throw new Error("日 K 仅接受东方财富或腾讯行情镜像数据");
  }
  if (!result.items.length) return 0;
  if (result.items.some((item) => item.code !== result.code || item.adjustment !== result.adjustment)) {
    throw new Error("日 K 批次代码或复权方式不一致");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const bar of result.items) {
      upsertDailyBar.run(
        bar.code,
        bar.tradeDate,
        bar.name,
        bar.exchange,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.volume,
        bar.amount,
        bar.amplitude,
        bar.pctChange,
        bar.change,
        bar.turnover,
        bar.adjustment,
        bar.provider,
        bar.fetchedAt,
      );
    }
    writeProviderState({
      id: "eastmoney_kline",
      kind: "market-history",
      state: "connected",
      attemptedAt: result.fetchedAt,
      successAt: result.fetchedAt,
      recordCount: result.items.length,
      error: null,
      metadata: {
        code: result.code,
        provider: result.provider,
        adjustment: result.adjustment,
        firstTradeDate: result.items[0]?.tradeDate,
        lastTradeDate: result.items.at(-1)?.tradeDate,
      },
    });
    database.exec("COMMIT");
    return result.items.length;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function getEastMoneyDailyBars(
  code: string,
  options: { adjustment?: EastMoneyAdjustment; start?: string; end?: string; limit?: number } = {},
): EastMoneyDailyBar[] {
  const normalized = validateCode(code);
  const adjustment = options.adjustment ?? "none";
  const start = options.start?.replaceAll("-", "") ?? "00000000";
  const end = options.end?.replaceAll("-", "") ?? "99999999";
  if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) throw new Error("日 K 查询日期必须使用 YYYYMMDD 或 YYYY-MM-DD");
  const limit = Math.min(5_000, Math.max(1, Math.trunc(options.limit ?? 250)));
  const rows = database.prepare(`
    SELECT * FROM market_daily_bars
    WHERE code = ? AND adjustment = ?
      AND REPLACE(trade_date, '-', '') BETWEEN ? AND ?
    ORDER BY trade_date DESC LIMIT ?
  `).all(normalized, adjustment, start, end, limit) as Array<Record<string, unknown>>;
  return rows.map(dailyBarFromRow).reverse();
}

export function saveProviderState(input: ProviderStateInput): ProviderStateRecord {
  writeProviderState(input);
  return getProviderState(input.id)!;
}

export function getProviderState(id: string): ProviderStateRecord | null {
  const row = database.prepare("SELECT * FROM provider_state WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? providerStateFromRow(row) : null;
}

export function getProviderStates(): ProviderStateRecord[] {
  return (database.prepare("SELECT * FROM provider_state ORDER BY id").all() as Array<Record<string, unknown>>)
    .map(providerStateFromRow);
}

function getMarketQuotesBySnapshot(snapshotId: string): EastMoneyMarketQuote[] {
  return (database.prepare(`
    SELECT * FROM market_daily_quotes
    WHERE snapshot_id = ? ORDER BY code
  `).all(snapshotId) as Array<Record<string, unknown>>).map(marketQuoteFromRow);
}

function writeProviderState(input: ProviderStateInput) {
  upsertProvider.run(
    input.id,
    input.kind,
    input.state,
    input.attemptedAt ?? null,
    input.successAt ?? null,
    input.recordCount ?? 0,
    input.cursor === undefined ? null : JSON.stringify(input.cursor),
    input.latencyMs ?? null,
    input.error ?? null,
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
  );
}

function marketSnapshotFromRow(row: Record<string, unknown>): MarketSnapshotInfo {
  return {
    id: String(row.id),
    provider: "eastmoney",
    sourceTier: String(row.source_tier) as EastMoneyEndpointTier,
    endpoint: String(row.endpoint),
    tradeDate: String(row.trade_date),
    quoteAt: String(row.quote_at),
    fetchedAt: String(row.fetched_at),
    expectedCount: Number(row.expected_count),
    rowCount: Number(row.row_count),
    status: String(row.status) as MarketSnapshotInfo["status"],
    error: row.error === null || row.error === undefined ? null : String(row.error),
  };
}

function marketQuoteFromRow(row: Record<string, unknown>): EastMoneyMarketQuote {
  return {
    code: String(row.code),
    name: String(row.name),
    exchange: String(row.exchange) as EastMoneyExchange,
    market: String(row.market) as EastMoneyMarketName,
    price: nullableNumber(row.price),
    pctChange: nullableNumber(row.pct_change),
    open: nullableNumber(row.open),
    high: nullableNumber(row.high),
    low: nullableNumber(row.low),
    previousClose: nullableNumber(row.previous_close),
    volume: nullableNumber(row.volume),
    amount: nullableNumber(row.amount),
    turnover: nullableNumber(row.turnover),
    marketCap: nullableNumber(row.market_cap),
    quoteAt: String(row.quote_at),
    tradeDate: String(row.trade_date),
    quoteUrl: String(row.quote_url),
    provider: "eastmoney",
    sourceTier: String(row.source_tier) as EastMoneyEndpointTier,
  };
}

function dailyBarFromRow(row: Record<string, unknown>): EastMoneyDailyBar {
  return {
    code: String(row.code),
    name: String(row.name),
    exchange: String(row.exchange) as EastMoneyExchange,
    tradeDate: String(row.trade_date),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: nullableNumber(row.volume),
    amount: nullableNumber(row.amount),
    amplitude: nullableNumber(row.amplitude),
    pctChange: nullableNumber(row.pct_change),
    change: nullableNumber(row.change),
    turnover: nullableNumber(row.turnover),
    adjustment: String(row.adjustment) as EastMoneyAdjustment,
    provider: String(row.provider) as EastMoneyDailyBar["provider"],
    fetchedAt: String(row.fetched_at),
  };
}

function providerStateFromRow(row: Record<string, unknown>): ProviderStateRecord {
  return {
    id: String(row.id),
    kind: String(row.kind),
    state: String(row.state) as ProviderStateRecord["state"],
    lastAttemptAt: nullableString(row.last_attempt_at),
    lastSuccessAt: nullableString(row.last_success_at),
    lastRecordCount: Number(row.last_record_count),
    cursor: parseJson(row.cursor_json),
    latencyMs: nullableNumber(row.latency_ms),
    error: nullableString(row.error),
    metadata: parseJson(row.meta_json),
  };
}

function validateCode(code: string) {
  const normalized = code.trim();
  if (!/^\d{6}$/.test(normalized)) throw new Error("股票代码必须是 6 位数字");
  return normalized;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}
