const EASTMONEY_BOND_ENDPOINT = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36";
const PAGE_SIZE = 500;
const CACHE_TTL_MS = 5 * 60_000;

export type ConvertibleBondView = "all" | "upcoming" | "latest";
export const convertibleBondSorts = ["name", "price", "pctChange", "amount", "conversionValue", "premiumRate", "stock", "rating", "issueScale", "listingDate", "subscriptionDate"] as const;
export type ConvertibleBondSort = typeof convertibleBondSorts[number];

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
  /** 上市日处于当前交易日往前一个自然月内，且当前仍可交易。 */
  isLatestTradable: boolean;
  /** 已披露申购日但尚未上市的转债。 */
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

interface BondCache {
  items: ConvertibleBondItem[];
  asOf: string;
  expiresAt: number;
}

interface EastMoneyBondPayload {
  success?: boolean;
  code?: number;
  result?: {
    pages?: unknown;
    count?: unknown;
    data?: unknown;
  } | null;
}

let cache: BondCache | null = null;

export async function getConvertibleBonds(input: {
  view?: ConvertibleBondView;
  query?: string;
  /** Sort key; a leading minus requests ascending order. */
  sort?: string;
  page?: number;
  pageSize?: number;
  now?: Date;
  signal?: AbortSignal;
} = {}): Promise<ConvertibleBondListResponse> {
  const view = input.view ?? "all";
  const query = (input.query ?? "").trim().toLowerCase();
  const sort = normalizeSort(input.sort, view);
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageSize = Math.min(100, Math.max(10, Math.trunc(input.pageSize ?? 50)));
  const now = input.now ?? new Date();
  const snapshot = await loadBondSnapshot(now, input.signal);
  const today = shanghaiDate(now);
  const recentListingStart = oneMonthEarlier(today);
  const active = snapshot.items
    .filter((item) => isTradable(item, today))
    .map((item) => ({ ...item, isLatestTradable: item.listingDate !== null && item.listingDate >= recentListingStart, isUpcoming: false }));
  const upcoming = snapshot.items.filter((item) => (
    item.subscriptionDate !== null
    && item.subscriptionDate >= today
    && item.listingDate === null
    && item.delistingDate === null
  )).map((item) => ({ ...item, isLatestTradable: false, isUpcoming: true }));

  let items = view === "upcoming" ? upcoming : view === "latest" ? active.filter((item) => item.isLatestTradable) : [...active, ...upcoming];
  if (query) {
    items = items.filter((item) => `${item.code}${item.name}${item.stockCode}${item.stockName}${item.rating ?? ""}`.toLowerCase().includes(query));
  }
  items = [...items].sort((left, right) => compareBySort(left, right, sort));
  const total = items.length;
  const start = (page - 1) * pageSize;

  return {
    view,
    items: items.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    asOf: snapshot.asOf,
    source: "eastmoney",
  };
}

async function loadBondSnapshot(now: Date, signal?: AbortSignal): Promise<BondCache> {
  if (cache && cache.expiresAt > now.valueOf()) return cache;
  const first = await fetchBondPage(1, signal);
  const pageCount = Math.max(1, number(first.result?.pages) ?? 1);
  const remaining = await Promise.all(Array.from(
    { length: pageCount - 1 },
    (_, index) => fetchBondPage(index + 2, signal),
  ));
  const rows = [first, ...remaining].flatMap((payload) => normalizeRows(payload.result?.data));
  const unique = new Map<string, ConvertibleBondItem>();
  for (const row of rows) {
    const item = parseBond(row);
    if (item) unique.set(item.code, item);
  }
  if (!unique.size) throw new Error("东方财富可转债接口没有返回可解析的数据");
  const asOf = now.toISOString();
  cache = { items: [...unique.values()], asOf, expiresAt: now.valueOf() + CACHE_TTL_MS };
  return cache;
}

async function fetchBondPage(page: number, signal?: AbortSignal): Promise<EastMoneyBondPayload> {
  const params = new URLSearchParams({
    sortColumns: "SECURITY_CODE",
    sortTypes: "-1",
    pageSize: String(PAGE_SIZE),
    pageNumber: String(page),
    reportName: "RPT_BOND_CB_LIST",
    columns: "ALL",
    quoteColumns: [
      "f2~01~CONVERT_STOCK_CODE~CONVERT_STOCK_PRICE",
      "f3~01~CONVERT_STOCK_CODE~CONVERT_STOCK_CHANGE_RATE",
      "f6~01~CONVERT_STOCK_CODE~CONVERT_STOCK_TURNOVERVALUE",
      "f2~10~SECURITY_CODE~CURRENT_BOND_PRICE",
      "f3~10~SECURITY_CODE~CHANGE_RATE",
      "f6~10~SECURITY_CODE~TURNOVERVALUE",
      "f235~10~SECURITY_CODE~TRANSFER_PRICE",
      "f236~10~SECURITY_CODE~TRANSFER_VALUE",
      "f237~10~SECURITY_CODE~TRANSFER_PREMIUM_RATIO",
    ].join(","),
    source: "WEB",
    client: "WEB",
  });
  const timeout = AbortSignal.timeout(12_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(`${EASTMONEY_BOND_ENDPOINT}?${params}`, {
    headers: {
      accept: "application/json,text/plain,*/*",
      referer: "https://data.eastmoney.com/kzz/",
      "user-agent": USER_AGENT,
    },
    signal: combinedSignal,
  });
  if (!response.ok) throw new Error(`东方财富可转债接口返回状态 ${response.status}`);
  const payload = await response.json() as EastMoneyBondPayload;
  if (payload.success !== true || payload.code !== 0 || !payload.result) {
    throw new Error(`东方财富可转债第 ${page} 页数据异常`);
  }
  return payload;
}

function parseBond(row: Record<string, unknown>): ConvertibleBondItem | null {
  const code = text(row.SECURITY_CODE);
  const name = text(row.SECURITY_NAME_ABBR);
  const stockCode = text(row.CONVERT_STOCK_CODE);
  if (!/^\d{6}$/.test(code) || !name || !/^\d{6}$/.test(stockCode)) return null;
  const secucode = text(row.SECUCODE);
  return {
    code,
    name,
    exchange: secucode.endsWith(".SH") || code.startsWith("11") ? "SH" : "SZ",
    price: number(row.CURRENT_BOND_PRICE) ?? number(row.CURRENT_BOND_PRICENEW),
    pctChange: number(row.CHANGE_RATE),
    amount: number(row.TURNOVERVALUE),
    stockCode,
    stockName: text(row.SECURITY_SHORT_NAME),
    stockPrice: number(row.CONVERT_STOCK_PRICE),
    stockPctChange: number(row.CONVERT_STOCK_CHANGE_RATE),
    stockAmount: number(row.CONVERT_STOCK_TURNOVERVALUE),
    rating: text(row.RATING) || null,
    issueScale: number(row.ACTUAL_ISSUE_SCALE),
    subscriptionDate: date(row.PUBLIC_START_DATE),
    listingDate: date(row.LISTING_DATE),
    delistingDate: date(row.DELIST_DATE),
    conversionPrice: number(row.TRANSFER_PRICE) ?? number(row.INITIAL_TRANSFER_PRICE),
    conversionValue: number(row.TRANSFER_VALUE),
    premiumRate: number(row.TRANSFER_PREMIUM_RATIO),
    isLatestTradable: false,
    isUpcoming: false,
  };
}

function isTradable(item: ConvertibleBondItem, today: string) {
  return item.listingDate !== null
    && item.listingDate <= today
    && (item.delistingDate === null || item.delistingDate >= today);
}

function normalizeSort(value: string | undefined, view: ConvertibleBondView): { key: ConvertibleBondSort; ascending: boolean } {
  const fallback = view === "upcoming" ? "-subscriptionDate" : view === "latest" ? "listingDate" : "amount";
  const raw = value || fallback;
  const key = raw.replace(/^-/, "") as ConvertibleBondSort;
  if (!convertibleBondSorts.includes(key)) return normalizeSort(undefined, view);
  return { key, ascending: raw.startsWith("-") };
}

function compareBySort(left: ConvertibleBondItem, right: ConvertibleBondItem, sort: { key: ConvertibleBondSort; ascending: boolean }) {
  const direction = sort.ascending ? 1 : -1;
  const textValue = (item: ConvertibleBondItem) => {
    if (sort.key === "name") return item.name;
    if (sort.key === "stock") return `${item.stockName}${item.stockCode}`;
    if (sort.key === "rating") return item.rating;
    if (sort.key === "listingDate") return item.listingDate;
    if (sort.key === "subscriptionDate") return item.subscriptionDate;
    return null;
  };
  const numberValue = (item: ConvertibleBondItem) => {
    if (sort.key === "price") return item.price;
    if (sort.key === "pctChange") return item.pctChange;
    if (sort.key === "amount") return item.amount;
    if (sort.key === "conversionValue") return item.conversionValue;
    if (sort.key === "premiumRate") return item.premiumRate;
    if (sort.key === "issueScale") return item.issueScale;
    return null;
  };
  const leftText = textValue(left);
  const rightText = textValue(right);
  const isTextSort = leftText !== null || rightText !== null;
  const leftValue = isTextSort ? leftText : numberValue(left);
  const rightValue = isTextSort ? rightText : numberValue(right);
  const comparison = isTextSort
    ? compareNullableText(leftText, rightText)
    : compareNullableNumber(numberValue(left), numberValue(right));
  // 无行情/日期的待交易标的始终排在有值数据之后，避免降序时空值跃到列表顶部。
  const keepsNullLast = leftValue === null || rightValue === null;
  return comparison * (keepsNullLast ? 1 : direction) || left.code.localeCompare(right.code);
}

function compareNullableText(left: string | null, right: string | null) {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return left.localeCompare(right, "zh-Hans-CN", { numeric: true });
}

function compareNullableNumber(left: number | null, right: number | null) {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return left - right;
}

export function isConvertibleBondSort(value: string) {
  return convertibleBondSorts.includes(value.replace(/^-/, "") as ConvertibleBondSort);
}

function normalizeRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function number(value: unknown): number | null {
  if (value === "" || value === null || value === undefined || value === "-") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function date(value: unknown): string | null {
  const candidate = text(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === candidate ? candidate : null;
}

function shanghaiDate(now: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function oneMonthEarlier(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const targetMonthIndex = month - 2;
  const targetYear = targetMonthIndex < 0 ? year - 1 : year;
  const targetMonth = (targetMonthIndex + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

export function clearConvertibleBondCacheForTests() {
  cache = null;
}
