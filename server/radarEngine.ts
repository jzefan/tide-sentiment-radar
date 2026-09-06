import { calculateAlertScore, calculateRadarScore, signalFromFactors } from "../src/domain/scoring.ts";
import type {
  DailySentimentSnapshot,
  DashboardData,
  MoodPoint,
  MoverTag,
  ScoreFactors,
  SentimentEvent,
  StockSnapshot,
  ThemePulse,
} from "../src/domain/types.ts";
import { getClueCount, getStoredClues, saveClues, saveDailySentiment, saveIndustryDailySnapshots, settleIndustryForwardOutcomes, saveClueIndustryLinks, listTradeDates, getDailyDiscussionWindows, saveDailyDiscussionWindows, getRecentAmounts, saveEastMoneyDailyBars } from "./database.ts";
import { diagLog } from "./diagLog.ts";
import { getLiveClues, type LiveClueSourceState, type RawClue } from "./eastMoney.ts";
import { fetchEastMoneyDailyBars, type EastMoneyMarketQuote } from "./eastMoneyMarket.ts";
import { isTradingDate, isTradingSession } from "../src/domain/marketCalendar.ts";
import { readStoredMarketQuotes, syncMarketQuotes, type MarketQuote, type MarketSyncResult } from "./marketSync.ts";
import { classifyText } from "./sentiment.ts";
import type { DiscussionSourceState } from "./userPosts.ts";
import { industryCodeForName, normalizeIndustryName } from "./industry.ts";
import { buildIndustryAnalytics } from "./industryAnalytics.ts";
import { buildDailyCandidatePreview, maybeFreezeDailyCandidates, settleDailyCandidateOutcomes, type DailyCandidateSource } from "./dailyCandidateService.ts";
import { DAILY_FOCUS_MIN_AMOUNT, DAILY_FOCUS_WEIGHTS, winsorizedPercentile, type DailyCandidateScores } from "./dailyCandidateStrategy.ts";

interface RadarSnapshot {
  quotes: MarketQuote[];
  stocks: StockSnapshot[];
  events: SentimentEvent[];
  asOf: string;
  clueAsOf: string;
  clueFailures: string[];
  clueCount: number;
  forumEnabled: boolean;
  forumSource: string;
  forumLicenseId: string | null;
  forumTermsUrl: string | null;
  discussionSources: DiscussionSourceState[];
  sourceStates: LiveClueSourceState[];
  marketStale: boolean;
  marketCached: boolean;
  marketSourceTier: "primary" | "delayed";
  tradeDate: string;
}

/** 异动候选口径：成交额前 150、涨幅前 100、跌幅前 50。 */
export const MOVER_AMOUNT_TOP = 150;
export const MOVER_GAIN_TOP = 100;
export const MOVER_LOSS_TOP = 50;
const DAILY_CANDIDATE_HISTORY_MAX_CODES = 120;
const DAILY_CANDIDATE_HISTORY_CONCURRENCY = 8;

export interface DailyCandidateHistoryContext {
  quotes: MarketQuote[];
  stocks: StockSnapshot[];
  tradeDate: string;
}

export interface LiveFocusFallbackItem {
  code: string;
  name: string;
  rank: number;
  pctChange: number;
  amount: number;
  textDirection: number | null;
  discussionCount: number;
  industryName: string | null;
  liveScore: number;
  scores: DailyCandidateScores;
  state: "awaiting-history";
  reasons: string[];
}

type DailyCandidateHistoryFetcher = typeof fetchEastMoneyDailyBars;
let activeDailyCandidateHistoryHydration: Promise<{ requested: number; hydrated: number; failed: number }> | null = null;
let activeDailyCandidateHistoryTradeDate = "";

/** 即使首次同步尚未完成，也要在数据源页保留全部讨论来源的状态行。 */
export function defaultDiscussionSources(): DiscussionSourceState[] {
  return [
    { id: "eastmoney-guba", name: "东方财富股吧", state: "degraded", detail: "尚未完成首次同步", count: 0 },
    { id: "eastmoney-guba-replies", name: "东方财富股吧评论", state: "degraded", detail: "尚未完成首次同步", count: 0 },
    { id: "xueqiu", name: "雪球讨论", state: "disabled", detail: "需要用户提供合法会话；未配置", count: 0 },
    { id: "weibo", name: "微博讨论", state: "disabled", detail: "需要本机浏览器；未配置", count: 0 },
    { id: "ths-circle", name: "同花顺圈子", state: "disabled", detail: "等待平台授权数据接口", count: 0 },
  ];
}

export interface MoverSelection {
  turnoverHeavy: Set<string>;
  gainers: Set<string>;
  losers: Set<string>;
  focusCodes: string[];
  /** 涨幅榜名次（1-based，涨幅最大第 1）。 */
  gainRank: Map<string, number>;
  /** 跌幅榜名次（1-based，跌幅最大第 1）。 */
  lossRank: Map<string, number>;
}

/** 按口径从行情列表筛选当日异动股（三者取并集）。 */
export function selectMovers(items: MarketQuote[]): MoverSelection {
  const byAmount = [...items]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, MOVER_AMOUNT_TOP)
    .map((quote) => quote.code);
  const turnoverHeavy = new Set(byAmount);
  const gainerList = [...items]
    .filter((quote) => quote.pctChange > 0)
    .sort((a, b) => b.pctChange - a.pctChange)
    .slice(0, MOVER_GAIN_TOP);
  const loserList = [...items]
    .filter((quote) => quote.pctChange < 0)
    .sort((a, b) => a.pctChange - b.pctChange)
    .slice(0, MOVER_LOSS_TOP);
  const gainers = new Set(gainerList.map((quote) => quote.code));
  const losers = new Set(loserList.map((quote) => quote.code));
  const gainRank = new Map(gainerList.map((quote, index) => [quote.code, index + 1]));
  const lossRank = new Map(loserList.map((quote, index) => [quote.code, index + 1]));
  const focusCodes = [...new Set([...gainers, ...losers, ...byAmount])];
  return { turnoverHeavy, gainers, losers, focusCodes, gainRank, lossRank };
}

/** 从快照股票中提取可沉淀的当日舆情字段（仅对已评分股票）。 */
function toDailySentiment(stock: StockSnapshot): DailySentimentSnapshot | null {
  if (stock.analysisStatus !== "scored") return null;
  return {
    textDirectionScore: stock.textDirectionScore,
    radarScore: stock.radarScore,
    alertScore: stock.alertScore,
    signal: stock.signal,
    analysisStatus: stock.analysisStatus,
    factors: stock.factors,
    mentionCount: stock.mentionCount,
    mentionDelta: stock.mentionDelta,
    topics: stock.topics,
    summary: stock.summary,
    sparkline: stock.sparkline,
    sentimentTrend: stock.sentimentTrend,
    sourceMix: stock.sourceMix,
  };
}

/** 由历史每日行情构建某个交易日的股票快照；传入 sentimentByCode 时回填当日舆情（历史舆情快照）。 */
export function buildHistoricalStocks(
  quotes: EastMoneyMarketQuote[],
  watchlist: string[],
  tradeDate: string,
  sentimentByCode?: Map<string, DailySentimentSnapshot>,
): StockSnapshot[] {
  const normalized: MarketQuote[] = quotes
    .filter((quote) => quote.price !== null)
    .map((quote) => ({
      ...quote,
      price: quote.price!,
      pctChange: quote.pctChange ?? 0,
      volume: quote.volume ?? 0,
      amount: quote.amount ?? 0,
      turnover: quote.turnover ?? 0,
      marketCap: quote.marketCap ?? 0,
    }));
  const { turnoverHeavy, gainers, losers, gainRank, lossRank } = selectMovers(normalized);
  const selected = new Set(watchlist);
  const asOf = normalized[0]?.quoteAt ?? `${tradeDate}T15:00:00+08:00`;
  return normalized.map((quote) => {
    const tags: MoverTag[] = [];
    if (gainers.has(quote.code)) tags.push("涨幅大");
    if (losers.has(quote.code)) tags.push("跌幅大");
    if (turnoverHeavy.has(quote.code)) tags.push("成交额大");
    const base = aggregateStock(quote, [], selected.has(quote.code), asOf, tags, gainRank.get(quote.code) ?? lossRank.get(quote.code) ?? null);
    const sentiment = sentimentByCode?.get(quote.code);
    return sentiment ? { ...base, ...sentiment } : base;
  });
}

/** 定时抓取周期：行情约每分钟一次；讨论层内部另有 5 分钟缓存，所有抓取都在后台进行。 */
const SNAPSHOT_REFRESH_MS = 60_000;

/**
 * Full-market polling continues through the close-finalization window.  A 14:59
 * snapshot cannot prove the immutable 15:00 close used by daily-focus, so the
 * scheduler keeps fetching until the 15:30 decision deadline.
 */
export function shouldUseFullMarketRefresh(now: Date): boolean {
  if (isTradingSession(now)) return true;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const tradeDate = `${read("year")}-${read("month")}-${read("day")}`;
  const minutes = Number(read("hour")) * 60 + Number(read("minute"));
  return isTradingDate(tradeDate) && minutes >= 15 * 60 && minutes < 15 * 60 + 30;
}

/** D-6 close is the lower proof boundary needed to rebuild D-1..D-5 comparable discussion windows. */
export function dailyDiscussionQueryFrom(tradeDate: string, tradeDates: string[]): string | null {
  const previous = [...new Set(tradeDates)]
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date < tradeDate)
    .sort();
  const baselineBoundaryDate = previous.at(-6);
  return baselineBoundaryDate ? `${baselineBoundaryDate}T07:00:00.000Z` : null;
}

/** 当前快照（内存缓存，由后台定时任务刷新；接口只读它，绝不阻塞等待远端抓取）。 */
let currentSnapshot: RadarSnapshot | null = null;
/** 单飞锁：同一时刻只允许一次后台刷新。 */
let refreshPromise: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 接口统一入口：
 * - 默认（force=false）：立即返回当前快照，排序/筛选/分页在内存完成，不触发任何远端抓取；
 * - 冷启动（尚无快照）：先用数据库已存数据快速构建一版，同时后台开始实时抓取；
 * - force=true（数据源页“立即刷新”）：等待一次后台抓取完成后返回。
 */
export function buildRadarSnapshot(watchlist: string[], force = false): Promise<RadarSnapshot> {
  if (force) {
    // 手动“立即刷新”：无论是否交易时段都做完整抓取。
    return refreshSnapshot(false).then(() => withWatchlist(currentSnapshot!, watchlist));
  }
  if (currentSnapshot) {
    return Promise.resolve(withWatchlist(currentSnapshot, watchlist));
  }
  return buildFromStore().then(() => withWatchlist(currentSnapshot!, watchlist));
}

/** 冷启动：优先用数据库已存行情+线索构建（不联网）；无存库数据时才等待首次实时抓取。 */
async function buildFromStore(): Promise<void> {
  const stored = readStoredMarketQuotes();
  if (stored) {
    const value = buildSnapshotFromStore(stored);
    if (!currentSnapshot) currentSnapshot = value;
  } else {
    await refreshSnapshot();
  }
}

/**
 * 后台刷新（单飞）：交易时段（9:15–11:30、13:00–15:00）抓取行情+全部线索；
 * 休市期间行情用本地已存数据（不重复请求），线索（快讯/公告/论坛讨论）照常全量抓取。
 * light 参数：null 表示按当前交易时段自动判断；false 强制完整抓取；true 强制轻量。
 */
function refreshSnapshot(light: boolean | null = null): Promise<void> {
  if (refreshPromise) return refreshPromise;
  const useLight = light ?? !shouldUseFullMarketRefresh(new Date());
  diagLog("radar", useLight ? "休市轻量刷新（行情用存库，线索全量抓取）" : "交易时段完整刷新");
  const build = useLight ? buildLightSnapshotInner() : buildSnapshotInner([], false);
  refreshPromise = build
    .then((value) => { currentSnapshot = value; })
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

/** 启动后台定时抓取（服务启动时调用一次）。 */
export function startScheduledRefresh(): void {
  if (refreshTimer) return;
  void refreshSnapshot();
  refreshTimer = setInterval(() => void refreshSnapshot(), SNAPSHOT_REFRESH_MS);
}

/** 停止后台刷新；服务退出或监听失败时调用，避免定时器把进程继续挂住。 */
export function stopScheduledRefresh(): void {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
}

/** 线索包：实时抓取与存库回退共用同一种结构。 */
export interface SnapshotClues {
  items: RawClue[];
  updatedAt: string;
  failures: string[];
  forumEnabled: boolean;
  forumSource: string;
  forumLicenseId: string | null;
  forumTermsUrl: string | null;
  discussionSources: DiscussionSourceState[];
  sourceStates: LiveClueSourceState[];
}

/**
 * Explicit, clock-free bridge between the persisted radar snapshot and daily-focus.
 * Preserve independently audited source states verbatim: neither the aggregate clue
 * timestamp nor a fetch timestamp is a coverage watermark.
 */
export function buildDailyCandidateSourceFromRadar(input: {
  market: Pick<MarketSyncResult, "items" | "updatedAt" | "tradeDate" | "stale">;
  clues: Pick<SnapshotClues, "updatedAt" | "failures" | "sourceStates" | "discussionSources">;
  stocks: StockSnapshot[];
  events: SentimentEvent[];
  tradeDates: string[];
  discussionWindowsByCode?: DailyCandidateSource["discussionWindowsByCode"];
}): DailyCandidateSource {
  const recentTradeDates = input.tradeDates.filter((date) => date <= input.market.tradeDate).sort();
  const discussionDates = recentTradeDates.filter((date) => date < input.market.tradeDate).slice(-5);
  const persistedDiscussion = input.discussionWindowsByCode ?? Object.fromEntries(Object.entries(getDailyDiscussionWindows(discussionDates)).map(([code, windows]) => [code, windows
    .filter((window) => window.state === "connected" && window.cursorExhausted)
    .map((window) => ({ ...window, state: "connected" as const, cursorExhausted: true as const, elapsedMinutes: 240, verified: true as const }))]));
  return {
    quotes: input.market.items,
    stocks: input.stocks,
    events: input.events,
    tradeDate: input.market.tradeDate,
    marketAsOf: input.market.updatedAt,
    clueAsOf: input.clues.updatedAt,
    marketStale: input.market.stale,
    marketComplete: input.market.items.length >= 4_000,
    isTradingDay: isTradingDate(input.market.tradeDate),
    clueFailures: input.clues.failures,
    sourceStates: input.clues.sourceStates,
    discussionWindowsByCode: persistedDiscussion,
    recentTradeDates,
    previousTradeDate: recentTradeDates.filter((date) => date < input.market.tradeDate).at(-1) ?? input.market.tradeDate,
    discussionSources: input.clues.discussionSources.map((source) => ({ ...source, coveredThrough: null })),
  };
}

/** Builds a read-only current preview when no prospective list has been frozen yet. */
export async function buildDailyCandidatePreviewFromRadar(watchlist: string[]) {
  const snapshot = await buildRadarSnapshot(watchlist);
  const now = new Date();
  const source = buildDailyCandidateSourceFromRadar({
    market: { items: snapshot.quotes, updatedAt: snapshot.asOf, tradeDate: snapshot.tradeDate, stale: snapshot.marketStale },
    clues: { updatedAt: snapshot.clueAsOf, failures: snapshot.clueFailures, sourceStates: snapshot.sourceStates, discussionSources: snapshot.discussionSources },
    stocks: snapshot.stocks,
    events: snapshot.events,
    tradeDates: listTradeDates(),
  });
  if (isTradingSession(now) && snapshot.tradeDate === shanghaiDate(now)) {
    const hydration = await ensureDailyCandidateHistory(snapshot);
    return withLiveFocusFallback(previewWithHistoryQuality(buildDailyCandidatePreview(source, now), hydration), snapshot);
  }
  return withLiveFocusFallback(buildDailyCandidatePreview(source, now), snapshot);
}

/** Complete the online-history step before calculating the live preview. */
export async function buildDailyCandidatePreviewWithHistory(
  source: DailyCandidateSource,
  now: Date,
  fetchHistory: DailyCandidateHistoryFetcher = fetchEastMoneyDailyBars,
) {
  const hydration = await hydrateDailyCandidateHistory({ quotes: source.quotes, stocks: source.stocks, tradeDate: source.tradeDate }, fetchHistory);
  return withLiveFocusFallback(previewWithHistoryQuality(buildDailyCandidatePreview(source, now), hydration), source);
}

/** Always retain useful current-day stock information while formal five-day evidence is incomplete. */
export function buildLiveFocusFallback(input: DailyCandidateHistoryContext): LiveFocusFallbackItem[] {
  const stockByCode = new Map(input.stocks.map((stock) => [stock.code, stock]));
  const universe = input.quotes
    .filter((quote) => (quote.exchange === "SH" || quote.exchange === "SZ")
      && quote.price > 0
      && quote.amount > 0
      && !/(?:^|\s)\*?ST(?=\s|[^A-Za-z0-9]|$)|退市/i.test(quote.name));
  const amountReference = universe.map((quote) => quote.amount);
  const priceReference = universe.map((quote) => quote.pctChange);
  const discussionReference = universe.map((quote) => stockByCode.get(quote.code)?.mentionCount ?? 0);
  const weighted = (signal: number, weight: number) => Math.round(clamp(signal) / 100 * weight * 10_000) / 10_000;
  return universe
    .filter((quote) => quote.amount >= DAILY_FOCUS_MIN_AMOUNT)
    .map((quote) => {
      const stock = stockByCode.get(quote.code);
      const industry = stock?.industryPulse;
      const industrySignal = industry ? .3 * industry.textHeat + .2 * industry.textDirection + .3 * industry.marketStrength + .2 * industry.breadth : 0;
      const scores: DailyCandidateScores = {
        turnover: weighted(winsorizedPercentile(quote.amount, amountReference), DAILY_FOCUS_WEIGHTS.turnover),
        direction: weighted(stock?.textDirectionScore ?? 0, DAILY_FOCUS_WEIGHTS.direction),
        discussion: weighted(winsorizedPercentile(stock?.mentionCount ?? 0, discussionReference), DAILY_FOCUS_WEIGHTS.discussion),
        price: weighted(winsorizedPercentile(quote.pctChange, priceReference), DAILY_FOCUS_WEIGHTS.price),
        industry: weighted(industrySignal, DAILY_FOCUS_WEIGHTS.industry),
        reliability: stock?.analysisStatus === "scored" ? DAILY_FOCUS_WEIGHTS.reliability : 0,
      };
      const liveScore = Math.round(Object.values(scores).reduce((sum, value) => sum + value, 0) * 10_000) / 10_000;
      return { quote, stock, scores, liveScore };
    })
    .sort((left, right) => right.liveScore - left.liveScore
      || right.scores.turnover - left.scores.turnover
      || right.quote.amount - left.quote.amount
      || left.quote.code.localeCompare(right.quote.code))
    .slice(0, 10)
    .map(({ quote, stock, scores, liveScore }, index) => {
      return {
        code: quote.code,
        name: quote.name,
        rank: index + 1,
        pctChange: quote.pctChange,
        amount: quote.amount,
        textDirection: stock?.textDirectionScore ?? null,
        discussionCount: stock?.mentionCount ?? 0,
        industryName: stock?.industry?.name ?? quote.industryName ?? null,
        liveScore,
        scores,
        state: "awaiting-history" as const,
        reasons: [
          quote.pctChange > 0 ? "当日上涨" : "成交活跃",
          `成交额 ${(quote.amount / 100_000_000).toFixed(2)} 亿`,
          `成交评分 ${scores.turnover.toFixed(1)} / 30`,
          stock?.textDirectionScore !== null && stock?.textDirectionScore !== undefined ? `文本方向 ${stock.textDirectionScore}` : "文本方向待补充",
        ],
      };
    });
}

/**
 * Select the small, already-scored intraday universe that could realistically enter daily focus.
 * Historical K-lines are never fetched for the whole market on demand.
 */
export function dailyCandidateHistoryCodes(input: DailyCandidateHistoryContext): string[] {
  const stockByCode = new Map(input.stocks.map((stock) => [stock.code, stock]));
  return input.quotes
    .filter((quote) => {
      const stock = stockByCode.get(quote.code);
      return (quote.exchange === "SH" || quote.exchange === "SZ")
        && quote.pctChange > 0
        && quote.amount >= 100_000_000
        && stock?.analysisStatus === "scored"
        && (stock.textDirectionScore ?? 0) >= 55;
    })
    .sort((left, right) => {
      const leftStock = stockByCode.get(left.code)!;
      const rightStock = stockByCode.get(right.code)!;
      return (rightStock.textDirectionScore ?? 0) - (leftStock.textDirectionScore ?? 0)
        || right.amount - left.amount
        || right.pctChange - left.pctChange
        || left.code.localeCompare(right.code);
    })
    .slice(0, DAILY_CANDIDATE_HISTORY_MAX_CODES)
    .map((quote) => quote.code);
}

/** Fetch and persist only missing five-day amount histories needed by the live daily-focus preview. */
export async function hydrateDailyCandidateHistory(
  input: DailyCandidateHistoryContext,
  fetchHistory: DailyCandidateHistoryFetcher = fetchEastMoneyDailyBars,
): Promise<{ requested: number; hydrated: number; failed: number }> {
  const candidates = dailyCandidateHistoryCodes(input);
  const cached = getRecentAmounts(candidates, 5, input.tradeDate);
  const missing = candidates.filter((code) => (cached.get(code)?.length ?? 0) < 5);
  let cursor = 0;
  let hydrated = 0;
  let failed = 0;
  const worker = async () => {
    while (cursor < missing.length) {
      const code = missing[cursor++]!;
      try {
        const result = await fetchHistory({ code, limit: 10, adjustment: "none", timeoutMs: 4_000 });
        if (result.items.some((item) => item.amount !== null)) {
          saveEastMoneyDailyBars(result);
          hydrated += 1;
        }
      } catch {
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DAILY_CANDIDATE_HISTORY_CONCURRENCY, missing.length) }, worker));
  return { requested: missing.length, hydrated, failed };
}

async function ensureDailyCandidateHistory(snapshot: RadarSnapshot): Promise<{ requested: number; hydrated: number; failed: number }> {
  if (!activeDailyCandidateHistoryHydration || activeDailyCandidateHistoryTradeDate !== snapshot.tradeDate) {
    activeDailyCandidateHistoryTradeDate = snapshot.tradeDate;
    activeDailyCandidateHistoryHydration = hydrateDailyCandidateHistory(snapshot)
      .catch(() => ({ requested: 0, hydrated: 0, failed: 0 }))
      .finally(() => { activeDailyCandidateHistoryHydration = null; });
  }
  return activeDailyCandidateHistoryHydration;
}

function previewWithHistoryQuality(
  preview: ReturnType<typeof buildDailyCandidatePreview>,
  hydration: { requested: number; hydrated: number; failed: number },
) {
  const history = hydration.requested === 0 ? "cached" : hydration.failed === hydration.requested ? "unavailable" : hydration.failed > 0 ? "partial" : "online";
  return { ...preview, dataQuality: { ...preview.dataQuality, history, historyRequested: hydration.requested, historyHydrated: hydration.hydrated, historyFailed: hydration.failed } };
}

function withLiveFocusFallback<T extends ReturnType<typeof buildDailyCandidatePreview>>(preview: T, input: DailyCandidateHistoryContext) {
  return preview.items.length ? preview : { ...preview, liveFocusItems: buildLiveFocusFallback(input) };
}

function shanghaiDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

async function buildSnapshotInner(watchlist: string[], force: boolean): Promise<RadarSnapshot> {
  diagLog("radar", "build 开始");
  const market = await syncMarketQuotes(force);
  diagLog("radar", "市场就绪", market.items.length, "只", market.stale ? "stale" : "fresh");
  const value = await buildSnapshotFromMarket(market, force);
  return withWatchlist(value, watchlist);
}

/** 行情就绪后共享的抓取+装配：异动集合、抓取全部线索（快讯/个股新闻/公告/论坛）、落库、评分。 */
async function buildSnapshotFromMarket(market: MarketSyncResult, force: boolean): Promise<RadarSnapshot> {
  // 异动股集合（异动候选页范围），严格按口径筛选：
  //   - 成交额前 150（amount 降序）—— 承接全市场流动性主体；
  //   - 涨幅前 100（pctChange>0 降序）—— 当日最强多头；
  //   - 跌幅前 50（pctChange<0 升序，跌幅最大在前）—— 当日最强空头。
  // 三者取并集，确保入选标的确实是“成交活跃 / 涨跌幅显著”的股票，避免小涨小跌、低成交个股混入。
  // 讨论层只对这一集合扫股吧，控制抓取量；讨论层按可配置周期缓存，行情层仍实时。
  const { focusCodes } = selectMovers(market.items);
  // 股票名称映射：微博等按名称搜索的讨论源使用。
  const stockNames = new Map(market.items.map((quote) => [quote.code, quote.name]));
  const tradeDates = listTradeDates();
  const previousTradeDate = tradeDates.find((date) => date < market.tradeDate);
  const discussionQueryFrom = dailyDiscussionQueryFrom(market.tradeDate, tradeDates);
  const liveClues = await getLiveClues(force, focusCodes, stockNames, previousTradeDate ? {
    tradeDate: market.tradeDate,
    previousTradeDate,
    ...(discussionQueryFrom ? { discussionQueryFrom } : {}),
  } : undefined).catch((error) => {
      const stored = getStoredClues();
      if (!stored.length) throw error;
      return { items: stored, updatedAt: stored[0]?.publishedAt ?? new Date().toISOString(), cached: true, failures: ["实时线索连接"], forumEnabled: false, forumSource: "论坛舆情 · 待授权接入", forumLicenseId: null, forumTermsUrl: null, discussionSources: defaultDiscussionSources(), sourceStates: [] };
    });
  diagLog("radar", "线索就绪", liveClues.items.length, "条", liveClues.cached ? "(缓存)" : "");
  saveClues(liveClues.items);
  persistCurrentDiscussionWindows(market, liveClues);
  return assembleSnapshot(market, liveClues);
}

const closeCutoff = (tradeDate: string) => `${tradeDate}T07:00:00.000Z`;

/**
 * Captures the official discussion interval only from a source's own exhausted
 * server range proof.  We deliberately write one immutable record per
 * code/trade-date/source, including genuine zero-count windows, so a later
 * candidate rebuild never has to fabricate a zero baseline.
 */
export function persistCurrentDiscussionWindows(market: Pick<MarketSyncResult, "items" | "tradeDate">, clues: Pick<SnapshotClues, "items" | "sourceStates">): void {
  const cutoff = closeCutoff(market.tradeDate);
  // listTradeDates is descending: the first prior value is the immediately
  // preceding trading day, not the oldest row in the database.
  const previousTradeDate = listTradeDates().find((date) => date < market.tradeDate);
  if (!previousTradeDate) return;
  const featureStart = closeCutoff(previousTradeDate);
  const windows = clues.sourceStates
    .filter((state) => state.role === "discussion" && state.state === "connected" && state.queryFrom !== null && state.queryTo !== null && state.coveredThrough !== null && state.coveredCodes.length > 0
      && state.queryFrom <= featureStart && state.queryTo >= cutoff && state.coveredThrough >= cutoff)
    .flatMap((state) => {
      const authorized = new Set(state.eventIds);
      const sourceItems = clues.items.filter((item) => item.adapterId === state.id && authorized.has(item.id) && item.publishedAt > featureStart && item.publishedAt <= cutoff);
      return market.items.filter((quote) => state.coveredCodes.includes(quote.code)).map((quote) => {
        const related = sourceItems.filter((item) => item.stockCodes.includes(quote.code));
        return {
          code: quote.code, tradeDate: market.tradeDate, sourceId: state.id, adapterId: state.id, state: "connected" as const,
          featureStart, featureCutoff: cutoff, queryFrom: state.queryFrom!, queryTo: state.queryTo!, cursorExhausted: true as const, coveredThrough: state.coveredThrough!, coveredCodes: state.coveredCodes,
          count: related.length, interactions: related.reduce((sum, item) => sum + Math.max(0, item.interactionCount), 0),
        };
      });
    });
  if (windows.length) saveDailyDiscussionWindows(windows);
}

/** 冷启动：只用数据库已存行情与线索构建快照（不联网，毫秒级；不重复落库舆情快照）。 */
function buildSnapshotFromStore(market: MarketSyncResult): RadarSnapshot {
  const stored = getStoredClues();
  const clues: SnapshotClues = stored.length
    ? { items: stored, updatedAt: stored[0]?.publishedAt ?? new Date().toISOString(), failures: ["实时线索连接"], forumEnabled: false, forumSource: "论坛舆情 · 待授权接入", forumLicenseId: null, forumTermsUrl: null, discussionSources: defaultDiscussionSources(), sourceStates: [] }
    : { items: [], updatedAt: new Date().toISOString(), failures: ["实时线索连接"], forumEnabled: false, forumSource: "论坛舆情 · 待授权接入", forumLicenseId: null, forumTermsUrl: null, discussionSources: defaultDiscussionSources(), sourceStates: [] };
  return assembleSnapshot(market, clues, false);
}

/**
 * 休市轻量刷新：行情用本地已存数据（不重复请求），线索仍全量抓取
 * （财经快讯、个股新闻、上市公司公告与论坛讨论照常更新），并落库。
 */
async function buildLightSnapshotInner(): Promise<RadarSnapshot> {
  const market = readStoredMarketQuotes() ?? (await syncMarketQuotes(true));
  if (!market) throw new Error("本地尚无已保存的完整行情快照");
  diagLog("radar", "休市轻量刷新：行情用存库，线索全量抓取");
  return buildSnapshotFromMarket(market, false);
}

/** 共享的分析装配：行情 + 线索 → 事件、评分、异动标签、舆情快照落库与快照对象。 */
function assembleSnapshot(market: MarketSyncResult, clues: SnapshotClues, persistSentiment = true): RadarSnapshot {
  const { turnoverHeavy, gainers, losers, gainRank, lossRank } = selectMovers(market.items);
  const quoteMap = new Map(market.items.map((quote) => [quote.code, quote]));
  const events = linkAndAnalyzeClues(clues.items, market.items, quoteMap);
  // 线索与行业关系在事件生成后立即落库，保证重启后仍可审计；公司事件只沿直接关联股票
  // 的真实行业归属落链，不再因为标题里的行业关键词扩散到其他行业。
  saveClueIndustryLinks(buildClueIndustryLinks(events, market.items, quoteMap));
  const eventMap = new Map<string, SentimentEvent[]>();
  for (const event of events) {
    for (const related of event.relatedStocks) {
      const current = eventMap.get(related.code) ?? [];
      current.push(event);
      eventMap.set(related.code, current);
    }
  }
  const stocks = market.items.map((quote) => {
    const tags: Array<"涨幅大" | "跌幅大" | "成交额大"> = [];
    if (gainers.has(quote.code)) tags.push("涨幅大");
    if (losers.has(quote.code)) tags.push("跌幅大");
    if (turnoverHeavy.has(quote.code)) tags.push("成交额大");
    const changeRank = gainRank.get(quote.code) ?? lossRank.get(quote.code) ?? null;
    return aggregateStock(quote, eventMap.get(quote.code) ?? [], false, market.updatedAt, tags, changeRank);
  });
  // 每日舆情快照：把当日已评分股票的线索聚合结果沉淀到 SQLite，供历史交易日回看。
  if (persistSentiment) {
    saveDailySentiment(
      stocks
        .map((stock) => ({ code: stock.code, tradeDate: market.tradeDate, sentiment: toDailySentiment(stock) }))
        .filter((row): row is { code: string; tradeDate: string; sentiment: DailySentimentSnapshot } => row.sentiment !== null),
    );
    const industryAnalytics = buildIndustryAnalytics({
      stocks,
      events,
      asOf: market.updatedAt,
      clueAsOf: clues.updatedAt,
      tradeDate: market.tradeDate,
    });
    saveIndustryDailySnapshots(industryAnalytics.items.map((pulse) => ({
      industryCode: pulse.profile.code,
      industryName: pulse.profile.name,
      tradeDate: market.tradeDate,
      observedAt: market.updatedAt,
      clueAsOf: clues.updatedAt,
      textHeat: pulse.textHeat,
      textDirection: pulse.textDirection,
      textConfidence: pulse.textConfidence,
      marketStrength: pulse.marketStrength,
      industryReturn: pulse.industryReturn,
      marketReturn: pulse.industryReturn - pulse.marketExcess,
      marketExcess: pulse.marketExcess,
      breadth: pulse.breadth,
      amountShare: pulse.amountShare,
      relation: pulse.relation,
      stage: pulse.stage,
      driver: pulse.driver,
      informationCategories: pulse.informationCategories,
      independentEvents: pulse.independentEvents,
      mentionCount: pulse.mentionCount,
      discussionCount: pulse.discussionCount,
      sourceCount: pulse.sourceCount,
      stockCoverage: pulse.stockCoverage,
      eligibleStockCount: pulse.eligibleStockCount,
      memberCodes: industryAnalytics.stocks.filter((stock) => stock.industry.code === pulse.profile.code).map((stock) => stock.code),
    })));
    // 每次真实行情刷新后尝试结算所有已到期的行业观察，未到期记录保持 observing。
    settleIndustryForwardOutcomes(market.tradeDate);
    // 每日聚焦只在行情、线索、舆情及行业快照均已持久化后运行。服务本身不抓取数据；
    // 将本轮快照和调用时刻显式传入，失败也绝不能反过来影响雷达主快照发布。
    try {
      maybeFreezeDailyCandidates(buildDailyCandidateSourceFromRadar({
        market,
        clues,
        stocks,
        events,
        tradeDates: listTradeDates(),
      }), new Date());
    } catch (error) {
      diagLog("daily-candidates", "冻结跳过", error instanceof Error ? error.message : String(error));
    }
    try {
      settleDailyCandidateOutcomes(market.tradeDate);
    } catch (error) {
      diagLog("daily-candidates", "结算跳过", error instanceof Error ? error.message : String(error));
    }
  }
  return {
    quotes: market.items,
    stocks,
    events,
    asOf: market.updatedAt,
    clueAsOf: clues.updatedAt,
    clueFailures: clues.failures,
    clueCount: getClueCount(),
    forumEnabled: clues.forumEnabled,
    forumSource: clues.forumSource,
    forumLicenseId: clues.forumLicenseId,
    forumTermsUrl: clues.forumTermsUrl,
    discussionSources: clues.discussionSources,
    sourceStates: clues.sourceStates,
    marketStale: market.stale,
    marketCached: market.cached,
    marketSourceTier: market.sourceTier,
    tradeDate: market.tradeDate,
  };
}

function buildClueIndustryLinks(events: SentimentEvent[], quotes: MarketQuote[], quoteMap: Map<string, MarketQuote>) {
  const knownIndustryNames = [...new Set(quotes.map((quote) => normalizeIndustryName(quote.industryName)).filter((value): value is string => Boolean(value)))];
  return events.flatMap((event) => {
    const directIndustry = new Map<string, { name: string; relevance: number; evidence: string }>();
    for (const related of event.relatedStocks) {
      const quote = quoteMap.get(related.code);
      const name = normalizeIndustryName(quote?.industryName);
      if (!name) continue;
      const code = industryCodeForName(name);
      directIndustry.set(code, { name, relevance: Math.max(related.relevance, directIndustry.get(code)?.relevance ?? 0), evidence: `通过直接关联股票${related.code}归属行业` });
    }
    // 公司公告/公司事件不得使用文本关键词做行业扩散；其行业关系只来自直接关联股票。
    if (!directIndustry.size && event.category !== "公司公告" && event.eventType !== "公司") {
      const text = `${event.title}${event.summary}${event.topics.join("")}`;
      for (const name of knownIndustryNames) {
        if (!text.includes(name)) continue;
        const code = industryCodeForName(name);
        directIndustry.set(code, { name, relevance: 72, evidence: `线索文本明确提及行业“${name}”` });
      }
    }
    const influenceDirection: -1 | 0 | 1 = event.tone === "positive" ? 1 : event.tone === "negative" ? -1 : 0;
    return [...directIndustry.entries()].map(([industryCode, value]) => ({
      clueId: event.id,
      industryCode,
      industryName: value.name,
      relevance: value.relevance,
      influenceDirection,
      chainPosition: null,
      evidence: value.evidence,
    }));
  });
}

export function buildDashboard(snapshot: RadarSnapshot, watchlist: string[]): DashboardData {
  const analyzed = snapshot.stocks.filter((stock) => stock.analysisStatus === "scored");
  const sentiments = analyzed.map((stock) => stock.factors.sentiment);
  const moodIndex = sentiments.length ? clamp(50 + average(sentiments) / 2) : 50;
  const divergence = analyzed.length ? clamp(100 - average(analyzed.map((stock) => stock.factors.consensus))) : 0;
  const watchlistStocks = watchlist
    .map((code) => snapshot.stocks.find((stock) => stock.code === code))
    .filter((stock): stock is StockSnapshot => Boolean(stock))
    .sort((a, b) => (b.alertScore ?? -1) - (a.alertScore ?? -1));

  return {
    asOf: mostRecent(snapshot.asOf, snapshot.clueAsOf),
    dataMode: !snapshot.marketStale && snapshot.clueFailures.length === 0 ? "live" : "partial",
    dataMessage: snapshot.marketStale
      ? "东方财富行情更新暂时受限，当前使用本地保存的最后完整真实快照"
      : snapshot.clueFailures.length
        ? `东方财富行情已保存到本地；${snapshot.clueFailures.join("、")}暂时受限`
        : "东方财富全市场行情与全部已配置舆情来源已连接",
    moodIndex: Number(moodIndex.toFixed(1)),
    moodChange: 0,
    breadth: snapshot.stocks.length ? Number(((analyzed.length / snapshot.stocks.length) * 100).toFixed(1)) : 0,
    divergence: Number(divergence.toFixed(1)),
    totalMentions: snapshot.events.length,
    universeTotal: snapshot.stocks.length,
    analyzedStocks: analyzed.length,
    sourceCount: new Set(snapshot.events.map((event) => event.source)).size,
    moodSeries: buildMoodSeries(snapshot.events),
    themes: buildThemes(snapshot.events),
    // 载荷控制：接口只回传最近 400 条事件，完整计数由 totalMentions 提供。
    events: snapshot.events.slice(0, 400),
    watchlist: watchlistStocks,
  };
}

export function stockEvents(snapshot: RadarSnapshot, code: string) {
  return snapshot.events.filter((event) => event.relatedStocks.some((stock) => stock.code === code));
}

function withWatchlist(snapshot: RadarSnapshot, watchlist: string[]): RadarSnapshot {
  const selected = new Set(watchlist);
  return { ...snapshot, stocks: snapshot.stocks.map((stock) => ({ ...stock, isWatchlisted: selected.has(stock.code) })) };
}

/** 情绪分类输入：股吧评论只取评论正文，其余来源取标题 + 摘要。 */
function classificationText(clue: RawClue): string {
  if (clue.sourceKind !== "forum") return `${clue.title} ${clue.summary}`;
  const reply = clue.summary.match(/^在《[^》]*》下的评论：([\s\S]*)$/);
  return reply ? reply[1] : `${clue.title} ${clue.summary}`;
}

function linkAndAnalyzeClues(clues: RawClue[], quotes: MarketQuote[], quoteMap: Map<string, MarketQuote>): SentimentEvent[] {
  const searchableQuotes = quotes.filter((quote) => quote.name.length >= 2);
  return clues.map((clue): SentimentEvent | null => {
    const text = `${clue.title} ${clue.summary}`;
    // 股吧评论的 summary 形如「在《帖子标题》下的评论：评论文本」。
    // 情绪应只反映评论本身，剥离帖子标题，避免帖子标题的情绪污染评论情绪。
    const analysis = classifyText(classificationText(clue));
    const directCodes = new Set(clue.stockCodes.filter((code) => quoteMap.has(code)));
    if (directCodes.size === 0) {
      for (const quote of searchableQuotes) {
        if (text.includes(quote.name) || text.includes(quote.code)) directCodes.add(quote.code);
        if (directCodes.size >= 8) break;
      }
    }
    const relatedStocks = [...directCodes].map((code) => {
      const quote = quoteMap.get(code)!;
      const direct = clue.stockCodes.includes(code);
      return {
        code,
        name: quote.name,
        relevance: direct ? 96 : 82,
        reason: direct ? "线索源直接标注该股票" : "标题或摘要直接提及公司名称或代码",
        tone: analysis.tone,
      };
    });
    if (!relatedStocks.length && clue.sourceKind !== "news") return null;
    const ageHours = Math.max(0, (Date.now() - new Date(clue.publishedAt).valueOf()) / 3_600_000);
    const heat = clamp(90 - ageHours * 1.5 + Math.log2(clue.interactionCount + 1) * 4 + relatedStocks.length * 2);
    return {
      id: clue.id,
      title: clue.title,
      category: clue.sourceKind === "forum" ? "用户讨论" : clue.sourceKind === "announcement" ? "公司公告" : "新闻事件",
      eventType: analysis.eventType,
      publishedAt: clue.publishedAt,
      source: clue.source,
      sourceKind: clue.sourceKind,
      tone: analysis.tone,
      confidence: analysis.confidence,
      heat: Math.round(heat),
      summary: clue.summary,
      topics: analysis.topics.length ? analysis.topics : analysis.keywords.slice(0, 4),
      relatedStocks,
      corroboration: 1,
      url: clue.url,
      adapterId: clue.adapterId,
    };
  }).filter((event): event is SentimentEvent => event !== null)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

function aggregateStock(quote: MarketQuote, events: SentimentEvent[], isWatchlisted: boolean, asOf: string, moverTags: Array<"涨幅大" | "跌幅大" | "成交额大"> = [], changeRank: number | null = null): StockSnapshot {
  const industry = toIndustryReference(quote, asOf);
  if (!events.length) {
    const emptyFactors: ScoreFactors = { sentiment: 0, attention: 0, velocity: 0, consensus: 0, sourceQuality: 0, priceConfirm: 50, freshness: 0 };
    return {
      ...quote,
      textDirectionScore: null,
      radarScore: null,
      alertScore: null,
      signal: "证据不足",
      analysisStatus: "no_clues",
      factors: emptyFactors,
      mentionCount: 0,
      mentionDelta: 0,
      topics: [],
      summary: "当前实时线索窗口内尚未发现与该股票直接相关的有效信息。",
      sparkline: [],
      sentimentTrend: [],
      priceHistory: [],
      sourceMix: {},
      asOf,
      isWatchlisted,
      moverTags,
      changeRank,
      ...(industry ? { industry } : {}),
    };
  }

  const eventScores = events.map((event) => toneScore(event.tone));
  const sentiment = Math.round(average(eventScores));
  const positive = eventScores.filter((score) => score > 8).length;
  const negative = eventScores.filter((score) => score < -8).length;
  const directional = positive + negative;
  const consensus = directional ? clamp(100 - (Math.min(positive, negative) / directional) * 100) : 50;
  const latestAge = Math.max(0, (Date.now() - new Date(events[0].publishedAt).valueOf()) / 3_600_000);
  const attention = clamp(24 + Math.log2(events.length + 1) * 11 + average(events.map((event) => event.heat)) * 0.3);
  const velocity = clamp(95 - latestAge * 2 + Math.min(28, events.length * 4));
  const sourceQuality = average(events.map((event) => event.sourceKind === "announcement" ? 95 : event.sourceKind === "news" ? 82 : 55));
  const freshness = clamp(100 - latestAge * 3);
  const priceConfirm = Math.abs(sentiment) < 8 ? 50 : Math.sign(sentiment) === Math.sign(quote.pctChange)
    ? clamp(65 + Math.abs(quote.pctChange) * 3)
    : clamp(35 - Math.abs(quote.pctChange) * 2);
  const factors: ScoreFactors = {
    sentiment,
    attention: Math.round(attention),
    velocity: Math.round(velocity),
    consensus: Math.round(consensus),
    sourceQuality: Math.round(sourceQuality),
    priceConfirm: Math.round(priceConfirm),
    freshness: Math.round(freshness),
  };
  const radarScore = calculateRadarScore(factors);
  const textDirectionScore = Math.round(clamp(50 + sentiment / 2));
  const alertScore = calculateAlertScore(factors);
  const sourceCounts = new Map<string, number>();
  for (const event of events) sourceCounts.set(event.source, (sourceCounts.get(event.source) ?? 0) + 1);
  const sourceMix = Object.fromEntries([...sourceCounts].map(([source, count]) => [source, Math.round((count / events.length) * 100)]));
  const topics = [...new Set(events.flatMap((event) => event.topics))].slice(0, 4);
  const sparkline = events.slice(0, 12).reverse().map((event) => event.heat);
  const sentimentTrend = events.slice(0, 12).reverse().map((event) => toneScore(event.tone));
  return {
    ...quote,
    textDirectionScore,
    radarScore,
    alertScore,
    signal: signalFromFactors(factors, radarScore),
    analysisStatus: "scored",
    factors,
    mentionCount: events.length,
    mentionDelta: 0,
    topics,
    summary: buildSummary(events, sentiment),
    sparkline,
    sentimentTrend,
    priceHistory: [],
    sourceMix,
    asOf,
    isWatchlisted,
    moverTags,
    changeRank,
    ...(industry ? { industry } : {}),
  };
}

function toIndustryReference(quote: Pick<MarketQuote, "industryName">, asOf: string): StockSnapshot["industry"] {
  const name = normalizeIndustryName(quote.industryName);
  if (!name) return undefined;
  return {
    code: industryCodeForName(name),
    name,
    parent: name,
    level: "行业",
    taxonomy: "东方财富行业",
    asOf,
  };
}

function buildSummary(events: SentimentEvent[], sentiment: number) {
  const direction = sentiment > 12 ? "整体偏正面" : sentiment < -12 ? "整体偏负面" : "方向暂不明确";
  return `近窗共关联 ${events.length} 条实时线索，${direction}；最新线索来自${events[0].source}。`;
}

function buildMoodSeries(events: SentimentEvent[]): MoodPoint[] {
  const buckets = new Map<string, { positive: number; negative: number; volume: number }>();
  for (const event of events) {
    const date = new Date(event.publishedAt);
    const key = `${String(date.getHours()).padStart(2, "0")}:00`;
    const bucket = buckets.get(key) ?? { positive: 0, negative: 0, volume: 0 };
    if (event.tone === "positive") bucket.positive += 1;
    if (event.tone === "negative") bucket.negative += 1;
    bucket.volume += 1;
    buckets.set(key, bucket);
  }
  const rows = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-10);
  if (!rows.length) return [{ time: "当前", positive: 0, negative: 0, volume: 0 }];
  const peak = Math.max(1, ...rows.map(([, value]) => value.volume));
  return rows.map(([time, value]) => ({
    time,
    positive: Math.round((value.positive / peak) * 100),
    negative: Math.round((value.negative / peak) * 100),
    volume: value.volume,
  }));
}

function buildThemes(events: SentimentEvent[]): ThemePulse[] {
  const counts = new Map<string, { count: number; score: number }>();
  for (const event of events) {
    for (const topic of event.topics) {
      const current = counts.get(topic) ?? { count: 0, score: 0 };
      current.count += 1;
      current.score += toneScore(event.tone);
      counts.set(topic, current);
    }
  }
  const max = Math.max(1, ...[...counts.values()].map((value) => value.count));
  return [...counts.entries()].map(([name, value]) => {
    const score = value.score / value.count;
    return {
      name,
      heat: Math.round((value.count / max) * 100),
      change: Number(score.toFixed(1)),
      tone: score > 8 ? "positive" as const : score < -8 ? "negative" as const : "neutral" as const,
      mentions: value.count,
    };
  }).sort((a, b) => b.mentions - a.mentions).slice(0, 8);
}

function toneScore(tone: SentimentEvent["tone"]) {
  return tone === "positive" ? 72 : tone === "negative" ? -72 : 0;
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, value));
}

function mostRecent(a: string, b: string) {
  return new Date(a) > new Date(b) ? a : b;
}
