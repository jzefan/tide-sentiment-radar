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
import {
  industryCodeForName,
  normalizeIndustryName,
  type ClueIndustryLink,
  type ClueIndustryLinkInput,
  type IndustryMembershipInput,
  type IndustryRecord,
  type StockIndustryMembership,
} from "./industry.ts";
import type { DragonTigerRecord, LimitUpRecord } from "./leadership.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const dataDir = join(root, "data");
mkdirSync(dataDir, { recursive: true });

const configuredDatabasePath = process.env.TIDE_DATABASE_PATH?.trim();
const databasePath = configuredDatabasePath ? resolve(configuredDatabasePath) : join(dataDir, "tide-live.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
const NORMAL_BUSY_TIMEOUT_MS = 5_000;
const STARTUP_BUSY_TIMEOUT_MS = 75;
const STARTUP_LOCK_DEADLINE_MS = 750;
database.exec(`PRAGMA busy_timeout = ${STARTUP_BUSY_TIMEOUT_MS};`);
try {
  executeStartupSql(`
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
} finally {
  database.exec(`PRAGMA busy_timeout = ${NORMAL_BUSY_TIMEOUT_MS};`);
}

/** 多进程冷启动会短暂争用 WAL 切换和基础建表；总等待受单一截止时间限制。 */
function executeStartupSql(sql: string) {
  const deadline = Date.now() + STARTUP_LOCK_DEADLINE_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      database.exec(sql);
      return;
    } catch (error) {
      if (!isDatabaseBusy(error)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      const backoff = Math.min(100, 10 * (2 ** Math.min(attempt, 4)));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(backoff, remaining));
    }
  }
}

function isDatabaseBusy(error: unknown) {
  return error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message);
}

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

/**
 * v6：沉淀东方财富 f100 行业归属与线索—行业关系。
 * 行情字段缺失是允许的；行业表与归属表独立于行情主链，避免 f100 异常导致整批行情失败。
 */
if (schemaVersion < 6) {
  database.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE market_daily_quotes ADD COLUMN industry_name TEXT;
    CREATE TABLE IF NOT EXISTS industries (
      industry_code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 1 CHECK(level BETWEEN 1 AND 3),
      parent_code TEXT,
      taxonomy TEXT NOT NULL DEFAULT 'eastmoney',
      taxonomy_version TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE(taxonomy, name)
    );
    CREATE INDEX IF NOT EXISTS industries_name ON industries(name);
    CREATE INDEX IF NOT EXISTS industries_parent ON industries(parent_code);

    CREATE TABLE IF NOT EXISTS stock_industry_membership (
      code TEXT NOT NULL,
      industry_code TEXT NOT NULL REFERENCES industries(industry_code),
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      source TEXT NOT NULL DEFAULT 'eastmoney',
      source_field TEXT,
      confidence REAL NOT NULL DEFAULT 1 CHECK(confidence >= 0 AND confidence <= 1),
      PRIMARY KEY(code, industry_code, effective_from)
    );
    CREATE INDEX IF NOT EXISTS stock_industry_lookup
      ON stock_industry_membership(code, effective_from DESC);
    CREATE INDEX IF NOT EXISTS industry_stock_lookup
      ON stock_industry_membership(industry_code, effective_from DESC);

    CREATE TABLE IF NOT EXISTS clue_industry_links (
      clue_id TEXT NOT NULL REFERENCES clues(id) ON DELETE CASCADE,
      industry_code TEXT NOT NULL REFERENCES industries(industry_code),
      relevance REAL NOT NULL CHECK(relevance >= 0 AND relevance <= 100),
      influence_direction INTEGER NOT NULL CHECK(influence_direction IN (-1, 0, 1)),
      chain_position TEXT,
      evidence TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(clue_id, industry_code)
    );
    CREATE INDEX IF NOT EXISTS clue_industry_links_industry
      ON clue_industry_links(industry_code, created_at DESC);
    PRAGMA user_version = 6;
    COMMIT;
  `);
}

/**
 * v7：行业每日冻结快照与前瞻结算。
 * 行业快照保存当日文本/行情的独立结果；行业成员单独留档，确保未来行业改名或换
 * 分类后，T+N 仍按信号日的股票集合计算。后验表一条记录对应一个行业快照和一个观察周期。
 */
if (schemaVersion < 7) {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS industry_daily_snapshots (
      industry_code TEXT NOT NULL REFERENCES industries(industry_code),
      trade_date TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      clue_as_of TEXT,
      text_heat REAL NOT NULL,
      text_direction REAL NOT NULL,
      text_confidence REAL NOT NULL,
      market_strength REAL NOT NULL,
      industry_return REAL NOT NULL,
      market_return REAL NOT NULL,
      market_excess REAL NOT NULL,
      breadth REAL NOT NULL,
      amount_share REAL NOT NULL,
      relation TEXT NOT NULL,
      stage TEXT NOT NULL,
      driver TEXT NOT NULL,
      information_categories_json TEXT NOT NULL,
      independent_events INTEGER NOT NULL,
      mention_count INTEGER NOT NULL,
      discussion_count INTEGER NOT NULL,
      source_count INTEGER NOT NULL,
      stock_coverage INTEGER NOT NULL,
      eligible_stock_count INTEGER NOT NULL,
      methodology_version TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      PRIMARY KEY(industry_code, trade_date)
    );
    CREATE INDEX IF NOT EXISTS industry_daily_snapshots_trade_date
      ON industry_daily_snapshots(trade_date DESC, industry_code);

    CREATE TABLE IF NOT EXISTS industry_daily_snapshot_members (
      industry_code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      code TEXT NOT NULL,
      PRIMARY KEY(industry_code, trade_date, code),
      FOREIGN KEY(industry_code, trade_date)
        REFERENCES industry_daily_snapshots(industry_code, trade_date) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS industry_snapshot_members_code
      ON industry_daily_snapshot_members(code, trade_date DESC);

    CREATE TABLE IF NOT EXISTS industry_forward_outcomes (
      industry_code TEXT NOT NULL,
      signal_trade_date TEXT NOT NULL,
      horizon INTEGER NOT NULL CHECK(horizon IN (1, 3, 5, 10)),
      status TEXT NOT NULL CHECK(status IN ('observing', 'completed', 'unavailable')),
      available_days INTEGER NOT NULL DEFAULT 0,
      start_trade_date TEXT,
      end_trade_date TEXT,
      industry_return REAL,
      market_return REAL,
      excess_return REAL,
      observed_through TEXT,
      completed_at TEXT,
      reason TEXT,
      saved_at TEXT NOT NULL,
      PRIMARY KEY(industry_code, signal_trade_date, horizon),
      FOREIGN KEY(industry_code, signal_trade_date)
        REFERENCES industry_daily_snapshots(industry_code, trade_date) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS industry_forward_outcomes_lookup
      ON industry_forward_outcomes(industry_code, horizon, status, signal_trade_date DESC);
    PRAGMA user_version = 7;
    COMMIT;
  `);
}

/** v8：保存东方财富 f26 上市日期，供历史行情回放复用。 */
if (schemaVersion < 8) {
  database.exec("BEGIN IMMEDIATE;");
  try {
    // 锁定后再检查：并发启动的第二个进程会看到第一个迁移已创建的列。
    const quoteColumns = database.prepare("PRAGMA table_info(market_daily_quotes)").all() as Array<{ name: string }>;
    if (!quoteColumns.some((column) => column.name === "listing_date")) {
      database.exec("ALTER TABLE market_daily_quotes ADD COLUMN listing_date TEXT;");
    }
    database.exec("PRAGMA user_version = 8; COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

/** v9：每日聚焦榜单、冻结基准成员与 T+3 观察结果。 */
if (schemaVersion < 9) {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS daily_candidate_lists (
      trade_date TEXT PRIMARY KEY,
      methodology_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('frozen', 'unavailable', 'reconstructed')),
      origin TEXT NOT NULL CHECK(origin IN ('prospective', 'reconstructed')),
      feature_cutoff TEXT NOT NULL,
      market_as_of TEXT,
      clue_as_of TEXT,
      frozen_at TEXT,
      universe_count INTEGER NOT NULL,
      eligible_count INTEGER NOT NULL,
      selected_count INTEGER NOT NULL,
      methodology_json TEXT NOT NULL,
      data_quality_json TEXT NOT NULL,
      exclusion_counts_json TEXT NOT NULL,
      reason TEXT
    );
    CREATE TABLE IF NOT EXISTS daily_candidate_benchmark_members (
      trade_date TEXT NOT NULL REFERENCES daily_candidate_lists(trade_date) ON DELETE CASCADE,
      code TEXT NOT NULL,
      industry_code TEXT,
      industry_name TEXT,
      PRIMARY KEY(trade_date, code)
    );
    CREATE TABLE IF NOT EXISTS daily_candidate_entries (
      trade_date TEXT NOT NULL REFERENCES daily_candidate_lists(trade_date) ON DELETE CASCADE,
      code TEXT NOT NULL,
      rank INTEGER NOT NULL,
      grade TEXT NOT NULL CHECK(grade IN ('A', 'B')),
      is_hot_industry INTEGER NOT NULL,
      base_score REAL NOT NULL,
      overheat_penalty REAL NOT NULL,
      final_score REAL NOT NULL,
      scores_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      reasons_json TEXT NOT NULL,
      PRIMARY KEY(trade_date, code),
      UNIQUE(trade_date, rank)
    );
    CREATE TABLE IF NOT EXISTS daily_candidate_outcomes (
      signal_trade_date TEXT NOT NULL,
      code TEXT NOT NULL,
      horizon INTEGER NOT NULL CHECK(horizon = 3),
      status TEXT NOT NULL CHECK(status IN ('observing', 'completed', 'unavailable')),
      entry_trade_date TEXT,
      entry_open REAL,
      exit_trade_date TEXT,
      exit_close REAL,
      stock_return REAL,
      market_return REAL,
      market_excess REAL,
      industry_return REAL,
      industry_excess REAL,
      max_adverse REAL,
      coverage REAL,
      completed_at TEXT,
      reason TEXT,
      PRIMARY KEY(signal_trade_date, code, horizon)
    );
    CREATE INDEX IF NOT EXISTS daily_candidate_lists_origin_date
      ON daily_candidate_lists(origin, trade_date DESC);
    CREATE INDEX IF NOT EXISTS daily_candidate_outcomes_observing
      ON daily_candidate_outcomes(status, signal_trade_date, code);
    PRAGMA user_version = 9;
    COMMIT;
  `);
}

/** v10：outcome 绑定信号日的冻结入选项，删除榜单时级联删除后验记录。 */
if (schemaVersion < 10) {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const orphan = database.prepare(`
      SELECT o.signal_trade_date, o.code, o.horizon
      FROM daily_candidate_outcomes o
      LEFT JOIN daily_candidate_entries e
        ON e.trade_date = o.signal_trade_date AND e.code = o.code
      WHERE e.code IS NULL
      ORDER BY o.signal_trade_date, o.code, o.horizon
      LIMIT 1
    `).get() as { signal_trade_date: string; code: string; horizon: number } | undefined;
    if (orphan) {
      throw new Error(`v10 migration blocked by orphan daily candidate outcome ${orphan.signal_trade_date}/${orphan.code}/${orphan.horizon}`);
    }
    database.exec(`
      ALTER TABLE daily_candidate_outcomes RENAME TO daily_candidate_outcomes_v9;
      CREATE TABLE daily_candidate_outcomes (
        signal_trade_date TEXT NOT NULL,
        code TEXT NOT NULL,
        horizon INTEGER NOT NULL CHECK(horizon = 3),
        status TEXT NOT NULL CHECK(status IN ('observing', 'completed', 'unavailable')),
        entry_trade_date TEXT,
        entry_open REAL,
        exit_trade_date TEXT,
        exit_close REAL,
        stock_return REAL,
        market_return REAL,
        market_excess REAL,
        industry_return REAL,
        industry_excess REAL,
        max_adverse REAL,
        coverage REAL,
        completed_at TEXT,
        reason TEXT,
        PRIMARY KEY(signal_trade_date, code, horizon),
        FOREIGN KEY(signal_trade_date, code)
          REFERENCES daily_candidate_entries(trade_date, code) ON DELETE CASCADE
      );
      INSERT INTO daily_candidate_outcomes(
        signal_trade_date, code, horizon, status, entry_trade_date, entry_open, exit_trade_date, exit_close,
        stock_return, market_return, market_excess, industry_return, industry_excess, max_adverse, coverage, completed_at, reason
      )
      SELECT signal_trade_date, code, horizon, status, entry_trade_date, entry_open, exit_trade_date, exit_close,
        stock_return, market_return, market_excess, industry_return, industry_excess, max_adverse, coverage, completed_at, reason
      FROM daily_candidate_outcomes_v9;
      DROP TABLE daily_candidate_outcomes_v9;
      CREATE INDEX IF NOT EXISTS daily_candidate_outcomes_observing
        ON daily_candidate_outcomes(status, signal_trade_date, code);
      PRAGMA user_version = 10;
      COMMIT;
    `);
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

/** v11：后验结果保留实际使用的最新行情数据水位，供结算审计。 */
if (schemaVersion < 11) {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const columns = database.prepare("PRAGMA table_info(daily_candidate_outcomes)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "data_as_of")) database.exec("ALTER TABLE daily_candidate_outcomes ADD COLUMN data_as_of TEXT;");
    database.exec("PRAGMA user_version = 11; COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

/** v12：按代码读取最近 N 个交易日时，窗口函数可直接走代码/日期复合索引。 */
if (schemaVersion < 12) {
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.exec(`
      CREATE INDEX IF NOT EXISTS market_quotes_code_trade_date
        ON market_daily_quotes(code, trade_date DESC);
      PRAGMA user_version = 12;
      COMMIT;
    `);
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

/** v13：每日讨论基线以来源范围证明和逐代码聚合一同持久化，供前视冻结重建。 */
if (schemaVersion < 13) {
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS daily_discussion_windows (
        code TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        source_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        source_state TEXT NOT NULL CHECK(source_state IN ('connected', 'degraded', 'disabled')),
        feature_start TEXT NOT NULL,
        feature_cutoff TEXT NOT NULL,
        query_from TEXT NOT NULL,
        query_to TEXT NOT NULL,
        cursor_exhausted INTEGER NOT NULL CHECK(cursor_exhausted IN (0, 1)),
        covered_through TEXT NOT NULL,
        discussion_count INTEGER NOT NULL CHECK(discussion_count >= 0),
        interactions INTEGER NOT NULL CHECK(interactions >= 0),
        saved_at TEXT NOT NULL,
        PRIMARY KEY(code, trade_date, source_id)
      );
      CREATE INDEX IF NOT EXISTS daily_discussion_windows_date_code
        ON daily_discussion_windows(trade_date DESC, code);
      PRAGMA user_version = 13;
      COMMIT;
    `);
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

/** v14：保留行情适配器明确提供的涨跌停幅度，避免只凭代码前缀猜测板块规则。 */
if (schemaVersion < 14) {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const columns = database.prepare("PRAGMA table_info(market_daily_quotes)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "limit_percent")) {
      database.exec("ALTER TABLE market_daily_quotes ADD COLUMN limit_percent INTEGER CHECK(limit_percent IN (5, 10, 20));");
    }
    database.exec("PRAGMA user_version = 14; COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

/** v15：讨论窗保留服务端逐代码覆盖集，重建时拒绝把未覆盖标的视作零讨论。 */
if (schemaVersion < 15) {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const columns = database.prepare("PRAGMA table_info(daily_discussion_windows)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "coverage_codes_json")) {
      database.exec("ALTER TABLE daily_discussion_windows ADD COLUMN coverage_codes_json TEXT NOT NULL DEFAULT '[]';");
    }
    database.exec("PRAGMA user_version = 15; COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

/** v16：板块涨跌停规则按来源、版本与生效区间留档，禁止代码前缀猜测。 */
if (schemaVersion < 16) {
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS board_limit_metadata (
        code TEXT NOT NULL,
        limit_percent INTEGER NOT NULL CHECK(limit_percent IN (5, 10, 20)),
        effective_from TEXT NOT NULL,
        effective_to TEXT,
        source TEXT NOT NULL,
        source_version TEXT NOT NULL,
        source_url TEXT,
        saved_at TEXT NOT NULL,
        PRIMARY KEY(code, effective_from, source, source_version)
      );
      CREATE INDEX IF NOT EXISTS board_limit_metadata_lookup
        ON board_limit_metadata(code, effective_from DESC, effective_to);
      PRAGMA user_version = 16;
      COMMIT;
    `);
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

/** v17：涨停板池与龙虎榜按交易日留档，作为「当前时段龙头」的可核验外部依据。 */
if (schemaVersion < 17) {
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS daily_limit_up_pool (
        code TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        name TEXT NOT NULL,
        exchange TEXT NOT NULL CHECK(exchange IN ('SH', 'SZ', 'BJ')),
        close REAL,
        pct_change REAL,
        amount REAL,
        turnover REAL,
        float_market_cap REAL,
        board_count INTEGER NOT NULL,
        stat_days INTEGER,
        stat_count INTEGER,
        first_seal_time TEXT,
        last_seal_time TEXT,
        break_count INTEGER NOT NULL,
        seal_amount REAL,
        industry_name TEXT,
        source_url TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY(code, trade_date)
      );
      CREATE INDEX IF NOT EXISTS daily_limit_up_pool_board
        ON daily_limit_up_pool(trade_date, board_count DESC);
      CREATE TABLE IF NOT EXISTS daily_dragon_tiger (
        code TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        name TEXT NOT NULL,
        close REAL,
        pct_change REAL,
        net_amount REAL,
        buy_amount REAL,
        sell_amount REAL,
        deal_amount REAL,
        turnover REAL,
        reasons_json TEXT NOT NULL,
        explanations_json TEXT NOT NULL,
        list_count INTEGER NOT NULL,
        source_url TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY(code, trade_date)
      );
      CREATE TABLE IF NOT EXISTS leadership_sync_state (
        trade_date TEXT PRIMARY KEY,
        fetched_at TEXT NOT NULL,
        pool_count INTEGER NOT NULL,
        billboard_count INTEGER NOT NULL,
        verification TEXT NOT NULL CHECK(verification IN ('verified', 'unverified', 'empty')),
        note TEXT
      );
      PRAGMA user_version = 17;
      COMMIT;
    `);
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
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
  database.prepare("INSERT OR IGNORE INTO app_meta(key, value) VALUES ('watchlist_seeded', ?)").run(now);
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

export function getStoredCluesBySource(source: string, limit = 10, offset = 0): { items: RawClue[]; total: number } {
  const latestFetchedAt = (database.prepare("SELECT MAX(fetched_at) AS fetchedAt FROM clues WHERE source = ?").get(source) as { fetchedAt: string | null }).fetchedAt;
  if (!latestFetchedAt) return { items: [], total: 0 };
  const total = Number((database.prepare("SELECT COUNT(*) AS count FROM clues WHERE source = ? AND fetched_at = ?").get(source, latestFetchedAt) as { count: number }).count);
  const rows = database.prepare(`
    SELECT id, source, source_kind, title, summary, published_at, url, stock_codes_json, interaction_count
    FROM clues
    WHERE source = ? AND fetched_at = ?
    ORDER BY published_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(source, latestFetchedAt, limit, offset) as Array<Record<string, string | number>>;
  const items = rows.map((row) => ({
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
  return { items, total };
}

export function getClueCount(): number {
  return Number((database.prepare("SELECT COUNT(*) AS count FROM clues").get() as { count: number }).count);
}

export interface DailyDiscussionWindowRecord {
  code: string;
  tradeDate: string;
  sourceId: string;
  adapterId: string;
  state: "connected" | "degraded" | "disabled";
  featureStart: string;
  featureCutoff: string;
  queryFrom: string;
  queryTo: string;
  cursorExhausted: boolean;
  coveredThrough: string;
  /** Server-echoed exact per-code coverage set for this source window. */
  coveredCodes: string[];
  count: number;
  interactions: number;
}

export interface BoardLimitMetadataRecord {
  code: string;
  limitPercent: 5 | 10 | 20;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
  sourceVersion: string;
  sourceUrl: string | null;
}

export function saveBoardLimitMetadata(records: BoardLimitMetadataRecord[]): void {
  const insert = database.prepare(`
    INSERT INTO board_limit_metadata(code, limit_percent, effective_from, effective_to, source, source_version, source_url, saved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code, effective_from, source, source_version) DO NOTHING
  `);
  const savedAt = new Date().toISOString();
  database.exec("BEGIN");
  try {
    for (const record of records) {
      if (!/^\d{6}$/.test(record.code) || !/^\d{4}-\d{2}-\d{2}$/.test(record.effectiveFrom) || (record.effectiveTo !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(record.effectiveTo) || record.effectiveTo < record.effectiveFrom)) || !record.source.trim() || !record.sourceVersion.trim()) throw new Error("invalid board limit metadata");
      insert.run(record.code, record.limitPercent, record.effectiveFrom, record.effectiveTo, record.source, record.sourceVersion, record.sourceUrl, savedAt);
    }
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

export function resolveBoardLimitMetadata(code: string, tradeDate: string): BoardLimitMetadataRecord | null {
  const row = database.prepare(`
    SELECT code, limit_percent, effective_from, effective_to, source, source_version, source_url
    FROM board_limit_metadata
    WHERE code = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY effective_from DESC, saved_at DESC LIMIT 1
  `).get(code, tradeDate, tradeDate) as Record<string, unknown> | undefined;
  return row ? { code: String(row.code), limitPercent: Number(row.limit_percent) as 5 | 10 | 20, effectiveFrom: String(row.effective_from), effectiveTo: nullableString(row.effective_to), source: String(row.source), sourceVersion: String(row.source_version), sourceUrl: nullableString(row.source_url) } : null;
}

export function saveDailyDiscussionWindows(windows: DailyDiscussionWindowRecord[]): void {
  const insert = database.prepare(`
    INSERT INTO daily_discussion_windows(code, trade_date, source_id, adapter_id, source_state, feature_start, feature_cutoff, query_from, query_to, cursor_exhausted, covered_through, coverage_codes_json, discussion_count, interactions, saved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code, trade_date, source_id) DO NOTHING
  `);
  const savedAt = new Date().toISOString();
  database.exec("BEGIN");
  try {
    for (const window of windows) {
      if (!/^\d{6}$/.test(window.code) || !/^\d{4}-\d{2}-\d{2}$/.test(window.tradeDate) || !Number.isSafeInteger(window.count) || !Number.isSafeInteger(window.interactions) || window.count < 0 || window.interactions < 0) throw new Error("invalid daily discussion window");
      const coveredCodes = [...new Set(window.coveredCodes.filter((code) => /^\d{6}$/.test(code)))].sort();
      if (!coveredCodes.includes(window.code)) throw new Error("daily discussion window must include its code in coverage proof");
      insert.run(window.code, window.tradeDate, window.sourceId, window.adapterId, window.state, window.featureStart, window.featureCutoff, window.queryFrom, window.queryTo, window.cursorExhausted ? 1 : 0, window.coveredThrough, canonicalJson(coveredCodes), window.count, window.interactions, savedAt);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function getDailyDiscussionWindows(tradeDates: string[]): Record<string, DailyDiscussionWindowRecord[]> {
  if (!tradeDates.length) return {};
  const placeholders = tradeDates.map(() => "?").join(",");
  const rows = database.prepare(`
    SELECT code, trade_date, source_id, adapter_id, source_state, feature_start, feature_cutoff, query_from, query_to, cursor_exhausted, covered_through, coverage_codes_json, discussion_count, interactions
    FROM daily_discussion_windows
    WHERE trade_date IN (${placeholders})
    ORDER BY code, trade_date, source_id
  `).all(...tradeDates) as Array<Record<string, string | number>>;
  return rows.reduce<Record<string, DailyDiscussionWindowRecord[]>>((result, row) => {
    const code = String(row.code);
    (result[code] ??= []).push({
      code, tradeDate: String(row.trade_date), sourceId: String(row.source_id), adapterId: String(row.adapter_id), state: String(row.source_state) as DailyDiscussionWindowRecord["state"],
      featureStart: String(row.feature_start), featureCutoff: String(row.feature_cutoff), queryFrom: String(row.query_from), queryTo: String(row.query_to), cursorExhausted: Number(row.cursor_exhausted) === 1,
      coveredThrough: String(row.covered_through), coveredCodes: parseCoverageCodes(row.coverage_codes_json), count: Number(row.discussion_count), interactions: Number(row.interactions),
    });
    return result;
  }, {});
}

function parseCoverageCodes(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? [...new Set(parsed.filter((code): code is string => typeof code === "string" && /^\d{6}$/.test(code)))].sort() : [];
  } catch { return []; }
}

export type DailyCandidateListStatus = "frozen" | "unavailable" | "reconstructed";
export type DailyCandidateListOrigin = "prospective" | "reconstructed";
export type DailyCandidateOutcomeStatus = "observing" | "completed" | "unavailable";

export interface DailyCandidateBenchmarkMember {
  code: string;
  industryCode: string | null;
  industryName: string | null;
}

export interface DailyCandidateEntry {
  code: string;
  rank: number;
  grade: "A" | "B";
  isHotIndustry: boolean;
  baseScore: number;
  overheatPenalty: number;
  finalScore: number;
  scores: unknown;
  snapshot: unknown;
  reasons: unknown;
}

export interface DailyCandidateListInput {
  tradeDate: string;
  methodologyVersion: string;
  status: DailyCandidateListStatus;
  origin: DailyCandidateListOrigin;
  featureCutoff: string;
  marketAsOf?: string | null;
  clueAsOf?: string | null;
  frozenAt?: string | null;
  universeCount: number;
  eligibleCount: number;
  selectedCount: number;
  methodology: unknown;
  dataQuality: unknown;
  exclusionCounts: unknown;
  reason?: string | null;
  benchmarkMembers?: DailyCandidateBenchmarkMember[];
  items?: DailyCandidateEntry[];
}

export interface DailyCandidateList extends Required<Omit<DailyCandidateListInput, "reason" | "marketAsOf" | "clueAsOf" | "frozenAt">> {
  marketAsOf: string | null;
  clueAsOf: string | null;
  frozenAt: string | null;
  reason: string | null;
}

export interface DailyCandidateOutcome {
  signalTradeDate: string;
  code: string;
  horizon: 3;
  status: DailyCandidateOutcomeStatus;
  entryTradeDate: string | null;
  entryOpen: number | null;
  exitTradeDate: string | null;
  exitClose: number | null;
  stockReturn: number | null;
  marketReturn: number | null;
  marketExcess: number | null;
  industryReturn: number | null;
  industryExcess: number | null;
  maxAdverse: number | null;
  coverage: number | null;
  dataAsOf?: string | null;
  completedAt: string | null;
  reason: string | null;
}

const DAILY_CANDIDATE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const dailyCandidateListStatuses = new Set<DailyCandidateListStatus>(["frozen", "unavailable", "reconstructed"]);
const dailyCandidateOrigins = new Set<DailyCandidateListOrigin>(["prospective", "reconstructed"]);
const dailyCandidateOutcomeStatuses = new Set<DailyCandidateOutcomeStatus>(["observing", "completed", "unavailable"]);

function isIsoCalendarDate(value: string): boolean {
  if (!DAILY_CANDIDATE_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export interface SaveDailyCandidateListOptions {
  /**
   * The current-day orchestrator may replace an empty prospective `unavailable`
   * attempt with a real frozen list after late close data arrives. The caller
   * must retain the superseded audit; frozen/reconstructed lists remain immutable.
   */
  replaceUnavailableWithFrozen?: boolean;
}

/**
 * 保存不可变的每日聚焦榜单。相同日期只接受规范化后完全相同的重试；
 * 唯一例外是当日完整数据晚到后，把空的 unavailable 尝试升级为真实冻结名单。
 */
export function saveDailyCandidateList(input: DailyCandidateListInput, options: SaveDailyCandidateListOptions = {}): DailyCandidateList {
  const list = normalizeDailyCandidateList(input);
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = getDailyCandidateListRow(list.tradeDate);
    if (existing) {
      const canUpgradeUnavailable = options.replaceUnavailableWithFrozen === true
        && existing.status === "unavailable"
        && existing.origin === "prospective"
        && existing.items.length === 0
        && list.status === "frozen"
        && list.origin === "prospective";
      if (!canUpgradeUnavailable) {
        if (canonicalJson(normalizeDailyCandidateList(existing)) !== canonicalJson(list)) {
          throw new Error(`每日聚焦榜单 ${list.tradeDate} 已冻结，immutable payload conflict`);
        }
        database.exec("COMMIT");
        return existing;
      }
      database.prepare("DELETE FROM daily_candidate_lists WHERE trade_date = ?").run(list.tradeDate);
    }
    database.prepare(`
      INSERT INTO daily_candidate_lists(
        trade_date, methodology_version, status, origin, feature_cutoff, market_as_of,
        clue_as_of, frozen_at, universe_count, eligible_count, selected_count,
        methodology_json, data_quality_json, exclusion_counts_json, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      list.tradeDate, list.methodologyVersion, list.status, list.origin, list.featureCutoff,
      list.marketAsOf, list.clueAsOf, list.frozenAt, list.universeCount, list.eligibleCount,
      list.selectedCount, canonicalJson(list.methodology), canonicalJson(list.dataQuality),
      canonicalJson(list.exclusionCounts), list.reason,
    );
    const benchmark = database.prepare(`
      INSERT INTO daily_candidate_benchmark_members(trade_date, code, industry_code, industry_name)
      VALUES (?, ?, ?, ?)
    `);
    for (const member of list.benchmarkMembers) {
      benchmark.run(list.tradeDate, member.code, member.industryCode, member.industryName);
    }
    const entry = database.prepare(`
      INSERT INTO daily_candidate_entries(
        trade_date, code, rank, grade, is_hot_industry, base_score, overheat_penalty,
        final_score, scores_json, snapshot_json, reasons_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of list.items) {
      entry.run(
        list.tradeDate, item.code, item.rank, item.grade, item.isHotIndustry ? 1 : 0,
        item.baseScore, item.overheatPenalty, item.finalScore, canonicalJson(item.scores),
        canonicalJson(item.snapshot), canonicalJson(item.reasons),
      );
    }
    database.exec("COMMIT");
    return list;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function getDailyCandidateList(tradeDate: string): DailyCandidateList | null {
  if (!isIsoCalendarDate(tradeDate)) throw new Error("交易日必须是 YYYY-MM-DD");
  return getDailyCandidateListRow(tradeDate);
}

/** 默认仅返回真实前瞻榜单；回溯重建必须由调用方显式选择。 */
export function listDailyCandidateLists(options: { includeReconstructed?: boolean } = {}): DailyCandidateList[] {
  const rows = (options.includeReconstructed
    ? database.prepare("SELECT trade_date FROM daily_candidate_lists ORDER BY trade_date DESC").all()
    : database.prepare("SELECT trade_date FROM daily_candidate_lists WHERE origin = 'prospective' ORDER BY trade_date DESC").all()
  ) as Array<{ trade_date: string }>;
  return rows.map((row) => getDailyCandidateListRow(String(row.trade_date))).filter((row): row is DailyCandidateList => row !== null);
}

/** 保存 T+3 观察结果；仅允许首次 observing，或 observing 到最终状态的一次迁移。 */
export function saveDailyCandidateOutcomes(inputs: DailyCandidateOutcome[]): DailyCandidateOutcome[] {
  const outcomes = inputs.map(normalizeDailyCandidateOutcome);
  const keys = new Set<string>();
  for (const outcome of outcomes) {
    const key = `${outcome.signalTradeDate}:${outcome.code}:${outcome.horizon}`;
    if (keys.has(key)) throw new Error("outcome batch contains duplicate key");
    keys.add(key);
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const saved: DailyCandidateOutcome[] = [];
    for (const outcome of outcomes) {
      const existing = getDailyCandidateOutcomeRow(outcome.signalTradeDate, outcome.code, outcome.horizon);
      if (!existing) {
        if (outcome.status !== "observing") throw new Error("outcome must begin observing");
        insertDailyCandidateOutcome(outcome);
        saved.push(outcome);
        continue;
      }
      if (canonicalJson(existing) === canonicalJson(outcome)) {
        saved.push(existing);
        continue;
      }
      if (existing.status !== "observing") throw new Error("final outcome is immutable");
      if (outcome.status === "observing") throw new Error("observing outcome payload conflict");
      updateDailyCandidateOutcome(outcome);
      saved.push(outcome);
    }
    database.exec("COMMIT");
    return saved;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function getObservingDailyCandidateOutcomes(): DailyCandidateOutcome[] {
  const rows = database.prepare(`
    SELECT * FROM daily_candidate_outcomes WHERE status = 'observing'
    ORDER BY signal_trade_date ASC, code ASC
  `).all() as Array<Record<string, unknown>>;
  return rows.map(dailyCandidateOutcomeFromRow);
}

/** Read-only outcome lookup for prospective-performance aggregation. */
export function getDailyCandidateOutcomes(signalTradeDate: string): DailyCandidateOutcome[] {
  if (!isIsoCalendarDate(signalTradeDate)) throw new Error("交易日必须是 YYYY-MM-DD");
  return (database.prepare(`SELECT * FROM daily_candidate_outcomes WHERE signal_trade_date = ? ORDER BY code`).all(signalTradeDate) as Array<Record<string, unknown>>).map(dailyCandidateOutcomeFromRow);
}

/** 返回 signalDate 之后至多 limit 个真实交易日，升序。 */
export function getTradeDatesAfter(signalTradeDate: string, limit = 6): string[] {
  if (!isIsoCalendarDate(signalTradeDate)) throw new Error("交易日必须是 YYYY-MM-DD");
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit 必须是正整数");
  return (database.prepare(`
    SELECT DISTINCT trade_date FROM market_daily_quotes
    WHERE trade_date > ? ORDER BY trade_date ASC LIMIT ?
  `).all(signalTradeDate, limit) as Array<{ trade_date: string }>).map((row) => String(row.trade_date));
}

/** 读取 [from, to) 的线索窗口；服务可据此构造六个同交易时长的比较窗口。 */
export function getCluesInWindow(from: string, to: string): RawClue[] {
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || from >= to) {
    throw new Error("线索窗口必须是有效的升序时间范围");
  }
  const rows = database.prepare(`
    SELECT id, source, source_kind, title, summary, published_at, url, stock_codes_json, interaction_count
    FROM clues WHERE published_at >= ? AND published_at < ? ORDER BY published_at ASC, id ASC
  `).all(from, to) as Array<Record<string, unknown>>;
  return rows.map(clueFromRow);
}

function getDailyCandidateListRow(tradeDate: string): DailyCandidateList | null {
  const row = database.prepare("SELECT * FROM daily_candidate_lists WHERE trade_date = ?").get(tradeDate) as Record<string, unknown> | undefined;
  if (!row) return null;
  const benchmarkMembers = (database.prepare(`
    SELECT code, industry_code, industry_name FROM daily_candidate_benchmark_members
    WHERE trade_date = ? ORDER BY code ASC
  `).all(tradeDate) as Array<Record<string, unknown>>).map((member) => ({
    code: String(member.code), industryCode: nullableString(member.industry_code), industryName: nullableString(member.industry_name),
  }));
  const items = (database.prepare(`
    SELECT * FROM daily_candidate_entries WHERE trade_date = ? ORDER BY rank ASC, code ASC
  `).all(tradeDate) as Array<Record<string, unknown>>).map((item) => ({
    code: String(item.code), rank: Number(item.rank), grade: String(item.grade) as "A" | "B",
    isHotIndustry: Number(item.is_hot_industry) === 1, baseScore: Number(item.base_score),
    overheatPenalty: Number(item.overheat_penalty), finalScore: Number(item.final_score),
    scores: parseJson(item.scores_json), snapshot: parseJson(item.snapshot_json), reasons: parseJson(item.reasons_json),
  }));
  return {
    tradeDate: String(row.trade_date), methodologyVersion: String(row.methodology_version),
    status: String(row.status) as DailyCandidateListStatus, origin: String(row.origin) as DailyCandidateListOrigin,
    featureCutoff: String(row.feature_cutoff), marketAsOf: nullableString(row.market_as_of),
    clueAsOf: nullableString(row.clue_as_of), frozenAt: nullableString(row.frozen_at),
    universeCount: Number(row.universe_count), eligibleCount: Number(row.eligible_count), selectedCount: Number(row.selected_count),
    methodology: parseJson(row.methodology_json), dataQuality: parseJson(row.data_quality_json),
    exclusionCounts: parseJson(row.exclusion_counts_json), reason: nullableString(row.reason), benchmarkMembers, items,
  };
}

function normalizeDailyCandidateList(input: DailyCandidateListInput): DailyCandidateList {
  if (!isIsoCalendarDate(input.tradeDate)) throw new Error("交易日必须是 YYYY-MM-DD");
  if (!input.methodologyVersion.trim() || !input.featureCutoff.trim()) throw new Error("榜单缺少方法版本或特征截止时间");
  if (!dailyCandidateListStatuses.has(input.status) || !dailyCandidateOrigins.has(input.origin)) throw new Error("榜单状态或来源无效");
  if ((input.status === "reconstructed") !== (input.origin === "reconstructed")) throw new Error("重建榜单必须同时标记 reconstructed 状态和来源");
  if (input.status === "unavailable" && !nullableString(input.reason)?.trim()) throw new Error("unavailable 榜单必须提供 reason");
  const counts = [input.universeCount, input.eligibleCount, input.selectedCount];
  if (!counts.every((value) => Number.isInteger(value) && value >= 0) || input.eligibleCount > input.universeCount || input.selectedCount > input.eligibleCount) {
    throw new Error("榜单计数无效");
  }
  const benchmarkMembers = (input.benchmarkMembers ?? []).map((member) => ({
    code: validateCode(member.code), industryCode: nullableString(member.industryCode), industryName: nullableString(member.industryName),
  })).sort((left, right) => left.code.localeCompare(right.code));
  if (new Set(benchmarkMembers.map((member) => member.code)).size !== benchmarkMembers.length) throw new Error("benchmark code duplicate");
  const items = (input.items ?? []).map((item) => normalizeDailyCandidateEntry(item)).sort((left, right) => left.rank - right.rank || left.code.localeCompare(right.code));
  if (items.length !== input.selectedCount) throw new Error("selectedCount 必须等于 entries 数量");
  if (new Set(items.map((item) => item.code)).size !== items.length || new Set(items.map((item) => item.rank)).size !== items.length) {
    throw new Error("entry code 或 rank duplicate");
  }
  if (input.status === "unavailable") {
    if (input.selectedCount !== 0 || items.length !== 0) throw new Error("unavailable 榜单必须 selectedCount=0 且 entries 为空");
  } else {
    if (input.selectedCount < 1 || input.selectedCount > 10) throw new Error("frozen/reconstructed 榜单必须包含 1 到 10 个 entries");
    if (!items.every((item, index) => item.rank === index + 1)) throw new Error("frozen/reconstructed entries 的 rank 必须从 1 连续");
  }
  return {
    tradeDate: input.tradeDate, methodologyVersion: input.methodologyVersion, status: input.status, origin: input.origin,
    featureCutoff: input.featureCutoff, marketAsOf: nullableString(input.marketAsOf), clueAsOf: nullableString(input.clueAsOf),
    frozenAt: nullableString(input.frozenAt), universeCount: input.universeCount, eligibleCount: input.eligibleCount,
    selectedCount: input.selectedCount, methodology: normalizedJson(input.methodology), dataQuality: normalizedJson(input.dataQuality),
    exclusionCounts: normalizedJson(input.exclusionCounts), reason: nullableString(input.reason), benchmarkMembers, items,
  };
}

function normalizeDailyCandidateEntry(item: DailyCandidateEntry): DailyCandidateEntry {
  if (!Number.isInteger(item.rank) || item.rank < 1 || (item.grade !== "A" && item.grade !== "B") || typeof item.isHotIndustry !== "boolean") {
    throw new Error("entry rank、grade 或 hot 标记无效");
  }
  if (![item.baseScore, item.overheatPenalty, item.finalScore].every(Number.isFinite)) throw new Error("entry score 无效");
  return {
    code: validateCode(item.code), rank: item.rank, grade: item.grade, isHotIndustry: item.isHotIndustry,
    baseScore: item.baseScore, overheatPenalty: item.overheatPenalty, finalScore: item.finalScore,
    scores: normalizedJson(item.scores), snapshot: normalizedJson(item.snapshot), reasons: normalizedJson(item.reasons),
  };
}

function normalizeDailyCandidateOutcome(input: DailyCandidateOutcome): DailyCandidateOutcome {
  if (!isIsoCalendarDate(input.signalTradeDate) || input.horizon !== 3 || !dailyCandidateOutcomeStatuses.has(input.status)) {
    throw new Error("outcome 日期、周期或状态无效");
  }
  const numberFields = [input.entryOpen, input.exitClose, input.stockReturn, input.marketReturn, input.marketExcess, input.industryReturn, input.industryExcess, input.maxAdverse, input.coverage];
  if (numberFields.some((value) => value !== null && !Number.isFinite(value))) throw new Error("outcome 数值无效");
  const outcome = {
    ...input, code: validateCode(input.code), entryTradeDate: nullableString(input.entryTradeDate), exitTradeDate: nullableString(input.exitTradeDate),
    dataAsOf: nullableString(input.dataAsOf), completedAt: nullableString(input.completedAt), reason: nullableString(input.reason),
  };
  const settlementFields = [
    outcome.entryTradeDate, outcome.entryOpen, outcome.exitTradeDate, outcome.exitClose,
    outcome.stockReturn, outcome.marketReturn, outcome.marketExcess, outcome.industryReturn,
    outcome.industryExcess, outcome.maxAdverse, outcome.coverage, outcome.dataAsOf, outcome.completedAt,
  ];
  const suppliedDates = [outcome.entryTradeDate, outcome.exitTradeDate];
  if (suppliedDates.some((value) => value !== null && !isIsoCalendarDate(value)) ||
    (outcome.entryTradeDate !== null && outcome.signalTradeDate >= outcome.entryTradeDate) ||
    (outcome.exitTradeDate !== null && outcome.signalTradeDate >= outcome.exitTradeDate) ||
    (outcome.entryTradeDate !== null && outcome.exitTradeDate !== null && outcome.entryTradeDate > outcome.exitTradeDate) ||
    (outcome.entryOpen !== null && outcome.entryOpen <= 0) ||
    (outcome.exitClose !== null && outcome.exitClose <= 0) ||
    (outcome.maxAdverse !== null && outcome.maxAdverse > 0) ||
    (outcome.coverage !== null && (outcome.coverage < 0 || outcome.coverage > 1)) ||
    (outcome.dataAsOf !== null && !Number.isFinite(Date.parse(outcome.dataAsOf))) ||
    (outcome.completedAt !== null && !Number.isFinite(Date.parse(outcome.completedAt)))) {
    throw new Error("outcome partial settlement fields 无效");
  }
  if (outcome.status === "observing") {
    if (settlementFields.some((value) => value !== null)) throw new Error("observing outcome 不能包含终态结算字段");
    return outcome;
  }
  if (outcome.status === "completed") {
    const requiredDates = [outcome.entryTradeDate, outcome.exitTradeDate];
    const requiredNumbers = [outcome.entryOpen, outcome.exitClose, outcome.stockReturn, outcome.marketReturn, outcome.marketExcess, outcome.maxAdverse, outcome.coverage];
    if (requiredDates.some((value) => value === null || !isIsoCalendarDate(value)) ||
      requiredNumbers.some((value) => value === null || !Number.isFinite(value)) ||
      outcome.entryOpen === null || outcome.entryOpen <= 0 || outcome.exitClose === null || outcome.exitClose <= 0 ||
      outcome.entryTradeDate === null || outcome.exitTradeDate === null || outcome.signalTradeDate >= outcome.entryTradeDate || outcome.entryTradeDate > outcome.exitTradeDate ||
      outcome.maxAdverse === null || outcome.maxAdverse > 0 || outcome.coverage === null || outcome.coverage < 0.9 || outcome.coverage > 1 ||
      outcome.dataAsOf === null || !Number.isFinite(Date.parse(outcome.dataAsOf)) ||
      outcome.completedAt === null || !Number.isFinite(Date.parse(outcome.completedAt))) {
      throw new Error("completed outcome 缺少有效结算字段或 coverage 越界");
    }
  }
  if (outcome.status === "unavailable" && !outcome.reason?.trim()) throw new Error("unavailable outcome 必须提供 reason");
  return outcome;
}

function insertDailyCandidateOutcome(outcome: DailyCandidateOutcome) {
  database.prepare(`
    INSERT INTO daily_candidate_outcomes(
      signal_trade_date, code, horizon, status, entry_trade_date, entry_open, exit_trade_date, exit_close,
      stock_return, market_return, market_excess, industry_return, industry_excess, max_adverse, coverage, data_as_of, completed_at, reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(...dailyCandidateOutcomeValues(outcome));
}

function updateDailyCandidateOutcome(outcome: DailyCandidateOutcome) {
  database.prepare(`
    UPDATE daily_candidate_outcomes SET status=?, entry_trade_date=?, entry_open=?, exit_trade_date=?, exit_close=?,
      stock_return=?, market_return=?, market_excess=?, industry_return=?, industry_excess=?, max_adverse=?, coverage=?, data_as_of=?,
      completed_at=?, reason=? WHERE signal_trade_date=? AND code=? AND horizon=?
  `).run(
    outcome.status, outcome.entryTradeDate, outcome.entryOpen, outcome.exitTradeDate, outcome.exitClose,
    outcome.stockReturn, outcome.marketReturn, outcome.marketExcess, outcome.industryReturn, outcome.industryExcess,
    outcome.maxAdverse, outcome.coverage, outcome.dataAsOf ?? null, outcome.completedAt, outcome.reason, outcome.signalTradeDate, outcome.code, outcome.horizon,
  );
}

function dailyCandidateOutcomeValues(outcome: DailyCandidateOutcome) {
  return [
    outcome.signalTradeDate, outcome.code, outcome.horizon, outcome.status, outcome.entryTradeDate, outcome.entryOpen,
    outcome.exitTradeDate, outcome.exitClose, outcome.stockReturn, outcome.marketReturn, outcome.marketExcess,
    outcome.industryReturn, outcome.industryExcess, outcome.maxAdverse, outcome.coverage, outcome.dataAsOf ?? null, outcome.completedAt, outcome.reason,
  ];
}

function getDailyCandidateOutcomeRow(signalTradeDate: string, code: string, horizon: 3): DailyCandidateOutcome | null {
  const row = database.prepare(`
    SELECT * FROM daily_candidate_outcomes WHERE signal_trade_date = ? AND code = ? AND horizon = ?
  `).get(signalTradeDate, code, horizon) as Record<string, unknown> | undefined;
  return row ? dailyCandidateOutcomeFromRow(row) : null;
}

function dailyCandidateOutcomeFromRow(row: Record<string, unknown>): DailyCandidateOutcome {
  return {
    signalTradeDate: String(row.signal_trade_date), code: String(row.code), horizon: Number(row.horizon) as 3,
    status: String(row.status) as DailyCandidateOutcomeStatus, entryTradeDate: nullableString(row.entry_trade_date),
    entryOpen: nullableNumber(row.entry_open), exitTradeDate: nullableString(row.exit_trade_date), exitClose: nullableNumber(row.exit_close),
    stockReturn: nullableNumber(row.stock_return), marketReturn: nullableNumber(row.market_return), marketExcess: nullableNumber(row.market_excess),
    industryReturn: nullableNumber(row.industry_return), industryExcess: nullableNumber(row.industry_excess), maxAdverse: nullableNumber(row.max_adverse),
    coverage: nullableNumber(row.coverage), dataAsOf: nullableString(row.data_as_of), completedAt: nullableString(row.completed_at), reason: nullableString(row.reason),
  };
}

function clueFromRow(row: Record<string, unknown>): RawClue {
  return {
    id: String(row.id), source: String(row.source), sourceKind: String(row.source_kind) as RawClue["sourceKind"],
    title: String(row.title), summary: String(row.summary), publishedAt: String(row.published_at), url: String(row.url ?? ""),
    stockCodes: JSON.parse(String(row.stock_codes_json)) as string[], interactionCount: Number(row.interaction_count),
  };
}

function normalizedJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON payload 包含无效数值");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : normalizedJson(item));
  if (typeof value === "object" && value !== null && isPlainJsonObject(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizedJson(item)]));
  }
  throw new Error("JSON payload 必须可序列化");
}

function isPlainJsonObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizedJson(value));
}

/** 仅供临时数据库夹具在删除目录前显式释放 SQLite 文件句柄。 */
export function closeDatabaseForTests() {
  database.close();
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
    previous_close, volume, amount, turnover, market_cap, listing_date, industry_name, limit_percent, quote_at, fetched_at,
    snapshot_id, provider, source_tier, quote_url
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'eastmoney', ?, ?)
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
    listing_date=COALESCE(excluded.listing_date, market_daily_quotes.listing_date),
    -- 新行情没有 f100 时保留这只股票已有的行业字段；行业成员表同时提供历史回退。
    industry_name=COALESCE(excluded.industry_name, market_daily_quotes.industry_name),
    limit_percent=COALESCE(excluded.limit_percent, market_daily_quotes.limit_percent),
    quote_at=excluded.quote_at,
    fetched_at=excluded.fetched_at,
    snapshot_id=excluded.snapshot_id,
    provider=excluded.provider,
    source_tier=excluded.source_tier,
    quote_url=excluded.quote_url
`);

const upsertBoardLimitMetadata = database.prepare(`
  INSERT INTO board_limit_metadata(code, limit_percent, effective_from, effective_to, source, source_version, source_url, saved_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(code, effective_from, source, source_version) DO NOTHING
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

const upsertIndustry = database.prepare(`
  INSERT INTO industries(
    industry_code, name, level, parent_code, taxonomy, taxonomy_version,
    first_seen_at, last_seen_at
  ) VALUES (?, ?, 1, NULL, 'eastmoney', ?, ?, ?)
  ON CONFLICT(industry_code) DO UPDATE SET
    name=excluded.name,
    taxonomy_version=COALESCE(excluded.taxonomy_version, industries.taxonomy_version),
    last_seen_at=excluded.last_seen_at
`);

const upsertStockIndustryMembership = database.prepare(`
  INSERT INTO stock_industry_membership(
    code, industry_code, effective_from, effective_to, source, source_field, confidence
  ) VALUES (?, ?, ?, NULL, ?, ?, ?)
  ON CONFLICT(code, industry_code, effective_from) DO UPDATE SET
    effective_to=excluded.effective_to,
    source=excluded.source,
    source_field=excluded.source_field,
    confidence=excluded.confidence
`);

const closeSameCodeIndustryMemberships = database.prepare(`
  UPDATE stock_industry_membership
  SET effective_to = ?
  WHERE code = ?
    AND industry_code <> ?
    AND effective_from < ?
    AND (effective_to IS NULL OR effective_to >= ?)
`);

const deleteSameDayIndustryMemberships = database.prepare(`
  DELETE FROM stock_industry_membership
  WHERE code = ? AND industry_code <> ? AND effective_from = ?
`);

const upsertClueIndustryLink = database.prepare(`
  INSERT INTO clue_industry_links(
    clue_id, industry_code, relevance, influence_direction, chain_position, evidence, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(clue_id, industry_code) DO UPDATE SET
    relevance=excluded.relevance,
    influence_direction=excluded.influence_direction,
    chain_position=excluded.chain_position,
    evidence=excluded.evidence,
    created_at=excluded.created_at
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
      if (quote.boardLimitMetadata) {
        const metadata = quote.boardLimitMetadata;
        upsertBoardLimitMetadata.run(quote.code, metadata.limitPercent, metadata.effectiveFrom, metadata.effectiveTo, metadata.source, metadata.sourceVersion, metadata.sourceUrl, snapshot.fetchedAt);
      }
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
        quote.listingDate ?? latestKnownListingDate(quote.code),
        quote.industryName,
        quote.limitPercent ?? null,
        quote.quoteAt,
        snapshot.fetchedAt,
        id,
        snapshot.sourceTier,
        quote.quoteUrl,
      );
      if (quote.industryName) {
        saveIndustryMembershipInTransaction({
          code: quote.code,
          industryName: quote.industryName,
          effectiveFrom: snapshot.tradeDate,
          source: "eastmoney",
          sourceField: "f100",
          confidence: 1,
        });
      }
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

const MAX_RECENT_HISTORY_DAYS = 366;
function assertRecentHistoryDays(days: number): void {
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_RECENT_HISTORY_DAYS) throw new Error(`days 必须是 1 到 ${MAX_RECENT_HISTORY_DAYS} 的安全整数`);
}

/**
 * 批量读取一批股票最近若干交易日的成交额（升序，用于 5 天成交额柱状图）。
 * 当日全市场快照优先于日线缓存，缺失的历史交易日再由已联网补齐的日线填充。
 */
export function getRecentAmounts(codes: string[], days = 5, endDate?: string): Map<string, Array<{ tradeDate: string; amount: number }>> {
  assertRecentHistoryDays(days);
  const result = new Map<string, Array<{ tradeDate: string; amount: number }>>();
  const uniqueCodes = [...new Set(codes.filter((code) => /^\d{6}$/.test(code)))];
  if (!uniqueCodes.length) return result;
  const statement = database.prepare(`
    WITH amount_rows AS (
      SELECT trade_date, amount, 1 AS source_priority
      FROM market_daily_quotes
      WHERE code = ?${endDate ? " AND trade_date <= ?" : ""}
      UNION ALL
      SELECT trade_date, amount, 0 AS source_priority
      FROM market_daily_bars
      WHERE code = ? AND adjustment = 'none'${endDate ? " AND trade_date <= ?" : ""}
    ), preferred_rows AS (
      SELECT trade_date, amount,
        ROW_NUMBER() OVER (PARTITION BY trade_date ORDER BY source_priority DESC) AS row_number
      FROM amount_rows
    )
    SELECT trade_date, amount FROM preferred_rows
    WHERE row_number = 1 AND amount IS NOT NULL
    ORDER BY trade_date DESC LIMIT ?
  `);
  for (const code of uniqueCodes) {
    const params = endDate ? [code, endDate, code, endDate, days] : [code, code, days];
    const rows = statement.all(...params) as Array<{ trade_date: string; amount: number | null }>;
    const list = rows.flatMap((row) => row.amount === null || !Number.isFinite(row.amount) ? [] : [{ tradeDate: String(row.trade_date), amount: row.amount }]).reverse();
    if (list.length) result.set(code, list);
  }
  return result;
}

/**
 * 批量读取最近若干交易日的日涨跌幅（升序）。
 * 当日全市场快照优先，缺失交易日由联网缓存的未复权日线补齐；不生成任何未来价格。
 */
export function getRecentPctChanges(codes: string[], days = 22, endDate?: string): Map<string, Array<{ tradeDate: string; pctChange: number }>> {
  assertRecentHistoryDays(days);
  const result = new Map<string, Array<{ tradeDate: string; pctChange: number }>>();
  const uniqueCodes = [...new Set(codes.filter((code) => /^\d{6}$/.test(code)))];
  if (!uniqueCodes.length) return result;
  const statement = database.prepare(`
    WITH return_rows AS (
      SELECT trade_date, pct_change, 1 AS source_priority
      FROM market_daily_quotes
      WHERE code = ?${endDate ? " AND trade_date <= ?" : ""}
      UNION ALL
      SELECT trade_date, pct_change, 0 AS source_priority
      FROM market_daily_bars
      WHERE code = ? AND adjustment = 'none'${endDate ? " AND trade_date <= ?" : ""}
    ), preferred_rows AS (
      SELECT trade_date, pct_change,
        ROW_NUMBER() OVER (PARTITION BY trade_date ORDER BY source_priority DESC) AS row_number
      FROM return_rows
    )
    SELECT trade_date, pct_change FROM preferred_rows
    WHERE row_number = 1 AND pct_change IS NOT NULL
    ORDER BY trade_date DESC LIMIT ?
  `);
  for (const code of uniqueCodes) {
    const params = endDate ? [code, endDate, code, endDate, days] : [code, code, days];
    const rows = statement.all(...params) as Array<{ trade_date: string; pct_change: number | null }>;
    const list = rows.flatMap((row) => row.pct_change === null || !Number.isFinite(row.pct_change) ? [] : [{ tradeDate: String(row.trade_date), pctChange: Number(row.pct_change) }]).reverse();
    if (list.length) result.set(code, list);
  }
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

export type LeadershipVerificationState = "verified" | "unverified" | "empty";

export interface LeadershipSyncStateRow {
  tradeDate: string;
  fetchedAt: string;
  poolCount: number;
  billboardCount: number;
  verification: LeadershipVerificationState;
  note: string | null;
}

/** 逐日龙头事实的读表映射；空值统一走通用 `nullableNumber` / `nullableString`。 */
function limitUpFromRow(row: Record<string, unknown>): LimitUpRecord {
  return {
    code: String(row.code),
    name: String(row.name),
    exchange: String(row.exchange) as LimitUpRecord["exchange"],
    tradeDate: String(row.trade_date),
    close: nullableNumber(row.close),
    pctChange: nullableNumber(row.pct_change),
    amount: nullableNumber(row.amount),
    turnover: nullableNumber(row.turnover),
    floatMarketCap: nullableNumber(row.float_market_cap),
    boardCount: Number(row.board_count),
    statDays: nullableNumber(row.stat_days),
    statCount: nullableNumber(row.stat_count),
    firstSealTime: nullableString(row.first_seal_time),
    lastSealTime: nullableString(row.last_seal_time),
    breakCount: Number(row.break_count),
    sealAmount: nullableNumber(row.seal_amount),
    industryName: nullableString(row.industry_name),
    sourceUrl: String(row.source_url),
  };
}

function dragonTigerFromRow(row: Record<string, unknown>): DragonTigerRecord {
  return {
    code: String(row.code),
    name: String(row.name),
    tradeDate: String(row.trade_date),
    close: nullableNumber(row.close),
    pctChange: nullableNumber(row.pct_change),
    netAmount: nullableNumber(row.net_amount),
    buyAmount: nullableNumber(row.buy_amount),
    sellAmount: nullableNumber(row.sell_amount),
    dealAmount: nullableNumber(row.deal_amount),
    turnover: nullableNumber(row.turnover),
    reasons: parseStringArray(row.reasons_json),
    explanations: parseStringArray(row.explanations_json),
    listCount: Number(row.list_count),
    sourceUrl: String(row.source_url),
  };
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 原子替换某个交易日的涨停池与龙虎榜，并记录取证状态。
 * 只有通过本地行情核对的批次才会以 verified 写入；无法证明日期的批次保留状态但不覆盖数据。
 */
export function saveDailyLeadership(input: {
  tradeDate: string;
  limitUp: LimitUpRecord[];
  dragonTiger: DragonTigerRecord[];
  verification: LeadershipVerificationState;
  note: string | null;
  fetchedAt?: string;
}): void {
  const fetchedAt = input.fetchedAt ?? new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    if (input.verification === "verified") {
      database.prepare("DELETE FROM daily_limit_up_pool WHERE trade_date = ?").run(input.tradeDate);
      database.prepare("DELETE FROM daily_dragon_tiger WHERE trade_date = ?").run(input.tradeDate);
      const insertLimitUp = database.prepare(`
        INSERT INTO daily_limit_up_pool(
          code, trade_date, name, exchange, close, pct_change, amount, turnover, float_market_cap,
          board_count, stat_days, stat_count, first_seal_time, last_seal_time, break_count, seal_amount,
          industry_name, source_url, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of input.limitUp) {
        insertLimitUp.run(row.code, input.tradeDate, row.name, row.exchange, row.close, row.pctChange, row.amount, row.turnover, row.floatMarketCap, row.boardCount, row.statDays, row.statCount, row.firstSealTime, row.lastSealTime, row.breakCount, row.sealAmount, row.industryName, row.sourceUrl, fetchedAt);
      }
      const insertDragonTiger = database.prepare(`
        INSERT INTO daily_dragon_tiger(
          code, trade_date, name, close, pct_change, net_amount, buy_amount, sell_amount, deal_amount,
          turnover, reasons_json, explanations_json, list_count, source_url, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of input.dragonTiger) {
        insertDragonTiger.run(row.code, input.tradeDate, row.name, row.close, row.pctChange, row.netAmount, row.buyAmount, row.sellAmount, row.dealAmount, row.turnover, JSON.stringify(row.reasons), JSON.stringify(row.explanations), row.listCount, row.sourceUrl, fetchedAt);
      }
    }
    database.prepare(`
      INSERT INTO leadership_sync_state(trade_date, fetched_at, pool_count, billboard_count, verification, note)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(trade_date) DO UPDATE SET
        fetched_at = excluded.fetched_at,
        pool_count = excluded.pool_count,
        billboard_count = excluded.billboard_count,
        verification = excluded.verification,
        note = excluded.note
    `).run(input.tradeDate, fetchedAt, input.limitUp.length, input.dragonTiger.length, input.verification, input.note);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** 读取若干交易日的取证状态（含失败记录），用于跳过重复抓取与展示数据源状态。 */
export function getLeadershipSyncState(tradeDates: string[]): LeadershipSyncStateRow[] {
  if (!tradeDates.length) return [];
  const placeholders = tradeDates.map(() => "?").join(", ");
  return (database.prepare(`
    SELECT * FROM leadership_sync_state WHERE trade_date IN (${placeholders})
  `).all(...tradeDates) as Array<Record<string, unknown>>).map((row) => ({
    tradeDate: String(row.trade_date),
    fetchedAt: String(row.fetched_at),
    poolCount: Number(row.pool_count),
    billboardCount: Number(row.billboard_count),
    verification: String(row.verification) as LeadershipVerificationState,
    note: nullableString(row.note),
  }));
}

export function getLimitUpPoolByTradeDate(tradeDate: string): LimitUpRecord[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error("交易日必须是 YYYY-MM-DD");
  return (database.prepare(`
    SELECT * FROM daily_limit_up_pool WHERE trade_date = ? ORDER BY board_count DESC, code
  `).all(tradeDate) as Array<Record<string, unknown>>).map(limitUpFromRow);
}

export function getDragonTigerByTradeDate(tradeDate: string): DragonTigerRecord[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error("交易日必须是 YYYY-MM-DD");
  return (database.prepare(`
    SELECT * FROM daily_dragon_tiger WHERE trade_date = ? ORDER BY code
  `).all(tradeDate) as Array<Record<string, unknown>>).map(dragonTigerFromRow);
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

export interface IndustryDailySnapshotInput {
  industryCode: string;
  industryName: string;
  tradeDate: string;
  observedAt: string;
  clueAsOf?: string | null;
  textHeat: number;
  textDirection: number;
  textConfidence: number;
  marketStrength: number;
  industryReturn: number;
  marketReturn: number;
  marketExcess: number;
  breadth: number;
  amountShare: number;
  relation: string;
  stage: string;
  driver: string;
  informationCategories: string[];
  independentEvents: number;
  mentionCount: number;
  discussionCount: number;
  sourceCount: number;
  stockCoverage: number;
  eligibleStockCount: number;
  memberCodes: string[];
  methodologyVersion?: string;
}

export interface IndustryForwardOutcomeRecord {
  industryCode: string;
  signalTradeDate: string;
  horizon: 1 | 3 | 5 | 10;
  status: "observing" | "completed" | "unavailable";
  availableDays: number;
  startTradeDate: string | null;
  endTradeDate: string | null;
  industryReturn: number | null;
  marketReturn: number | null;
  excessReturn: number | null;
  observedThrough: string | null;
  completedAt: string | null;
  reason: string | null;
  savedAt: string;
}

export interface IndustryHistoricalRelationship {
  status: "尚无行业快照" | "尚无热点快照" | "等待T+1结果" | "观察中" | "探索性" | "正向关联" | "负向关联" | "未见稳定关系";
  horizon: 1 | 3 | 5 | 10;
  sampleCount: number;
  incrementalExcess: number | null;
  interval: { low: number; high: number } | null;
  note: string;
  observingCount: number;
  latestSignalTradeDate: string | null;
}

const upsertIndustryDailySnapshot = database.prepare(`
  INSERT INTO industry_daily_snapshots(
    industry_code, trade_date, observed_at, clue_as_of, text_heat, text_direction,
    text_confidence, market_strength, industry_return, market_return, market_excess,
    breadth, amount_share, relation, stage, driver, information_categories_json,
    independent_events, mention_count, discussion_count, source_count, stock_coverage,
    eligible_stock_count, methodology_version, saved_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(industry_code, trade_date) DO UPDATE SET
    observed_at=excluded.observed_at,
    clue_as_of=excluded.clue_as_of,
    text_heat=excluded.text_heat,
    text_direction=excluded.text_direction,
    text_confidence=excluded.text_confidence,
    market_strength=excluded.market_strength,
    industry_return=excluded.industry_return,
    market_return=excluded.market_return,
    market_excess=excluded.market_excess,
    breadth=excluded.breadth,
    amount_share=excluded.amount_share,
    relation=excluded.relation,
    stage=excluded.stage,
    driver=excluded.driver,
    information_categories_json=excluded.information_categories_json,
    independent_events=excluded.independent_events,
    mention_count=excluded.mention_count,
    discussion_count=excluded.discussion_count,
    source_count=excluded.source_count,
    stock_coverage=excluded.stock_coverage,
    eligible_stock_count=excluded.eligible_stock_count,
    methodology_version=excluded.methodology_version,
    saved_at=excluded.saved_at
`);

const insertIndustrySnapshotMember = database.prepare(`
  INSERT OR IGNORE INTO industry_daily_snapshot_members(industry_code, trade_date, code)
  VALUES (?, ?, ?)
`);

const seedIndustryForwardOutcome = database.prepare(`
  INSERT OR IGNORE INTO industry_forward_outcomes(
    industry_code, signal_trade_date, horizon, status, available_days, saved_at
  ) VALUES (?, ?, ?, 'observing', 0, ?)
`);

/** 保存行业当日冻结结果，并为四个观察周期建立待结算记录。 */
export function saveIndustryDailySnapshots(rows: IndustryDailySnapshotInput[]): number {
  const valid = rows.filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.tradeDate) && row.industryCode && row.memberCodes.length > 0);
  if (!valid.length) return 0;
  const savedAt = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const row of valid) {
      const name = normalizeIndustryName(row.industryName);
      if (!name) continue;
      // 行业名称是东方财富 f100 的稳定业务键；调用方若使用内置临时代码，
      // 在持久化时统一归一到名称哈希，避免同名行业触发 UNIQUE 冲突。
      const industryCode = industryCodeForName(name);
      upsertIndustry.run(industryCode, name, row.methodologyVersion ?? null, savedAt, savedAt);
      upsertIndustryDailySnapshot.run(
        industryCode, row.tradeDate, row.observedAt, row.clueAsOf ?? null,
        row.textHeat, row.textDirection, row.textConfidence, row.marketStrength,
        row.industryReturn, row.marketReturn, row.marketExcess, row.breadth, row.amountShare,
        row.relation, row.stage, row.driver, JSON.stringify(row.informationCategories),
        row.independentEvents, row.mentionCount, row.discussionCount, row.sourceCount,
        row.stockCoverage, row.eligibleStockCount, row.methodologyVersion ?? "行业分析规则 v1", savedAt,
      );
      database.prepare("DELETE FROM industry_daily_snapshot_members WHERE industry_code = ? AND trade_date = ?").run(industryCode, row.tradeDate);
      for (const code of new Set(row.memberCodes.filter((code) => /^\d{6}$/.test(code)))) insertIndustrySnapshotMember.run(industryCode, row.tradeDate, code);
      for (const horizon of [1, 3, 5, 10] as const) seedIndustryForwardOutcome.run(industryCode, row.tradeDate, horizon, savedAt);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return valid.length;
}

/** 读取某行业最近一次每日快照是否存在。 */
export function getLatestIndustrySnapshot(industryCode: string, hotOnly = false) {
  const row = database.prepare(`
    SELECT industry_code, trade_date, observed_at, clue_as_of
    FROM industry_daily_snapshots
    WHERE industry_code = ? AND (? = 0 OR relation IN ('舆情交易双热', '舆情升温、价格未确认'))
    ORDER BY trade_date DESC LIMIT 1
  `).get(industryCode, hotOnly ? 1 : 0) as Record<string, unknown> | undefined;
  return row ? { industryCode: String(row.industry_code), tradeDate: String(row.trade_date), observedAt: String(row.observed_at), clueAsOf: nullableString(row.clue_as_of) } : null;
}

export function getIndustryForwardOutcomes(industryCode: string, horizon?: 1 | 3 | 5 | 10, hotOnly = false): IndustryForwardOutcomeRecord[] {
  const rows = database.prepare(`
    SELECT o.* FROM industry_forward_outcomes o
    JOIN industry_daily_snapshots s
      ON s.industry_code = o.industry_code AND s.trade_date = o.signal_trade_date
    WHERE o.industry_code = ? AND (? IS NULL OR o.horizon = ?)
      AND (? = 0 OR s.relation IN ('舆情交易双热', '舆情升温、价格未确认'))
    ORDER BY o.signal_trade_date DESC, o.horizon
  `).all(industryCode, horizon ?? null, horizon ?? null, hotOnly ? 1 : 0) as Array<Record<string, unknown>>;
  return rows.map(industryForwardOutcomeFromRow);
}

/**
 * 结算已到期的行业T+N观察。行情只使用信号日留档的成员集合，避免行业换分类后污染历史。
 * 只有四个预设周期的完整交易日与足够成员覆盖到齐才标记 completed。
 */
export function settleIndustryForwardOutcomes(asOfTradeDate?: string): number {
  const asOf = asOfTradeDate ?? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
  const rows = database.prepare(`
    SELECT * FROM industry_forward_outcomes
    WHERE status <> 'completed' AND signal_trade_date < ?
    ORDER BY signal_trade_date, industry_code, horizon
  `).all(asOf) as Array<Record<string, unknown>>;
  if (!rows.length) return 0;
  const update = database.prepare(`
    UPDATE industry_forward_outcomes SET
      status=?, available_days=?, start_trade_date=?, end_trade_date=?,
      industry_return=?, market_return=?, excess_return=?, observed_through=?,
      completed_at=?, reason=?, saved_at=?
    WHERE industry_code=? AND signal_trade_date=? AND horizon=?
  `);
  let completed = 0;
  const savedAt = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const industryCode = String(row.industry_code);
      const signalDate = String(row.signal_trade_date);
      const horizon = Number(row.horizon) as 1 | 3 | 5 | 10;
      const dates = (database.prepare(`
        SELECT DISTINCT trade_date FROM market_daily_quotes
        WHERE trade_date > ? AND trade_date <= ?
        ORDER BY trade_date ASC LIMIT ?
      `).all(signalDate, asOf, horizon) as Array<{ trade_date: string }>).map((item) => String(item.trade_date));
      if (!dates.length) {
        update.run("observing", 0, null, null, null, null, null, null, null, "等待后续交易日行情", savedAt, industryCode, signalDate, horizon);
        continue;
      }
      const members = (database.prepare(`
        SELECT code FROM industry_daily_snapshot_members WHERE industry_code=? AND trade_date=?
      `).all(industryCode, signalDate) as Array<{ code: string }>).map((item) => item.code);
      const marketReturns = dates.map((date) => averagePctForDate(date, null));
      const memberReturns = members.map((code) => compoundReturn(code, dates)).filter((value): value is number => value !== null);
      const enoughDates = dates.length >= horizon;
      const enoughMembers = memberReturns.length >= Math.max(1, Math.ceil(members.length * 0.5));
      const industryReturn = memberReturns.length ? average(memberReturns) : null;
      const marketReturn = marketReturns.every((value): value is number => value !== null) ? compoundSeries((marketReturns as number[]).map((value) => value / 100)) : null;
      const excess = industryReturn !== null && marketReturn !== null ? industryReturn - marketReturn : null;
      const status = enoughDates && enoughMembers && excess !== null ? "completed" : dates.length > 0 && members.length > 0 ? "observing" : "unavailable";
      if (status === "completed") completed += 1;
      update.run(
        status,
        dates.length,
        dates[0] ?? null,
        dates.at(-1) ?? null,
        industryReturn,
        marketReturn,
        excess,
        dates.at(-1) ?? null,
        status === "completed" ? savedAt : null,
        status === "completed" ? null : enoughDates ? "行业成员或市场行情覆盖不足" : `已获得${dates.length}/${horizon}个交易日`,
        savedAt,
        industryCode,
        signalDate,
        horizon,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return completed;
}

export function getIndustryHistoricalRelationship(industryCode: string, horizon: 1 | 3 | 5 | 10 = 5): IndustryHistoricalRelationship {
  // 这里只统计“热点行业信号日”，否则普通行业日会污染“热点是否贡献后续涨幅”的结论。
  const outcomes = getIndustryForwardOutcomes(industryCode, horizon, true);
  const completed = outcomes.filter((item) => item.status === "completed" && item.excessReturn !== null);
  const observing = outcomes.filter((item) => item.status === "observing");
  const latestSnapshot = getLatestIndustrySnapshot(industryCode, true);
  if (!latestSnapshot) {
    const anySnapshot = getLatestIndustrySnapshot(industryCode);
    return anySnapshot
      ? { status: "尚无热点快照", horizon, sampleCount: 0, incrementalExcess: null, interval: null, note: "该行业已有日快照，但尚未达到热点行业信号门槛。", observingCount: 0, latestSignalTradeDate: anySnapshot.tradeDate }
      : { status: "尚无行业快照", horizon, sampleCount: 0, incrementalExcess: null, interval: null, note: "当前没有已冻结的行业日快照。", observingCount: 0, latestSignalTradeDate: null };
  }
  if (!completed.length) {
    const status = observing.some((item) => item.availableDays > 0) ? "观察中" : "等待T+1结果";
    return { status, horizon, sampleCount: 0, incrementalExcess: null, interval: null, note: status === "观察中" ? `已有${observing[0]?.availableDays ?? 0}/${horizon}个交易日，等待观察周期完成。` : "行业快照已冻结，等待后续交易日行情结算。", observingCount: observing.length, latestSignalTradeDate: latestSnapshot.tradeDate };
  }
  const values = completed.map((item) => item.excessReturn as number).sort((a, b) => a - b);
  const median = quantile(values, 0.5);
  const positiveRate = values.filter((value) => value > 0).length / values.length;
  const stable = values.length >= 30;
  const status = !stable ? "探索性" : median > 0 && positiveRate >= 0.55 ? "正向关联" : median < 0 && positiveRate <= 0.45 ? "负向关联" : "未见稳定关系";
  return {
    status,
    horizon,
    sampleCount: values.length,
    incrementalExcess: round(median),
    interval: stable ? { low: round(quantile(values, 0.1)), high: round(quantile(values, 0.9)) } : null,
    note: stable ? `已完成${values.length}个行业日后验样本；区间为经验分位区间，不代表未来预测。` : `已完成${values.length}个行业日后验样本，尚未达到稳定样本门槛。`,
    observingCount: observing.length,
    latestSignalTradeDate: latestSnapshot.tradeDate,
  };
}

function averagePctForDate(date: string, codes: string[] | null): number | null {
  const rows = codes?.length
    ? database.prepare(`SELECT pct_change FROM market_daily_quotes WHERE trade_date=? AND code IN (${codes.map(() => "?").join(",")}) AND pct_change IS NOT NULL`).all(date, ...codes) as Array<{ pct_change: number | null }>
    : database.prepare("SELECT pct_change FROM market_daily_quotes WHERE trade_date=? AND pct_change IS NOT NULL").all(date) as Array<{ pct_change: number | null }>;
  const values = rows.map((row) => Number(row.pct_change)).filter(Number.isFinite);
  return values.length ? average(values) : null;
}

function compoundReturn(code: string, dates: string[]): number | null {
  const rows = database.prepare(`
    SELECT trade_date, pct_change FROM market_daily_quotes
    WHERE code=? AND trade_date IN (${dates.map(() => "?").join(",")}) AND pct_change IS NOT NULL
  `).all(code, ...dates) as Array<{ trade_date: string; pct_change: number | null }>;
  if (rows.length < dates.length) return null;
  return compoundSeries(dates.map((date) => Number(rows.find((row) => row.trade_date === date)?.pct_change ?? NaN) / 100));
}

function compoundSeries(values: number[]) {
  return (values.reduce((product, value) => product * (1 + value), 1) - 1) * 100;
}

function industryForwardOutcomeFromRow(row: Record<string, unknown>): IndustryForwardOutcomeRecord {
  return {
    industryCode: String(row.industry_code),
    signalTradeDate: String(row.signal_trade_date),
    horizon: Number(row.horizon) as IndustryForwardOutcomeRecord["horizon"],
    status: String(row.status) as IndustryForwardOutcomeRecord["status"],
    availableDays: Number(row.available_days),
    startTradeDate: nullableString(row.start_trade_date),
    endTradeDate: nullableString(row.end_trade_date),
    industryReturn: nullableNumber(row.industry_return),
    marketReturn: nullableNumber(row.market_return),
    excessReturn: nullableNumber(row.excess_return),
    observedThrough: nullableString(row.observed_through),
    completedAt: nullableString(row.completed_at),
    reason: nullableString(row.reason),
    savedAt: String(row.saved_at),
  };
}

function quantile(values: number[], probability: number) {
  if (!values.length) return 0;
  const position = (values.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (position - lower);
}

/**
 * 保存一批有日期效力的股票—行业归属。行业字段缺失的行情不会写入空归属，
 * 因而不会覆盖该股票已有的有效行业记录。
 */
export function saveIndustryMemberships(inputs: IndustryMembershipInput[]): number {
  const valid = inputs.filter((input) => normalizeIndustryName(input.industryName));
  if (!valid.length) return 0;
  let saved = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const input of valid) if (saveIndustryMembershipInTransaction(input)) saved += 1;
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return saved;
}

function saveIndustryMembershipInTransaction(input: IndustryMembershipInput): string | null {
  const name = normalizeIndustryName(input.industryName);
  if (!name || !/^\d{6}$/.test(input.code) || !/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) return null;
  const industryCode = industryCodeForName(name);
  const now = new Date().toISOString();
  const confidence = Math.max(0, Math.min(1, Number.isFinite(input.confidence ?? 1) ? input.confidence ?? 1 : 1));
  upsertIndustry.run(industryCode, name, input.taxonomyVersion ?? null, now, now);
  // 同一股票的新行业归属从 effectiveFrom 生效：关闭旧 active 记录，避免两个行业同时有效。
  // 同日不同分类视为修正，直接删除旧的同日记录，避免生成 effective_to < effective_from。
  deleteSameDayIndustryMemberships.run(input.code, industryCode, input.effectiveFrom);
  closeSameCodeIndustryMemberships.run(previousDate(input.effectiveFrom), input.code, industryCode, input.effectiveFrom, input.effectiveFrom);
  upsertStockIndustryMembership.run(
    input.code,
    industryCode,
    input.effectiveFrom,
    input.source ?? "eastmoney",
    input.sourceField ?? "f100",
    confidence,
  );
  return industryCode;
}

function previousDate(date: string) {
  const parsed = new Date(`${date}T00:00:00+08:00`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(parsed);
}

/** 查询指定日期对股票有效的主行业归属。 */
export function getStockIndustry(code: string, asOf?: string): StockIndustryMembership | null {
  const normalized = validateCode(code);
  const date = asOf ?? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("行业归属日期必须是 YYYY-MM-DD");
  const row = database.prepare(`
    SELECT m.*, i.name AS industry_name
    FROM stock_industry_membership m
    JOIN industries i ON i.industry_code = m.industry_code
    WHERE m.code = ?
      AND m.effective_from <= ?
      AND (m.effective_to IS NULL OR m.effective_to >= ?)
    ORDER BY m.effective_from DESC, m.industry_code
    LIMIT 1
  `).get(normalized, date, date) as Record<string, unknown> | undefined;
  return row ? stockIndustryFromRow(row) : null;
}

/** 批量读取股票行业，避免异动候选页逐只查询数据库。 */
export function getStockIndustries(codes: string[], asOf?: string): Map<string, StockIndustryMembership> {
  const result = new Map<string, StockIndustryMembership>();
  const unique = [...new Set(codes.map((code) => code.trim()).filter((code) => /^\d{6}$/.test(code)))];
  if (!unique.length) return result;
  const date = asOf ?? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("行业归属日期必须是 YYYY-MM-DD");
  const placeholders = unique.map(() => "?").join(",");
  const rows = database.prepare(`
    SELECT m.*, i.name AS industry_name
    FROM stock_industry_membership m
    JOIN industries i ON i.industry_code = m.industry_code
    WHERE m.code IN (${placeholders})
      AND m.effective_from <= ?
      AND (m.effective_to IS NULL OR m.effective_to >= ?)
    ORDER BY m.code, m.effective_from DESC, m.industry_code
  `).all(...unique, date, date) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const item = stockIndustryFromRow(row);
    if (!result.has(item.code)) result.set(item.code, item);
  }
  return result;
}

export function getIndustryByCode(code: string): IndustryRecord | null {
  const row = database.prepare("SELECT * FROM industries WHERE industry_code = ?").get(code) as Record<string, unknown> | undefined;
  return row ? industryFromRow(row) : null;
}

export function listIndustries(options: { limit?: number; query?: string } = {}): IndustryRecord[] {
  const limit = Math.min(500, Math.max(1, Math.trunc(options.limit ?? 100)));
  const query = options.query?.trim() ?? "";
  const rows = database.prepare(`
    SELECT * FROM industries
    WHERE (? = '' OR name LIKE ?)
    ORDER BY last_seen_at DESC, name ASC LIMIT ?
  `).all(query, `%${query}%`, limit) as Array<Record<string, unknown>>;
  return rows.map(industryFromRow);
}

/** 保存线索—行业关系；行业可用 code 或名称指定，关系可重复更新。 */
export function saveClueIndustryLinks(inputs: ClueIndustryLinkInput[]): number {
  if (!inputs.length) return 0;
  const savedAt = new Date().toISOString();
  let saved = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const input of inputs) {
      const clueExists = database.prepare("SELECT 1 AS present FROM clues WHERE id = ? LIMIT 1").get(input.clueId);
      if (!clueExists) continue;
      const industryCode = resolveIndustryCodeInTransaction(input.industryCode, input.industryName, savedAt);
      if (!industryCode) continue;
      const relevance = Math.max(0, Math.min(100, Number(input.relevance)));
      const direction = input.influenceDirection === -1 || input.influenceDirection === 1 ? input.influenceDirection : 0;
      upsertClueIndustryLink.run(
        input.clueId,
        industryCode,
        Number.isFinite(relevance) ? relevance : 0,
        direction,
        input.chainPosition ?? null,
        input.evidence ?? null,
        savedAt,
      );
      saved += 1;
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return saved;
}

function resolveIndustryCodeInTransaction(code: string | undefined, name: string | undefined, now: string): string | null {
  if (code && getIndustryByCode(code)) return code;
  const normalizedName = normalizeIndustryName(name);
  if (!normalizedName) return null;
  const industryCode = industryCodeForName(normalizedName);
  upsertIndustry.run(industryCode, normalizedName, null, now, now);
  return industryCode;
}

export function getClueIndustryLinks(clueId: string): ClueIndustryLink[] {
  const rows = database.prepare(`
    SELECT l.*, i.name AS industry_name
    FROM clue_industry_links l
    JOIN industries i ON i.industry_code = l.industry_code
    WHERE l.clue_id = ? ORDER BY l.relevance DESC, l.created_at DESC
  `).all(clueId) as Array<Record<string, unknown>>;
  return rows.map(clueIndustryLinkFromRow);
}

export function getIndustryClueLinks(industryCode: string, options: { limit?: number; since?: string } = {}): ClueIndustryLink[] {
  const limit = Math.min(1_000, Math.max(1, Math.trunc(options.limit ?? 100)));
  const since = options.since ?? "";
  const rows = database.prepare(`
    SELECT l.*, i.name AS industry_name
    FROM clue_industry_links l
    JOIN industries i ON i.industry_code = l.industry_code
    WHERE l.industry_code = ? AND (? = '' OR l.created_at >= ?)
    ORDER BY l.created_at DESC, l.relevance DESC LIMIT ?
  `).all(industryCode, since, since, limit) as Array<Record<string, unknown>>;
  return rows.map(clueIndustryLinkFromRow);
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
  const code = String(row.code);
  const tradeDate = String(row.trade_date);
  const directIndustry = normalizeIndustryName(row.industry_name);
  return {
    code,
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
    listingDate: nullableString(row.listing_date),
    industryName: directIndustry ?? fallbackIndustryName(code, tradeDate),
    limitPercent: resolveBoardLimitMetadata(code, tradeDate)?.limitPercent ?? null,
    quoteAt: String(row.quote_at),
    tradeDate,
    quoteUrl: String(row.quote_url),
    provider: "eastmoney",
    sourceTier: String(row.source_tier) as EastMoneyEndpointTier,
  };
}

function nullableBoardLimitPercent(value: unknown): 5 | 10 | 20 | null {
  const numeric = nullableNumber(value);
  return numeric === 5 || numeric === 10 || numeric === 20 ? numeric : null;
}

/** f26 不是每天都会返回；按股票回填任一已保存的上市日期，允许后补录更早交易日。 */
function latestKnownListingDate(code: string): string | null {
  const row = database.prepare(`
    SELECT listing_date FROM market_daily_quotes
    WHERE code = ? AND listing_date IS NOT NULL
    ORDER BY trade_date DESC LIMIT 1
  `).get(code) as { listing_date?: unknown } | undefined;
  return nullableString(row?.listing_date);
}

/** 行情批次的 f100 缺失时，读取该交易日有效的成员关系，避免空字段覆盖历史分类。 */
function fallbackIndustryName(code: string, tradeDate: string): string | null {
  if (!/^\d{6}$/.test(code) || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) return null;
  const row = database.prepare(`
    SELECT i.name
    FROM stock_industry_membership m
    JOIN industries i ON i.industry_code = m.industry_code
    WHERE m.code = ?
      AND m.effective_from <= ?
      AND (m.effective_to IS NULL OR m.effective_to >= ?)
    ORDER BY m.effective_from DESC, m.industry_code
    LIMIT 1
  `).get(code, tradeDate, tradeDate) as { name?: unknown } | undefined;
  return normalizeIndustryName(row?.name);
}

function industryFromRow(row: Record<string, unknown>): IndustryRecord {
  return {
    code: String(row.industry_code),
    name: String(row.name),
    level: Number(row.level),
    parentCode: nullableString(row.parent_code),
    taxonomy: String(row.taxonomy),
    taxonomyVersion: nullableString(row.taxonomy_version),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
  };
}

function stockIndustryFromRow(row: Record<string, unknown>): StockIndustryMembership {
  return {
    code: String(row.code),
    industryCode: String(row.industry_code),
    industryName: String(row.industry_name ?? row.name ?? ""),
    effectiveFrom: String(row.effective_from),
    effectiveTo: nullableString(row.effective_to),
    source: String(row.source),
    sourceField: nullableString(row.source_field),
    confidence: Number(row.confidence),
  };
}

function clueIndustryLinkFromRow(row: Record<string, unknown>): ClueIndustryLink {
  return {
    clueId: String(row.clue_id),
    industryCode: String(row.industry_code),
    industryName: String(row.industry_name ?? ""),
    relevance: Number(row.relevance),
    influenceDirection: Number(row.influence_direction) as ClueIndustryLink["influenceDirection"],
    chainPosition: nullableString(row.chain_position),
    evidence: nullableString(row.evidence),
    createdAt: String(row.created_at),
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

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value: number) {
  return Number(value.toFixed(4));
}
