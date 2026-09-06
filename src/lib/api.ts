import type {
  DashboardData,
  IndustryPulseSummary,
  KlinePeriod,
  KlineResponse,
  SentimentEvent,
  StockDetailResponse,
  StockListResponse,
  SystemStatus,
} from "../domain/types";

interface EventsResponse {
  items: SentimentEvent[];
  total: number;
  asOf: string;
}

interface WatchlistResponse {
  codes: string[];
}

export type DiscussionSourceId = "eastmoney-guba" | "eastmoney-guba-replies" | "weibo";

export interface SourceDiscussion {
  id: string;
  source: string;
  sourceKind: "news" | "forum" | "announcement";
  title: string;
  summary: string;
  publishedAt: string;
  url: string;
  stockCodes: string[];
  interactionCount: number;
}

export interface SourceDiscussionsResponse {
  source: DiscussionSourceId;
  items: SourceDiscussion[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface IndustryAnalyticsResponse {
  asOf: string;
  clueAsOf: string | null;
  tradeDate: string;
  benchmark: string;
  textMetricsExcludePrice: true;
  items: IndustryPulseSummary[];
  methodology: {
    textHeat: string;
    textDirection: string;
    marketStrength: string;
    relationship: string;
    dataCutoff: string;
    version: string;
  };
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const text = await response.text();
  let payload: T & { message?: string };
  try {
    payload = JSON.parse(text) as T & { message?: string };
  } catch {
    throw new Error(response.ok ? "数据格式异常，请稍后重试" : `数据服务暂不可用（状态 ${response.status}）`);
  }
  if (!response.ok) throw new ApiError(payload.message || `请求失败（状态 ${response.status}）`, response.status);
  return payload;
}

export interface StockQuery {
  q?: string;
  signal?: string;
  market?: string;
  sort?: string;
  /** all 全市场 | movers 异动候选（仅异动股：成交额前150 + 涨幅前100 + 跌幅前50） | watchlist 自选股 */
  scope?: "all" | "movers" | "watchlist";
  /** 交易日（YYYY-MM-DD）；留空使用最新交易日。历史日期展示每日异动行情，无舆情分。 */
  date?: string;
  /** 异动标签多选筛选：涨幅大 / 跌幅大 / 成交额大（OR 匹配）。 */
  tags?: string[];
  /** 行业编号或名称。 */
  industry?: string;
  /** 仅显示当前行业舆情热度达到热点门槛的股票。 */
  hotIndustry?: boolean;
  page?: number;
  pageSize?: number;
}

export interface TradeDatesResponse {
  dates: string[];
  latest: string | null;
}

export type ConvertibleBondView = "all" | "upcoming" | "latest";
export type ConvertibleBondSort = "name" | "price" | "pctChange" | "amount" | "conversionValue" | "premiumRate" | "stock" | "rating" | "issueScale" | "listingDate" | "subscriptionDate";

export interface ConvertibleBondItem {
  code: string;
  name: string;
  exchange: "SH" | "SZ";
  price: number | null;
  pctChange: number | null;
  amount: number | null;
  stockCode: string;
  stockName: string;
  stockPrice: number | null;
  stockPctChange: number | null;
  stockAmount: number | null;
  rating: string | null;
  issueScale: number | null;
  subscriptionDate: string | null;
  listingDate: string | null;
  delistingDate: string | null;
  conversionPrice: number | null;
  conversionValue: number | null;
  premiumRate: number | null;
  isLatestTradable: boolean;
  isUpcoming: boolean;
}

export interface ConvertibleBondListResponse {
  view: ConvertibleBondView;
  items: ConvertibleBondItem[];
  total: number;
  page: number;
  pageSize: number;
  asOf: string;
  source: "eastmoney";
}

export type DailyCandidateStatus = "preview" | "frozen" | "unavailable" | "reconstructed";
export type DailyCandidateOrigin = "prospective" | "reconstructed";

export interface DailyCandidateEvidence {
  id: string;
  source: string;
  sourceKind: string;
  publishedAt: string;
  /** 可用时直达已留存的原始证据；缺失时 UI 必须明确显示而非伪造链接。 */
  url?: string;
}

export interface DailyCandidateSnapshot {
  name?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  amount?: number;
  amountHistory?: number[];
  pctChange?: number;
  textDirection?: number;
  textConfidence?: number;
  discussionCount?: number;
  discussionInteractions?: number;
  discussionElapsedMinutes?: number;
  discussionGrowth?: { value?: number; mentionDelta?: number; isComparable?: boolean };
  discussionHistory?: Array<{ count: number; interactions: number; elapsedMinutes: number; verified: boolean }>;
  industry?: { name?: string; textHeat?: number; relation?: string } | null;
  events?: DailyCandidateEvidence[];
  [key: string]: unknown;
}

export interface DailyCandidateEntryResponse {
  code: string;
  rank: number;
  grade: "A" | "B";
  isHotIndustry: boolean;
  baseScore: number;
  overheatPenalty: number;
  finalScore: number;
  scores: Record<string, number>;
  snapshot: DailyCandidateSnapshot;
  reasons: string[];
  nextDayTrend: {
    direction: "up";
    label: "强看涨" | "偏多";
    /** 综合信号分，不是上涨概率。 */
    signalScore: number;
    targetTradeDate: string | null;
    actual: null | {
      tradeDate: string;
      pctChange: number;
      status: "matched" | "missed" | "flat";
      phase: "intraday" | "closed";
      observedAt: string;
    };
  };
}

export interface DailyFocusLiveItemResponse {
  code: string;
  name: string;
  rank: number;
  pctChange: number;
  amount: number;
  textDirection: number | null;
  discussionCount: number;
  industryName: string | null;
  liveScore: number;
  scores: { turnover: number; direction: number; discussion: number; price: number; industry: number; reliability: number };
  state: "awaiting-history";
  reasons: string[];
}

export interface DailyCandidateOutcomeResponse {
  signalTradeDate: string;
  code: string;
  horizon: 3;
  status: "observing" | "completed" | "unavailable";
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
  dataAsOf: string | null;
  completedAt: string | null;
  reason: string | null;
}

export interface DailyCandidatesResponse {
  tradeDate: string;
  methodologyVersion: string;
  status: DailyCandidateStatus;
  origin: DailyCandidateOrigin;
  featureCutoff: string;
  marketAsOf: string | null;
  clueAsOf: string | null;
  frozenAt: string | null;
  items: DailyCandidateEntryResponse[];
  /** 盘中正式候选不足时的实时关注列表；不计入冻结名单或历史表现。 */
  liveFocusItems?: DailyFocusLiveItemResponse[];
  /** 每只候选的 T+3 只读结算状态；列表 origin/status 不因 outcome 改写。 */
  outcomes: DailyCandidateOutcomeResponse[];
  dataQuality: Record<string, unknown>;
  exclusionCounts: Record<string, number>;
  reason: string | null;
}

export interface DailyCandidatePerformanceResponse {
  window: 20 | 60;
  methodologyVersion: string | null;
  costBps: number;
  sampleDays: number;
  sampleStage: "accumulating" | "exploratory" | "mature";
  dailyEqualWeightMarketExcess: number | null;
  averageMarketExcess: number | null;
  netAverageMarketExcess: number | null;
  hitRate: number | null;
  medianMarketExcess: number | null;
  groups: { A: number | null; B: number | null; hotIndustry: number | null; nonHotIndustry: number | null };
  confidenceInterval: { low: number; high: number; blockDays: 3 } | null;
}

export type DailyFocusPoolTrendDirection = "strong-up" | "up" | "weakening" | "repairing" | "down" | "flat" | "insufficient";
export type DailyFocusPoolWindowSessions = 2 | 3 | 4 | 5;

export interface DailyFocusPoolItemResponse {
  code: string;
  name: string;
  focusDates: string[];
  consecutiveDays: 1 | 2 | 3 | 4 | 5;
  firstFocusDate: string;
  lastFocusDate: string;
  sessionsSinceFocus: number;
  isHotIndustry: boolean;
  industries: Array<{ code: string; name: string; hot: boolean; source: "primary" | "clue" }>;
  dailyChanges: Array<{ tradeDate: string; price: number | null; pctChange: number | null }>;
  priceHistory: Array<{ tradeDate: string; price: number; pctChange: number | null; amount: number | null }>;
  entryPrice: number | null;
  latestPrice: number | null;
  windowPctChange: number | null;
  upDays: number;
  downDays: number;
  flatDays: number;
  trend: { direction: DailyFocusPoolTrendDirection; label: string; summary: string };
}

export interface DailyFocusPoolResponse {
  window: { start: string | null; end: string | null; tradeDates: string[]; sessions: DailyFocusPoolWindowSessions; maxSessions: 5 };
  asOf: string | null;
  items: DailyFocusPoolItemResponse[];
  stats: {
    total: number;
    priced: number;
    up: number;
    down: number;
    flat: number;
    upRatio: number | null;
    downRatio: number | null;
    hotIndustry: number;
    hotIndustryRatio: number | null;
  };
}

export const api = {
  dashboard: (signal?: AbortSignal) => request<DashboardData>("/api/dashboard", { signal }),
  industries: (params: { query?: string; hotOnly?: boolean; relation?: string } = {}, signal?: AbortSignal) => {
    const search = new URLSearchParams();
    if (params.query) search.set("q", params.query);
    if (params.hotOnly) search.set("hot_only", "1");
    if (params.relation) search.set("relation", params.relation);
    return request<IndustryAnalyticsResponse>(`/api/industries?${search}`, { signal });
  },
  stocks: (query: StockQuery = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.signal && query.signal !== "all") params.set("signal", query.signal);
    if (query.market && query.market !== "all") params.set("market", query.market);
    if (query.sort) params.set("sort", query.sort);
    if (query.scope && query.scope !== "all") params.set("scope", query.scope);
    if (query.date) params.set("date", query.date);
    if (query.tags?.length) params.set("tags", query.tags.join(","));
    if (query.industry) params.set("industry", query.industry);
    if (query.hotIndustry) params.set("hot_industry", "1");
    params.set("page", String(query.page ?? 1));
    params.set("page_size", String(query.pageSize ?? 50));
    return request<StockListResponse>(`/api/stocks?${params}`, { signal });
  },
  stock: (code: string, signal?: AbortSignal) => request<StockDetailResponse>(`/api/stocks/${encodeURIComponent(code)}`, { signal }),
  kline: (code: string, period: KlinePeriod, signal?: AbortSignal) => request<KlineResponse>(`/api/stocks/${encodeURIComponent(code)}/kline?period=${period}`, { signal }),
  events: () => request<EventsResponse>("/api/events"),
  tradeDates: (signal?: AbortSignal) => request<TradeDatesResponse>("/api/trade-dates", { signal }),
  convertibleBonds: (query: { view?: ConvertibleBondView; q?: string; sort?: ConvertibleBondSort | `-${ConvertibleBondSort}`; page?: number; pageSize?: number } = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams({
      view: query.view ?? "all",
      page: String(query.page ?? 1),
      page_size: String(query.pageSize ?? 50),
    });
    if (query.q) params.set("q", query.q);
    if (query.sort) params.set("sort", query.sort);
    return request<ConvertibleBondListResponse>(`/api/convertible-bonds?${params}`, { signal });
  },
  dailyCandidates: (date?: string, signal?: AbortSignal) => request<DailyCandidatesResponse>(`/api/daily-candidates${date ? `?date=${encodeURIComponent(date)}` : ""}`, { signal }),
  dailyCandidatePerformance: (window: 20 | 60 = 20, costBps = 0, signal?: AbortSignal) => request<DailyCandidatePerformanceResponse>(`/api/daily-candidates/performance?window=${window}&cost_bps=${encodeURIComponent(String(costBps))}`, { signal }),
  dailyFocusPool: (sessions: DailyFocusPoolWindowSessions = 5, signal?: AbortSignal) => request<DailyFocusPoolResponse>(`/api/daily-focus-pool?sessions=${sessions}`, { signal }),
  system: (signal?: AbortSignal) => request<SystemStatus>("/api/system", { signal }),
  refreshSystem: (signal?: AbortSignal) => request<SystemStatus>("/api/system/refresh", { method: "POST", signal }),
  sourceDiscussions: (source: DiscussionSourceId, page = 1, signal?: AbortSignal) => request<SourceDiscussionsResponse>(`/api/system/discussions?source=${encodeURIComponent(source)}&page=${page}`, { signal }),
  watchlist: () => request<WatchlistResponse>("/api/watchlist"),
  addWatchlist: (code: string) => request<WatchlistResponse>(`/api/watchlist/${encodeURIComponent(code)}`, { method: "PUT" }),
  removeWatchlist: (code: string) => request<WatchlistResponse>(`/api/watchlist/${encodeURIComponent(code)}`, { method: "DELETE" }),
};
