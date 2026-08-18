const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36";
const PRIMARY_MARKET_BASE = "https://push2.eastmoney.com";
const DELAYED_MARKET_BASE = "https://push2delay.eastmoney.com";
const HISTORY_BASE = "https://push2his.eastmoney.com";
/** 部分网络环境会整体拒绝 push2his 的连接（TLS 握手后空回复），此时历史 K 线改由腾讯行情镜像回填。 */
const TENCNET_DAILY_BASE = "https://web.ifzq.gtimg.cn";
const TENCENT_MINUTE_BASE = "https://ifzq.gtimg.cn";
const EASTMONEY_TOKEN = "bd1d9ddb04089700cf9c27f6f7426281";
const HISTORY_TOKEN = "fa5fd1943c7b386f172d6893dbfba10b";
const A_SHARE_FILTER = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";
const MARKET_FIELDS = "f2,f3,f5,f6,f8,f12,f13,f14,f15,f16,f17,f18,f20,f124";
const MINIMUM_A_SHARE_COUNT = 4_000;

export type EastMoneyExchange = "SH" | "SZ" | "BJ";
export type EastMoneyMarketName = "沪市" | "深市" | "北交所";
export type EastMoneyEndpointTier = "primary" | "delayed";
export type EastMoneyAdjustment = "none" | "forward" | "backward";
/** K 线数据可能来自东方财富原生历史主机，或网络受限时由腾讯行情镜像回填（内容同为交易所公开行情）。 */
export type EastMoneyKlineProvider = "eastmoney" | "tencent-mirror";

export interface EastMoneyMarketQuote {
  code: string;
  name: string;
  exchange: EastMoneyExchange;
  market: EastMoneyMarketName;
  price: number | null;
  pctChange: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  volume: number | null;
  amount: number | null;
  turnover: number | null;
  marketCap: number | null;
  quoteAt: string;
  tradeDate: string;
  quoteUrl: string;
  provider: "eastmoney";
  sourceTier: EastMoneyEndpointTier;
}

export interface EastMoneyMarketSnapshot {
  provider: "eastmoney";
  sourceTier: EastMoneyEndpointTier;
  endpoint: string;
  expectedCount: number;
  fetchedAt: string;
  quoteAt: string;
  tradeDate: string;
  items: EastMoneyMarketQuote[];
}

export interface EastMoneyDailyBar {
  code: string;
  name: string;
  exchange: EastMoneyExchange;
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  amount: number | null;
  amplitude: number | null;
  pctChange: number | null;
  change: number | null;
  turnover: number | null;
  adjustment: EastMoneyAdjustment;
  provider: EastMoneyKlineProvider;
  fetchedAt: string;
}

export interface EastMoneyDailyBarResult {
  provider: EastMoneyKlineProvider;
  endpoint: string;
  code: string;
  name: string;
  exchange: EastMoneyExchange;
  adjustment: EastMoneyAdjustment;
  fetchedAt: string;
  items: EastMoneyDailyBar[];
}

export type EastMoneyMinutePeriod = 1 | 5 | 15 | 30 | 60;

export interface EastMoneyMinuteBar {
  code: string;
  name: string;
  exchange: EastMoneyExchange;
  /** 分钟线时间点，如 2026-08-17 14:00（Asia/Shanghai）。 */
  tradeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  amount: number | null;
  adjustment: EastMoneyAdjustment;
  period: EastMoneyMinutePeriod;
  provider: EastMoneyKlineProvider;
  fetchedAt: string;
}

export interface EastMoneyMinuteBarResult {
  provider: EastMoneyKlineProvider;
  endpoint: string;
  code: string;
  name: string;
  exchange: EastMoneyExchange;
  adjustment: EastMoneyAdjustment;
  period: EastMoneyMinutePeriod;
  fetchedAt: string;
  items: EastMoneyMinuteBar[];
}

export interface FetchMarketOptions {
  pageSize?: number;
  concurrency?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FetchDailyBarsOptions {
  code: string;
  start?: string;
  end?: string;
  limit?: number;
  adjustment?: EastMoneyAdjustment;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FetchMinuteBarsOptions {
  code: string;
  period?: EastMoneyMinutePeriod;
  start?: string;
  end?: string;
  limit?: number;
  adjustment?: EastMoneyAdjustment;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type EastMoneyKlinePeriod = "day" | "week" | "month";

export interface EastMoneyPeriodBar {
  code: string;
  name: string;
  exchange: EastMoneyExchange;
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  amount: number | null;
  adjustment: EastMoneyAdjustment;
  provider: EastMoneyKlineProvider;
  fetchedAt: string;
}

export interface EastMoneyPeriodBarResult {
  provider: EastMoneyKlineProvider;
  endpoint: string;
  code: string;
  name: string;
  exchange: EastMoneyExchange;
  period: EastMoneyKlinePeriod;
  adjustment: EastMoneyAdjustment;
  fetchedAt: string;
  items: EastMoneyPeriodBar[];
}

export interface FetchPeriodBarsOptions {
  code: string;
  period: EastMoneyKlinePeriod;
  start?: string;
  end?: string;
  limit?: number;
  adjustment?: EastMoneyAdjustment;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface EastMoneyTrendPoint {
  /** 当日时间点 HH:MM（Asia/Shanghai）。 */
  time: string;
  price: number;
  volume: number | null;
  avgPrice: number | null;
}

export interface EastMoneyTrendResult {
  provider: "eastmoney";
  endpoint: string;
  code: string;
  name: string;
  previousClose: number | null;
  fetchedAt: string;
  items: EastMoneyTrendPoint[];
}

export interface FetchTrendsOptions {
  code: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface MarketPage {
  total: number;
  rows: Array<Record<string, unknown>>;
}

/**
 * Fetches the complete Shanghai, Shenzhen and Beijing A-share universe.
 * The primary real-time host is tried first. Any transport, payload or
 * completeness failure retries the entire snapshot against the delayed host.
 */
export async function fetchEastMoneyMarketSnapshot(
  options: FetchMarketOptions = {},
): Promise<EastMoneyMarketSnapshot> {
  let primaryError: unknown;
  try {
    return await fetchSnapshotFrom(PRIMARY_MARKET_BASE, "primary", options);
  } catch (error) {
    primaryError = error;
  }

  try {
    return await fetchSnapshotFrom(DELAYED_MARKET_BASE, "delayed", options);
  } catch (delayedError) {
    throw new AggregateError(
      [primaryError, delayedError],
      `东方财富全市场行情主接口与延迟备选接口均不可用：${errorMessage(primaryError)}；${errorMessage(delayedError)}`,
    );
  }
}

/**
 * Fetches unadjusted or explicitly adjusted daily K-lines for one A-share.
 * The EastMoney history host is tried first; when the network rejects it, the
 * request falls back to the Tencent quote mirror (same exchange public data).
 */
export async function fetchEastMoneyDailyBars(
  options: FetchDailyBarsOptions,
): Promise<EastMoneyDailyBarResult> {
  const result = await fetchEastMoneyPeriodBars({ ...options, period: "day" });
  return {
    provider: result.provider,
    endpoint: result.endpoint,
    code: result.code,
    name: result.name,
    exchange: result.exchange,
    adjustment: result.adjustment,
    fetchedAt: result.fetchedAt,
    items: result.items.map((bar) => ({
      ...bar,
      amplitude: null,
      pctChange: null,
      change: null,
      turnover: null,
    })),
  };
}

/**
 * Fetches daily / weekly / monthly K-lines for one A-share with the same
 * dual-source fallback as the daily endpoint.
 */
export async function fetchEastMoneyPeriodBars(
  options: FetchPeriodBarsOptions,
): Promise<EastMoneyPeriodBarResult> {
  const code = normalizeCode(options.code);
  const period = options.period;
  const adjustment = options.adjustment ?? "none";
  const start = normalizeDateKey(options.start ?? "0", "start");
  const end = normalizeDateKey(options.end ?? "20500101", "end");
  const limit = Math.min(5_000, Math.max(1, Math.trunc(options.limit ?? 250)));
  const timeoutMs = options.timeoutMs ?? 12_000;
  const fetchedAt = new Date().toISOString();
  const exchange = exchangeFor(code);
  const klt = period === "day" ? "101" : period === "week" ? "102" : "103";
  const periodLabel = period === "day" ? "日" : period === "week" ? "周" : "月";

  let primaryError: unknown;
  try {
    const params = klineParams(code, { adjustment, start, end, limit, klt });
    const payload = await fetchKlineFrom(HISTORY_BASE, params, timeoutMs, options.signal);
    if (payload.rc !== 0 || !payload.data || !Array.isArray(payload.data.klines)) {
      throw new Error(`东方财富未返回 ${code} 的有效${periodLabel} K 数据`);
    }
    const items = payload.data.klines
      .map((value) => parsePeriodBar(String(value), code, String(payload.data!.name ?? "").trim(), exchange, adjustment, "eastmoney", fetchedAt))
      .filter((bar): bar is EastMoneyPeriodBar => bar !== null)
      .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
    if (!items.length) throw new Error(`东方财富返回的 ${code} ${periodLabel} K 数据无法解析`);
    return {
      provider: "eastmoney",
      endpoint: payload.endpoint,
      code,
      name: items[0].name,
      exchange,
      period,
      adjustment,
      fetchedAt,
      items,
    };
  } catch (error) {
    primaryError = error;
  }

  try {
    const rows = await fetchTencentBars(code, { period, start, end, limit, adjustment, timeoutMs, signal: options.signal });
    const items = rows
      .map((row) => parseTencentPeriodBar(row, code, exchange, adjustment, fetchedAt))
      .filter((bar): bar is EastMoneyPeriodBar => bar !== null)
      .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
    if (!items.length) throw new Error(`腾讯行情镜像未返回 ${code} 的${periodLabel} K 数据`);
    return {
      provider: "tencent-mirror",
      endpoint: `${TENCNET_DAILY_BASE}/appstock/app/fqkline/get`,
      code,
      name: items[0].name,
      exchange,
      period,
      adjustment,
      fetchedAt,
      items,
    };
  } catch (mirrorError) {
    throw new AggregateError(
      [primaryError, mirrorError],
      `东方财富历史${periodLabel}线与腾讯行情镜像均不可用：${errorMessage(primaryError)}；${errorMessage(mirrorError)}`,
    );
  }
}

/**
 * Fetches intraday minute bars (1/5/15/30/60 minutes) for one A-share.
 * Uses the EastMoney K-line endpoint, falling back to the Tencent mirror.
 */
export async function fetchEastMoneyMinuteBars(
  options: FetchMinuteBarsOptions,
): Promise<EastMoneyMinuteBarResult> {
  const code = normalizeCode(options.code);
  const adjustment = options.adjustment ?? "none";
  const period = minutePeriod(options.period ?? 60);
  const start = normalizeDateKey(options.start ?? "0", "start");
  const end = normalizeDateKey(options.end ?? "20500101", "end");
  const limit = Math.min(2_000, Math.max(1, Math.trunc(options.limit ?? 120)));
  const timeoutMs = options.timeoutMs ?? 12_000;
  const fetchedAt = new Date().toISOString();
  const exchange = exchangeFor(code);
  const name = "";

  let primaryError: unknown;
  try {
    const params = klineParams(code, { adjustment, start, end, limit, klt: String(period) });
    const payload = await fetchKlineFrom(HISTORY_BASE, params, timeoutMs, options.signal);
    if (payload.rc !== 0 || !payload.data || !Array.isArray(payload.data.klines)) {
      throw new Error(`东方财富未返回 ${code} 的有效分钟 K 数据`);
    }
    const items = payload.data.klines
      .map((value) => parseMinuteBar(String(value), code, String(payload.data!.name ?? "").trim(), exchange, adjustment, period, "eastmoney", fetchedAt))
      .filter((bar): bar is EastMoneyMinuteBar => bar !== null)
      .sort((a, b) => a.tradeTime.localeCompare(b.tradeTime));
    if (!items.length) throw new Error(`东方财富返回的 ${code} 分钟 K 数据无法解析`);
    return {
      provider: "eastmoney",
      endpoint: payload.endpoint,
      code,
      name: items[0].name,
      exchange,
      adjustment,
      period,
      fetchedAt,
      items,
    };
  } catch (error) {
    primaryError = error;
  }

  try {
    const rows = await fetchTencentMinuteBars(code, { period, limit, timeoutMs, signal: options.signal });
    const items = rows
      .map((row) => parseTencentMinuteBar(row, code, exchange, adjustment, period, fetchedAt))
      .filter((bar): bar is EastMoneyMinuteBar => bar !== null)
      .sort((a, b) => a.tradeTime.localeCompare(b.tradeTime));
    if (!items.length) throw new Error(`腾讯行情镜像未返回 ${code} 的分钟 K 数据`);
    return {
      provider: "tencent-mirror",
      endpoint: `${TENCENT_MINUTE_BASE}/appstock/app/kline/mkline`,
      code,
      name: items[0].name,
      exchange,
      adjustment,
      period,
      fetchedAt,
      items,
    };
  } catch (mirrorError) {
    throw new AggregateError(
      [primaryError, mirrorError],
      `东方财富历史分钟线与腾讯行情镜像均不可用：${errorMessage(primaryError)}；${errorMessage(mirrorError)}`,
    );
  }
}

export function eastMoneyQuoteUrl(code: string): string {
  const normalized = normalizeCode(code);
  return `https://quote.eastmoney.com/${exchangeFor(normalized).toLowerCase()}${normalized}.html`;
}

/**
 * Fetches the realtime intraday trend (one point per minute, with average
 * price line). The primary realtime host is tried first and the delayed host
 * second; both serve the same trends2 payload format.
 */
export async function fetchEastMoneyTrends(
  options: FetchTrendsOptions,
): Promise<EastMoneyTrendResult> {
  const code = normalizeCode(options.code);
  const timeoutMs = options.timeoutMs ?? 12_000;
  const fetchedAt = new Date().toISOString();
  let primaryError: unknown;
  try {
    return await fetchTrendsFrom(PRIMARY_MARKET_BASE, code, timeoutMs, fetchedAt, options.signal);
  } catch (error) {
    primaryError = error;
  }
  try {
    return await fetchTrendsFrom(DELAYED_MARKET_BASE, code, timeoutMs, fetchedAt, options.signal);
  } catch (delayedError) {
    throw new AggregateError(
      [primaryError, delayedError],
      `东方财富分时主接口与延迟备选接口均不可用：${errorMessage(primaryError)}；${errorMessage(delayedError)}`,
    );
  }
}

async function fetchTrendsFrom(
  baseUrl: string,
  code: string,
  timeoutMs: number,
  fetchedAt: string,
  signal?: AbortSignal,
): Promise<EastMoneyTrendResult> {
  const params = new URLSearchParams({
    secid: `${eastMoneyMarketId(code)}.${code}`,
    ut: EASTMONEY_TOKEN,
    fields1: "f1,f2,f3,f7,f8",
    fields2: "f51,f53,f56,f58",
    ndays: "1",
    iscr: "0",
    iscca: "0",
  });
  const endpoint = `${baseUrl}/api/qt/stock/trends2/get`;
  const payload = await fetchJson(`${endpoint}?${params}`, timeoutMs, signal) as {
    rc?: number;
    data?: { name?: unknown; preClose?: unknown; trends?: unknown } | null;
  };
  if (payload.rc !== 0 || !payload.data || !Array.isArray(payload.data.trends)) {
    throw new Error(`东方财富未返回 ${code} 的有效分时数据`);
  }
  const items = payload.data.trends
    .map((value) => parseTrendPoint(String(value)))
    .filter((point): point is EastMoneyTrendPoint => point !== null);
  if (!items.length) throw new Error(`东方财富返回的 ${code} 分时数据无法解析`);
  return {
    provider: "eastmoney",
    endpoint,
    code,
    name: String(payload.data.name ?? "").trim(),
    previousClose: finite(payload.data.preClose),
    fetchedAt,
    items,
  };
}

/** 分时行：YYYY-MM-DD HH:mm,price,volume,avgPrice。 */
function parseTrendPoint(value: string): EastMoneyTrendPoint | null {
  const parts = value.split(",");
  if (parts.length < 2) return null;
  const match = parts[0]?.match(/(\d{2}:\d{2})$/);
  const price = finite(parts[1]);
  if (!match || price === null) return null;
  return {
    time: match[1],
    price,
    volume: finite(parts[2]),
    avgPrice: finite(parts[3]),
  };
}

async function fetchSnapshotFrom(
  baseUrl: string,
  sourceTier: EastMoneyEndpointTier,
  options: FetchMarketOptions,
): Promise<EastMoneyMarketSnapshot> {
  const pageSize = Math.min(500, Math.max(50, Math.trunc(options.pageSize ?? 100)));
  const concurrency = Math.min(8, Math.max(1, Math.trunc(options.concurrency ?? 6)));
  const timeoutMs = options.timeoutMs ?? 12_000;
  const first = await fetchMarketPage(baseUrl, 1, pageSize, timeoutMs, options.signal);
  if (first.total < MINIMUM_A_SHARE_COUNT) {
    throw new Error(`东方财富全市场总数异常：${first.total}`);
  }

  const pageCount = Math.ceil(first.total / pageSize);
  const rows = [...first.rows];
  for (let page = 2; page <= pageCount; page += concurrency) {
    const count = Math.min(concurrency, pageCount - page + 1);
    const pages = await Promise.all(Array.from(
      { length: count },
      (_, index) => fetchMarketPage(baseUrl, page + index, pageSize, timeoutMs, options.signal),
    ));
    rows.push(...pages.flatMap((item) => item.rows));
  }

  const fetchedAt = new Date().toISOString();
  const parsed = rows
    .map((row) => parseQuote(row, sourceTier, fetchedAt))
    .filter((quote): quote is EastMoneyMarketQuote => quote !== null);
  const unique = new Map(parsed.map((quote) => [quote.code, quote]));
  if (unique.size < MINIMUM_A_SHARE_COUNT) {
    throw new Error(`东方财富完整行情校验失败，仅解析到 ${unique.size} 只股票`);
  }
  if (unique.size < Math.floor(first.total * 0.9)) {
    throw new Error(`东方财富完整行情缺页：预期 ${first.total}，实际 ${unique.size}`);
  }

  const quoteAt = mostRecentIso([...unique.values()].map((quote) => quote.quoteAt), fetchedAt);
  const tradeDate = shanghaiDate(quoteAt);
  const items = [...unique.values()]
    .map((quote) => ({ ...quote, quoteAt: quote.quoteAt || quoteAt, tradeDate }))
    .sort((a, b) => a.code.localeCompare(b.code));
  validateExchangeCoverage(items);

  return {
    provider: "eastmoney",
    sourceTier,
    endpoint: `${baseUrl}/api/qt/clist/get`,
    expectedCount: first.total,
    fetchedAt,
    quoteAt,
    tradeDate,
    items,
  };
}

async function fetchMarketPage(
  baseUrl: string,
  page: number,
  pageSize: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<MarketPage> {
  const params = new URLSearchParams({
    pn: String(page),
    pz: String(pageSize),
    po: "1",
    np: "1",
    ut: EASTMONEY_TOKEN,
    fltt: "2",
    invt: "2",
    fid: "f12",
    fs: A_SHARE_FILTER,
    fields: MARKET_FIELDS,
  });
  const payload = await fetchJson(`${baseUrl}/api/qt/clist/get?${params}`, timeoutMs, signal) as {
    rc?: number;
    data?: { total?: unknown; diff?: unknown } | null;
  };
  const total = Number(payload.data?.total);
  const rows = normalizeDiff(payload.data?.diff);
  if (payload.rc !== 0 || !Number.isFinite(total) || total < 1 || !rows.length) {
    throw new Error(`东方财富行情第 ${page} 页数据异常`);
  }
  return { total, rows };
}

interface KlinePayload {
  rc?: number;
  data?: { code?: string; name?: string; klines?: unknown } | null;
  endpoint: string;
}

interface TencentKlineResponse {
  code?: number;
  data?: Record<string, Record<string, unknown>>;
}

function klineParams(
  code: string,
  input: { adjustment: EastMoneyAdjustment; start: string; end: string; limit: number; klt: string },
) {
  return new URLSearchParams({
    secid: `${eastMoneyMarketId(code)}.${code}`,
    ut: HISTORY_TOKEN,
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    klt: input.klt,
    fqt: adjustmentCode(input.adjustment),
    beg: input.start,
    end: input.end,
    lmt: String(input.limit),
  });
}

async function fetchKlineFrom(
  baseUrl: string,
  params: URLSearchParams,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<KlinePayload> {
  const endpoint = `${baseUrl}/api/qt/stock/kline/get`;
  const payload = await fetchJson(`${endpoint}?${params}`, timeoutMs, signal) as KlinePayload;
  payload.endpoint = endpoint;
  return payload;
}

/** 腾讯行情镜像日/周/月 K（沪深；北交所无数据时抛错交由上层回退缓存）。 */
async function fetchTencentBars(
  code: string,
  input: { period: EastMoneyKlinePeriod; start: string; end: string; limit: number; adjustment: EastMoneyAdjustment; timeoutMs: number; signal?: AbortSignal },
): Promise<Array<Array<unknown>>> {
  const symbol = tencentSymbol(code);
  const fq = input.adjustment === "forward" ? "qfq" : input.adjustment === "backward" ? "hfq" : "";
  const start = input.start === "0" ? "" : input.start.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const end = input.end === "20500101" ? "" : input.end.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const url = `${TENCNET_DAILY_BASE}/appstock/app/fqkline/get?param=${symbol},${input.period},${start},${end},${input.limit},${fq}`;
  const payload = await fetchJson(url, input.timeoutMs, input.signal) as TencentKlineResponse;
  const keys = [input.period, `qfq${input.period}`, `hfq${input.period}`];
  return klineRows(payload, symbol, keys);
}

/** 腾讯行情镜像分钟 K（沪深）。 */
async function fetchTencentMinuteBars(
  code: string,
  input: { period: EastMoneyMinutePeriod; limit: number; timeoutMs: number; signal?: AbortSignal },
): Promise<Array<Array<unknown>>> {
  const symbol = tencentSymbol(code);
  const url = `${TENCENT_MINUTE_BASE}/appstock/app/kline/mkline?param=${symbol},m${input.period},,${input.limit}`;
  const payload = await fetchJson(url, input.timeoutMs, input.signal) as TencentKlineResponse;
  return klineRows(payload, symbol, [`m${input.period}`]);
}

function klineRows(payload: TencentKlineResponse, symbol: string, keys: string[]): Array<Array<unknown>> {
  if (payload.code !== 0 || !payload.data) throw new Error("腾讯行情镜像返回异常");
  const section = payload.data[symbol] ?? payload.data[Object.keys(payload.data)[0] ?? ""];
  for (const key of keys) {
    if (Array.isArray(section?.[key])) return section[key] as Array<Array<unknown>>;
  }
  return [];
}

function tencentSymbol(code: string) {
  const prefix = code.startsWith("6") ? "sh" : /^[489]/.test(code) ? "bj" : "sz";
  return `${prefix}${code}`;
}

async function fetchJson(url: string, timeoutMs: number, externalSignal?: AbortSignal): Promise<unknown> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(url, {
    headers: {
      accept: "application/json,text/plain,*/*",
      referer: "https://quote.eastmoney.com/",
      "user-agent": USER_AGENT,
    },
    signal,
  });
  if (!response.ok) throw new Error(`东方财富行情接口返回状态 ${response.status}`);
  return response.json();
}

function normalizeDiff(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value)) return Object.values(value).filter(isRecord);
  return [];
}

function parseQuote(
  row: Record<string, unknown>,
  sourceTier: EastMoneyEndpointTier,
  fetchedAt: string,
): EastMoneyMarketQuote | null {
  const code = String(row.f12 ?? "").trim();
  const name = String(row.f14 ?? "").trim();
  if (!/^\d{6}$/.test(code) || !name) return null;
  const exchange = exchangeFor(code);
  const timestamp = finite(row.f124);
  const quoteAt = timestamp && timestamp > 0
    ? new Date(timestamp * 1_000).toISOString()
    : fetchedAt;
  return {
    code,
    name,
    exchange,
    market: marketNameFor(exchange),
    price: finite(row.f2),
    pctChange: finite(row.f3),
    open: finite(row.f17),
    high: finite(row.f15),
    low: finite(row.f16),
    previousClose: finite(row.f18),
    volume: finite(row.f5),
    amount: finite(row.f6),
    turnover: finite(row.f8),
    marketCap: finite(row.f20),
    quoteAt,
    tradeDate: shanghaiDate(quoteAt),
    quoteUrl: eastMoneyQuoteUrl(code),
    provider: "eastmoney",
    sourceTier,
  };
}

/** 东财日/周/月 K 行：[date, open, close, high, low, volume, amount, ...]。 */
function parsePeriodBar(
  value: string,
  code: string,
  name: string,
  exchange: EastMoneyExchange,
  adjustment: EastMoneyAdjustment,
  provider: EastMoneyKlineProvider,
  fetchedAt: string,
): EastMoneyPeriodBar | null {
  const parts = value.split(",");
  if (parts.length < 7 || !/^\d{4}-\d{2}-\d{2}$/.test(parts[0] ?? "")) return null;
  const open = finite(parts[1]);
  const close = finite(parts[2]);
  const high = finite(parts[3]);
  const low = finite(parts[4]);
  if (open === null || close === null || high === null || low === null || low > high) return null;
  return {
    code,
    name,
    exchange,
    tradeDate: parts[0],
    open,
    high,
    low,
    close,
    volume: finite(parts[5]),
    amount: finite(parts[6]),
    adjustment,
    provider,
    fetchedAt,
  };
}

/** 腾讯日/周/月 K 行：[date, open, close, high, low, volume]，无成交额字段。 */
function parseTencentPeriodBar(
  row: Array<unknown>,
  code: string,
  exchange: EastMoneyExchange,
  adjustment: EastMoneyAdjustment,
  fetchedAt: string,
): EastMoneyPeriodBar | null {
  const date = String(row[0] ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const open = finite(row[1]);
  const close = finite(row[2]);
  const high = finite(row[3]);
  const low = finite(row[4]);
  const volume = finite(row[5]);
  if (open === null || close === null || high === null || low === null || low > high) return null;
  return {
    code,
    name: "",
    exchange,
    tradeDate: date,
    open,
    high,
    low,
    close,
    volume,
    amount: null,
    adjustment,
    provider: "tencent-mirror",
    fetchedAt,
  };
}

function parseMinuteBar(
  value: string,
  code: string,
  name: string,
  exchange: EastMoneyExchange,
  adjustment: EastMoneyAdjustment,
  period: EastMoneyMinutePeriod,
  provider: EastMoneyKlineProvider,
  fetchedAt: string,
): EastMoneyMinuteBar | null {
  const parts = value.split(",");
  if (parts.length < 7 || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(parts[0] ?? "")) return null;
  const open = finite(parts[1]);
  const close = finite(parts[2]);
  const high = finite(parts[3]);
  const low = finite(parts[4]);
  if (open === null || close === null || high === null || low === null || low > high) return null;
  return {
    code,
    name,
    exchange,
    tradeTime: parts[0],
    open,
    high,
    low,
    close,
    volume: finite(parts[5]),
    amount: finite(parts[6]),
    adjustment,
    period,
    provider,
    fetchedAt,
  };
}

/** 腾讯分钟 K 行：[YYYYMMDDHHmm, open, close, high, low, volume, amount?, ...]。 */
function parseTencentMinuteBar(
  row: Array<unknown>,
  code: string,
  exchange: EastMoneyExchange,
  adjustment: EastMoneyAdjustment,
  period: EastMoneyMinutePeriod,
  fetchedAt: string,
): EastMoneyMinuteBar | null {
  const raw = String(row[0] ?? "");
  if (!/^\d{12}$/.test(raw)) return null;
  const tradeTime = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}`;
  const open = finite(row[1]);
  const close = finite(row[2]);
  const high = finite(row[3]);
  const low = finite(row[4]);
  if (open === null || close === null || high === null || low === null || low > high) return null;
  const amount = typeof row[6] === "number" ? finite(row[6]) : null;
  return {
    code,
    name: "",
    exchange,
    tradeTime,
    open,
    high,
    low,
    close,
    volume: finite(row[5]),
    amount,
    adjustment,
    period,
    provider: "tencent-mirror",
    fetchedAt,
  };
}

function minutePeriod(value: number): EastMoneyMinutePeriod {
  return new Set([1, 5, 15, 30, 60]).has(value) ? value as EastMoneyMinutePeriod : 60;
}

function normalizeCode(code: string) {
  const normalized = code.trim();
  if (!/^\d{6}$/.test(normalized)) throw new Error("股票代码必须是 6 位数字");
  return normalized;
}

function normalizeDateKey(value: string, field: "start" | "end") {
  if (value === "0") return value;
  const normalized = value.replaceAll("-", "");
  if (!/^\d{8}$/.test(normalized)) throw new Error(`${field} 日期必须使用 YYYYMMDD 或 YYYY-MM-DD`);
  return normalized;
}

function adjustmentCode(adjustment: EastMoneyAdjustment) {
  return adjustment === "forward" ? "1" : adjustment === "backward" ? "2" : "0";
}

function eastMoneyMarketId(code: string) {
  return code.startsWith("6") ? "1" : "0";
}

function exchangeFor(code: string): EastMoneyExchange {
  if (/^[489]/.test(code)) return "BJ";
  return code.startsWith("6") ? "SH" : "SZ";
}

function marketNameFor(exchange: EastMoneyExchange): EastMoneyMarketName {
  return exchange === "SH" ? "沪市" : exchange === "SZ" ? "深市" : "北交所";
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || value === "-") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function shanghaiDate(value: string) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date(value));
}

function mostRecentIso(values: string[], fallback: string) {
  const timestamps = values.map((value) => new Date(value).valueOf()).filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : fallback;
}

function validateExchangeCoverage(items: EastMoneyMarketQuote[]) {
  const exchanges = new Set(items.map((item) => item.exchange));
  for (const exchange of ["SH", "SZ", "BJ"] as const) {
    if (!exchanges.has(exchange)) throw new Error(`东方财富完整行情缺少 ${exchange} 市场`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
