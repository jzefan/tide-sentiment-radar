import type {
  DashboardData,
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
  page?: number;
  pageSize?: number;
}

export interface TradeDatesResponse {
  dates: string[];
  latest: string | null;
}

export const api = {
  dashboard: (signal?: AbortSignal) => request<DashboardData>("/api/dashboard", { signal }),
  stocks: (query: StockQuery = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.signal && query.signal !== "all") params.set("signal", query.signal);
    if (query.market && query.market !== "all") params.set("market", query.market);
    if (query.sort) params.set("sort", query.sort);
    if (query.scope && query.scope !== "all") params.set("scope", query.scope);
    if (query.date) params.set("date", query.date);
    if (query.tags?.length) params.set("tags", query.tags.join(","));
    params.set("page", String(query.page ?? 1));
    params.set("page_size", String(query.pageSize ?? 50));
    return request<StockListResponse>(`/api/stocks?${params}`, { signal });
  },
  stock: (code: string, signal?: AbortSignal) => request<StockDetailResponse>(`/api/stocks/${encodeURIComponent(code)}`, { signal }),
  kline: (code: string, period: KlinePeriod, signal?: AbortSignal) => request<KlineResponse>(`/api/stocks/${encodeURIComponent(code)}/kline?period=${period}`, { signal }),
  events: () => request<EventsResponse>("/api/events"),
  tradeDates: (signal?: AbortSignal) => request<TradeDatesResponse>("/api/trade-dates", { signal }),
  system: (signal?: AbortSignal) => request<SystemStatus>("/api/system", { signal }),
  refreshSystem: (signal?: AbortSignal) => request<SystemStatus>("/api/system/refresh", { method: "POST", signal }),
  watchlist: () => request<WatchlistResponse>("/api/watchlist"),
  addWatchlist: (code: string) => request<WatchlistResponse>(`/api/watchlist/${encodeURIComponent(code)}`, { method: "PUT" }),
  removeWatchlist: (code: string) => request<WatchlistResponse>(`/api/watchlist/${encodeURIComponent(code)}`, { method: "DELETE" }),
};
