import {
  getDragonTigerByTradeDate,
  getLeadershipSyncState,
  getLimitUpPoolByTradeDate,
  getMarketQuotesByTradeDate,
  saveDailyLeadership,
  type LeadershipSyncStateRow,
  type LeadershipVerificationState,
} from "./database.ts";
import {
  fetchDragonTiger,
  fetchLimitUpPool,
  mergeLeadershipDay,
  verifyLimitUpAgainstQuotes,
  type LeadershipDayRow,
  type LeadershipVerification,
  type LimitUpRecord,
  type QuoteForVerification,
} from "./leadership.ts";

/** 北京时间 15:05 对应 UTC 07:05，收盘后 5 分钟视为定稿。 */
const FINAL_AFTER_UTC_MINUTES = 7 * 60 + 5;
/** 盘中限频：同一交易日最多 5 分钟抓一次。 */
const MIN_REFRESH_MS = 5 * 60_000;
/** 历史回填最多一次覆盖 8 个交易日，两次回填之间至少间隔 30 分钟。 */
const HISTORY_LIMIT = 8;
const HISTORY_COOLDOWN_MS = 30 * 60_000;

export interface LeadershipSyncResult {
  tradeDate: string;
  skipped: boolean;
  verification: LeadershipVerificationState;
  poolCount: number;
  billboardCount: number;
  note: string | null;
}

const finalCutoff = (tradeDate: string) => Date.parse(`${tradeDate}T${String(Math.floor(FINAL_AFTER_UTC_MINUTES / 60)).padStart(2, "0")}:${String(FINAL_AFTER_UTC_MINUTES % 60).padStart(2, "0")}:00.000Z`);

/** 北京时间当天日期；盘中时点差核对只对「当天」开放。 */
function shanghaiDate(now: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function shouldSkip(state: LeadershipSyncStateRow | undefined, tradeDate: string, force: boolean, now: number): boolean {
  if (!state || force) return false;
  const fetchedAt = Date.parse(state.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return false;
  const finalized = fetchedAt >= finalCutoff(tradeDate);
  // 定稿后的 verified/empty 不会再变；未定稿或抓取失败按 5 分钟限频重试。
  if ((state.verification === "verified" || state.verification === "empty") && finalized) return true;
  return now - fetchedAt < MIN_REFRESH_MS;
}

/**
 * 核对一批涨停池是否可信。
 *
 * - 本地行情是收盘批次 → 收盘模式，价格与涨跌幅必须全部对上；
 * - 本地行情不是收盘批次且请求日期就是当天 → 盘中模式，只允许「行情快照取在封板之前」这一种时点差；
 * - 本地行情不是收盘批次、请求日期又是历史日期 → 直接拒绝：历史涨停池是最终结果，
 *   用盘中行情核对不能证明它，宁可当天不标龙头也不猜。
 */
export function evaluateLeadershipBatch(
  tradeDate: string,
  limitUp: LimitUpRecord[],
  quotes: QuoteForVerification[],
  now: number,
): LeadershipVerification {
  const finalized = quotes.some((quote) => Boolean(quote.quoteAt && quote.quoteAt >= `${tradeDate}T07:00:00.000Z`));
  if (!finalized && tradeDate !== shanghaiDate(now)) {
    return { verified: false, mode: null, comparable: 0, matched: 0, timing: 0, mismatched: [], reason: `本地 ${tradeDate} 行情不是收盘批次，无法证明最终涨停池` };
  }
  return verifyLimitUpAgainstQuotes(limitUp, quotes, { mode: finalized ? "close" : "intraday", finalized });
}

/**
 * 抓取并落库某个交易日的涨停池与龙虎榜。
 *
 * 涨停池必须通过与本地同日行情的逐条比对才写入：接口无法自证数据日期，
 * 比对不通过时只记录取证状态与原因，不覆盖已有数据，也不让下游把未证明的
 * 记录当成龙头依据。调用方可以把当前行情批次直接传进来（`quotes`），
 * 这样盘中核对用的是与涨停池同一时刻的行情，而不是数据库里更早的批次。
 */
export async function syncDailyLeadership(
  tradeDate: string,
  options: { force?: boolean; now?: number; fetchImpl?: typeof fetch; quotes?: QuoteForVerification[] } = {},
): Promise<LeadershipSyncResult> {
  const now = options.now ?? Date.now();
  const [state] = getLeadershipSyncState([tradeDate]);
  if (shouldSkip(state, tradeDate, options.force ?? false, now)) {
    return { tradeDate, skipped: true, verification: state!.verification, poolCount: state!.poolCount, billboardCount: state!.billboardCount, note: state!.note };
  }
  let limitUp: LimitUpRecord[];
  let dragonTiger: Awaited<ReturnType<typeof fetchDragonTiger>>;
  try {
    [limitUp, dragonTiger] = await Promise.all([
      fetchLimitUpPool(tradeDate, { fetchImpl: options.fetchImpl }),
      fetchDragonTiger(tradeDate, { fetchImpl: options.fetchImpl }),
    ]);
  } catch (error) {
    const note = error instanceof Error ? error.message : "龙头数据源抓取失败";
    saveDailyLeadership({ tradeDate, limitUp: [], dragonTiger: [], verification: "unverified", note });
    return { tradeDate, skipped: false, verification: "unverified", poolCount: 0, billboardCount: 0, note };
  }
  const sourceQuotes = options.quotes ?? getMarketQuotesByTradeDate(tradeDate);
  const quotes: QuoteForVerification[] = sourceQuotes.map((quote) => ({ code: quote.code, price: quote.price, pctChange: quote.pctChange, quoteAt: quote.quoteAt }));
  const verification = evaluateLeadershipBatch(tradeDate, limitUp, quotes, now);
  if (!verification.verified) {
    saveDailyLeadership({ tradeDate, limitUp: [], dragonTiger: [], verification: "unverified", note: verification.reason });
    return { tradeDate, skipped: false, verification: "unverified", poolCount: limitUp.length, billboardCount: dragonTiger.length, note: verification.reason };
  }
  const verificationState: LeadershipVerificationState = limitUp.length ? "verified" : "empty";
  const note = limitUp.length
    ? `${verification.mode === "intraday" ? "盘中同批行情核对" : "收盘行情核对"}通过 ${verification.matched}/${verification.comparable} 条${verification.timing ? `（${verification.timing} 条为盘中封板时点差）` : ""}`
    : "当日涨停板池为空";
  saveDailyLeadership({ tradeDate, limitUp, dragonTiger, verification: verificationState, note });
  return { tradeDate, skipped: false, verification: verificationState, poolCount: limitUp.length, billboardCount: dragonTiger.length, note };
}

let historyRun: Promise<void> | null = null;
let lastHistoryAt = 0;

/**
 * 回填历史交易日的龙头数据，供聚焦股票池在窗口内逐日标注龙头。
 * 单个日期失败不影响其余日期；同一时刻只跑一次，且两次回填之间保持冷却。
 */
export function ensureLeadershipHistory(tradeDates: string[], options: { limit?: number; force?: boolean; now?: number } = {}): Promise<void> {
  if (historyRun) return historyRun;
  const now = options.now ?? Date.now();
  if (!options.force && now - lastHistoryAt < HISTORY_COOLDOWN_MS) return Promise.resolve();
  const limit = options.limit ?? HISTORY_LIMIT;
  const targets = [...new Set(tradeDates)].sort().reverse().slice(0, limit);
  historyRun = (async () => {
    for (const tradeDate of targets) {
      try {
        await syncDailyLeadership(tradeDate);
      } catch {
        // 历史回填是尽力而为：失败日期保持无记录，界面按“待确认”展示。
      }
    }
  })().finally(() => {
    historyRun = null;
    lastHistoryAt = Date.now();
  });
  return historyRun;
}

/** 供同步视镜构造 daily-focus 输入：某交易日的龙头事实。 */
export function readLeadershipDayRows(tradeDate: string, industryByCode?: Map<string, string | null>): LeadershipDayRow[] {
  return mergeLeadershipDay(getLimitUpPoolByTradeDate(tradeDate), getDragonTigerByTradeDate(tradeDate), tradeDate, industryByCode);
}

/** 数据源状态：最近若干交易日的龙头数据覆盖情况。 */
export function leadershipCoverage(tradeDates: string[]): Array<LeadershipSyncStateRow & { rows: number }> {
  const states = new Map(getLeadershipSyncState(tradeDates).map((state) => [state.tradeDate, state]));
  return tradeDates.map((tradeDate) => {
    const state = states.get(tradeDate);
    return state
      ? { ...state, rows: getLimitUpPoolByTradeDate(tradeDate).length }
      : { tradeDate, fetchedAt: "", poolCount: 0, billboardCount: 0, verification: "unverified" as const, note: "尚未取证", rows: 0 };
  });
}
