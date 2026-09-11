import type { SourceKind } from "../src/domain/types.ts";
import { diagLog } from "./diagLog.ts";
import { fetchAuthorizedForumClues, isForumFeedConfigured } from "./forumFeed.ts";
import { fetchUserDiscussionClues, type DiscussionSourceState } from "./userPosts.ts";
import { fetchStockNews } from "./eastMoneyNews.ts";

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36";
export interface RawClue {
  id: string;
  source: string;
  sourceKind: Exclude<SourceKind, "market">;
  title: string;
  summary: string;
  publishedAt: string;
  url: string;
  stockCodes: string[];
  interactionCount: number;
  /** Adapter identity is retained through event derivation for freeze-time authorization. */
  adapterId?: string;
}

interface Cache<T> {
  value: T;
  expiresAt: number;
  updatedAt: string;
  key?: string;
}
interface Timed<T> { value: T; observedAt: string; }
const timed = async <T>(promise: Promise<T>): Promise<Timed<T>> => ({ value: await promise, observedAt: new Date().toISOString() });

export interface LiveClueSourceState {
  id: string;
  role: "discussion" | "authority";
  state: "connected" | "degraded" | "disabled";
  /** The upper boundary proven by the server-side exhausted query, never a fetch timestamp. */
  coveredThrough: string | null;
  /** Latest valid content timestamp returned by the source; this is recency, not coverage. */
  latestContentAt: string | null;
  observedAt: string | null;
  queryFrom: string | null;
  queryTo: string | null;
  /** Exact stock codes for which this adapter proves the exhausted query window. */
  coveredCodes: string[];
  eventIds: string[];
}

/** An adapter may attest a time range only after the server accepted it and pagination reached its lower boundary. */
export interface LiveClueRangeProof {
  kind: "server-window-paginated";
  queryFrom: string;
  queryTo: string;
  cursorExhausted: boolean;
  /** Server-echoed per-code coverage; absence is not permission to infer all requested codes. */
  coveredCodes?: string[];
}

export function buildLiveClueSourceState(input: { id: string; role: LiveClueSourceState["role"]; fulfilled: boolean; observedAt: string | null; queryFrom: string | null; queryTo: string | null; rangeProof?: LiveClueRangeProof | null; items: RawClue[] }): LiveClueSourceState {
  const proof = input.rangeProof;
  const coveredCodes = Array.isArray(proof?.coveredCodes)
    ? [...new Set(proof.coveredCodes.filter((code): code is string => /^\d{6}$/.test(code)))].sort()
    : [];
  const rangeIsProven = Boolean(
    proof?.kind === "server-window-paginated"
      && proof.cursorExhausted
      && proof.queryFrom === input.queryFrom
      && proof.queryTo === input.queryTo
      && input.queryFrom && input.queryTo
      && Number.isFinite(Date.parse(input.queryFrom))
      && Number.isFinite(Date.parse(input.queryTo))
      && Date.parse(input.queryFrom) <= Date.parse(input.queryTo),
  );
  const queryFrom = rangeIsProven && input.queryFrom ? Date.parse(input.queryFrom) : null;
  const queryTo = rangeIsProven && input.queryTo ? Date.parse(input.queryTo) : null;
  // A content timestamp is audit evidence only.  The query's server-confirmed,
  // exhausted upper boundary is the coverage proof; `observedAt` never is.
  const validItems = input.items.filter((item) => {
    const timestamp = Date.parse(item.publishedAt);
    return Number.isFinite(timestamp)
      && (queryFrom === null || timestamp >= queryFrom)
      && (queryTo === null || timestamp <= queryTo);
  });
  // A server response that violates the attested range is internally inconsistent
  // and cannot be used to authorize feature events or close-time readiness.
  const internallyConsistent = validItems.length === input.items.length;
  const proven = rangeIsProven && internallyConsistent && (input.role !== "discussion" || coveredCodes.length > 0);
  const latestContentAt = validItems.map((item) => item.publishedAt).sort().at(-1) ?? null;
  return {
    id: input.id,
    role: input.role,
    state: input.fulfilled ? "connected" : "degraded",
    coveredThrough: proven ? input.queryTo : null,
    latestContentAt: proven ? latestContentAt : null,
    observedAt: input.observedAt,
    queryFrom: proven ? input.queryFrom : null,
    queryTo: proven ? input.queryTo : null,
    coveredCodes: proven ? coveredCodes : [],
    eventIds: proven ? validItems.map((item) => item.id) : [],
  };
}

interface LiveClueBundle {
  items: RawClue[];
  failures: string[];
  forumEnabled: boolean;
  forumSource: string;
  forumLicenseId: string | null;
  forumTermsUrl: string | null;
  discussionSources: DiscussionSourceState[];
  sourceStates: LiveClueSourceState[];
}

let clueCache: Cache<LiveClueBundle> | null = null;

export interface LiveClueMarketWindow {
  tradeDate: string;
  previousTradeDate: string;
  /** Verified D-6 close boundary used to reconstruct five prior comparable discussion windows. */
  discussionQueryFrom?: string;
}

export function announcementQueryDates(tradeDate: string, previousTradeDate: string): { beginTime: string; endTime: string } {
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
  if (!valid(tradeDate) || !valid(previousTradeDate) || previousTradeDate >= tradeDate) throw new Error("公告查询需要相邻的有效交易日");
  return { beginTime: previousTradeDate, endTime: tradeDate };
}

export async function getLiveClues(force = false, watchlist: string[] = [], stockNames?: Map<string, string>, marketWindow?: LiveClueMarketWindow): Promise<LiveClueBundle & { updatedAt: string; cached: boolean }> {
  const focusKey = `${[...watchlist].sort().join(",")}|${marketWindow?.previousTradeDate ?? ""}|${marketWindow?.tradeDate ?? ""}|${marketWindow?.discussionQueryFrom ?? ""}`;
  if (!force && clueCache && clueCache.key === focusKey && clueCache.expiresAt > Date.now()) {
    return { ...clueCache.value, updatedAt: clueCache.updatedAt, cached: true };
  }
  const forumEnabled = isForumFeedConfigured();
  const requestStartedAt = new Date();
  // Prefer the exchange-calendar D-6 close boundary. The longer fallback only
  // applies before enough local trading dates exist; either path still requires
  // the provider to echo the range and prove cursor exhaustion.
  const requestedQueryFrom = marketWindow?.discussionQueryFrom;
  const forumQueryFrom = requestedQueryFrom && Number.isFinite(Date.parse(requestedQueryFrom)) && requestedQueryFrom <= requestStartedAt.toISOString()
    ? requestedQueryFrom
    : new Date(requestStartedAt.valueOf() - 21 * 24 * 3_600_000).toISOString();
  const forumRequestedRange = { queryFrom: forumQueryFrom, queryTo: requestStartedAt.toISOString() };
  diagLog("clues", "五源拉取开始", watchlist.length, "只");
  const allSettledAt = Date.now();
  const [news, stockNews, announcements, forum, discussions] = await Promise.allSettled([
    timed(fetchFastNews()), timed(fetchStockNews(watchlist, stockNames ?? new Map())), timed(fetchAnnouncements(marketWindow ? announcementQueryDates(marketWindow.tradeDate, marketWindow.previousTradeDate) : undefined)), timed(fetchAuthorizedForumClues(watchlist, forumRequestedRange)), timed(fetchUserDiscussionClues(watchlist, force, stockNames)),
  ]);
  const settled = (result: PromiseSettledResult<unknown>) => (result.status === "fulfilled" ? "ok" : "fail");
  diagLog("clues", "五源就绪", `${(Date.now() - allSettledAt) / 1000}s`, `news=${settled(news)}`, `stockNews=${settled(stockNews)}`, `announcements=${settled(announcements)}`, `forum=${settled(forum)}`, `discussions=${settled(discussions)}`);
  const failures: string[] = [];
  const items: RawClue[] = [];
  const tagged = (adapterId: string, values: RawClue[]) => values.map((item) => ({ ...item, adapterId }));
  if (news.status === "fulfilled") items.push(...tagged("eastmoney-fast-news", news.value.value));
  else failures.push("财经快讯");
  if (stockNews.status === "fulfilled") items.push(...tagged("eastmoney-stock-news", stockNews.value.value));
  else failures.push("个股新闻");
  if (announcements.status === "fulfilled") items.push(...tagged("eastmoney-announcements", announcements.value.value.items));
  else failures.push("公司公告");
  let forumSource = "论坛舆情 · 待授权接入";
  let forumLicenseId: string | null = null;
  let forumTermsUrl: string | null = null;
  if (forum.status === "fulfilled") {
    items.push(...tagged("authorized-forum", forum.value.value.items));
    forumSource = forum.value.value.sourceName;
    forumLicenseId = forum.value.value.licenseId;
    forumTermsUrl = forum.value.value.termsUrl;
  } else if (forumEnabled) failures.push("授权论坛源");
  let discussionSources: DiscussionSourceState[] = [];
  if (discussions.status === "fulfilled") {
    items.push(...tagged("user-discussions", discussions.value.value.items));
    failures.push(...discussions.value.value.failures);
    discussionSources = discussions.value.value.sources;
  } else {
    failures.push("真实用户讨论");
  }
  const deduplicated = items
    .filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id || (item.url && item.url === candidate.url)) === index)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  if (!deduplicated.length) {
    if (clueCache) return { ...clueCache.value, updatedAt: clueCache.updatedAt, cached: true };
    throw new Error("实时线索源均未返回数据");
  }
  const updatedAt = new Date().toISOString();
  const sourceState = (id: string, role: LiveClueSourceState["role"], result: PromiseSettledResult<Timed<unknown>>, sourceItems: RawClue[], queryFrom: string | null, queryTo: string | null, rangeProof: LiveClueRangeProof | null = null): LiveClueSourceState => {
    const observedAt = result.status === "fulfilled" ? result.value.observedAt : null;
    return buildLiveClueSourceState({ id, role, fulfilled: result.status === "fulfilled", observedAt, queryFrom, queryTo, rangeProof, items: sourceItems });
  };
  const announcementRange = announcements.status === "fulfilled" ? announcements.value.value.range : null;
  const sourceStates = [
    // These adapters locally trim first-page/current-feed responses; they have no server time
    // window + cursor proof, so remain deliberately non-covering.
    sourceState("eastmoney-fast-news", "authority", news, news.status === "fulfilled" ? tagged("eastmoney-fast-news", news.value.value) : [], null, null),
    sourceState("eastmoney-stock-news", "authority", stockNews, stockNews.status === "fulfilled" ? tagged("eastmoney-stock-news", stockNews.value.value) : [], null, null),
    sourceState("eastmoney-announcements", "authority", announcements, announcements.status === "fulfilled" ? tagged("eastmoney-announcements", announcements.value.value.items) : [], announcementRange?.queryFrom ?? null, announcementRange?.queryTo ?? null, announcementRange),
    sourceState("authorized-forum", "discussion", forum, forum.status === "fulfilled" ? tagged("authorized-forum", forum.value.value.items) : [], forum.status === "fulfilled" ? forum.value.value.range?.queryFrom ?? null : null, forum.status === "fulfilled" ? forum.value.value.range?.queryTo ?? null : null, forum.status === "fulfilled" ? forum.value.value.range : null),
    sourceState("user-discussions", "discussion", discussions, discussions.status === "fulfilled" ? tagged("user-discussions", discussions.value.value.items) : [], null, null),
  ];
  const value = { items: deduplicated, failures, forumEnabled, forumSource, forumLicenseId, forumTermsUrl, discussionSources, sourceStates };
  clueCache = { value, expiresAt: Date.now() + 60_000, updatedAt, key: focusKey };
  return { ...value, updatedAt, cached: false };
}

async function fetchFastNews(): Promise<RawClue[]> {
  const cutoff = Date.now() - 24 * 3_600_000;
  const rows: Array<Record<string, unknown>> = [];
  let sortEnd = "";
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({
      client: "web", biz: "web_724", fastColumn: "102", sortEnd, pageSize: "200", req_trace: `${Date.now()}-${page}`,
    });
    const payload = await fetchJson(`https://np-weblist.eastmoney.com/comm/web/getFastNewsList?${params}`, "https://www.eastmoney.com/") as {
      data?: { fastNewsList?: Array<Record<string, unknown>> };
    };
    const pageRows = payload.data?.fastNewsList ?? [];
    if (!pageRows.length) break;
    rows.push(...pageRows);
    const last = pageRows.at(-1);
    const oldestTimestamp = parseEastMoneyTimestamp(String(last?.showTime ?? ""));
    const oldest = oldestTimestamp ? Date.parse(oldestTimestamp) : Number.NaN;
    if (oldest <= cutoff || pageRows.length < 200) break;
    const nextCursor = String(last?.realSort ?? "");
    if (!nextCursor || nextCursor === sortEnd) break;
    sortEnd = nextCursor;
  }
  return rows.map((row): RawClue | null => {
    const id = String(row.code ?? "");
    const title = stripHtml(String(row.title ?? row.summary ?? ""));
    const publishedAt = parseEastMoneyTimestamp(String(row.showTime ?? ""));
    if (!id || !title || !publishedAt) return null;
    const stockCodes = Array.isArray(row.stockList)
      ? row.stockList.map(String).map((value) => value.split(".").at(-1) ?? "").filter((code) => /^\d{6}$/.test(code))
      : [];
    return {
      id: `快讯-${id}`,
      source: "东方财富财经快讯",
      sourceKind: "news",
      title,
      summary: stripHtml(String(row.summary ?? title)),
      publishedAt,
      url: `https://finance.eastmoney.com/a/${id}.html`,
      stockCodes,
      interactionCount: Number(row.pinglun_Num ?? 0) + Number(row.share ?? 0),
    };
  }).filter((item): item is RawClue => item !== null && new Date(item.publishedAt).valueOf() >= cutoff);
}

const ANNOUNCEMENT_PAGE_SIZE = 100;
const ANNOUNCEMENT_MAX_PAGES = 20;
const ANNOUNCEMENT_MAX_RECORDS = ANNOUNCEMENT_PAGE_SIZE * ANNOUNCEMENT_MAX_PAGES;
const ANNOUNCEMENT_PAGE_CONCURRENCY = 4;
/** 一个数据窗口最多覆盖的自然日数；节假日跨度更大时不做没有证明的部分抓取。 */
const ANNOUNCEMENT_MAX_DAYS = 8;

/**
 * 公告按自然日逐日取证后再合并。
 *
 * 交易所公告在早间和盘后各有一波发布，单日总量通常低于分页上限，可以被游标穷尽证明；
 * 而把上一个交易日到当日的合并窗口一次查完时（例如月末叠加半年报可以到 1.5 万条），
 * 总量远超分页上限，反而连一天的可证明窗口都拿不到，导致公告永远无法作为每日聚焦的
 * 可审计输入。逐日取证后，每一天各自被证明穷尽，合并区间仍然连续且完整。
 */
async function fetchAnnouncements(queryDates?: { beginTime: string; endTime: string }): Promise<{ items: RawClue[]; range: LiveClueRangeProof | null }> {
  const beginTime = queryDates?.beginTime ?? shanghaiDate(-1);
  const endTime = queryDates?.endTime ?? shanghaiDate(0);
  const days = calendarDays(beginTime, endTime);
  if (!days.length || days.length > ANNOUNCEMENT_MAX_DAYS) return { items: [], range: null };
  const perDay: Array<{ items: RawClue[]; range: LiveClueRangeProof | null }> = [];
  for (const day of days) perDay.push(await fetchAnnouncementDay(day));
  const items: RawClue[] = [];
  const seen = new Set<string>();
  for (const day of perDay) for (const item of day.items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  const proven = composeAnnouncementRange(perDay.map((day) => day.range));
  return { items, range: proven };
}

/**
 * 合并逐日范围证明：每一天都必须自己游标穷尽，且相邻两天之间不能出现缺口。
 * 因为 display_time 可能溢出到相邻自然日，逐日区间允许重叠，但不允许跳过任何一天。
 */
export function composeAnnouncementRange(ranges: Array<LiveClueRangeProof | null>): LiveClueRangeProof | null {
  if (!ranges.length) return null;
  const proven = ranges.every((range): range is LiveClueRangeProof => Boolean(range
    && range.kind === "server-window-paginated"
    && range.cursorExhausted === true
    && Number.isFinite(Date.parse(range.queryFrom))
    && Number.isFinite(Date.parse(range.queryTo))
    && Date.parse(range.queryFrom) <= Date.parse(range.queryTo)));
  if (!proven) return null;
  for (let index = 1; index < ranges.length; index += 1) {
    // 重叠不构成缺口；只有后一天开始得明显晚于前一天结束（如跳过周末）才拒绝整段窗口。
    const gap = Date.parse(ranges[index]!.queryFrom) - Date.parse(ranges[index - 1]!.queryTo);
    if (gap > 1_000) return null;
  }
  return {
    kind: "server-window-paginated",
    queryFrom: ranges[0]!.queryFrom,
    queryTo: ranges[ranges.length - 1]!.queryTo,
    cursorExhausted: true,
  };
}

async function fetchAnnouncementDay(day: string): Promise<{ items: RawClue[]; range: LiveClueRangeProof | null }> {
  const baseParams = {
    sr: "-1", page_size: String(ANNOUNCEMENT_PAGE_SIZE), ann_type: "A", stock_list: "", client_source: "web",
    begin_time: day, end_time: day,
  };
  const first = await fetchAnnouncementPage(1, baseParams);
  const pages = Math.max(1, Math.ceil(first.total / ANNOUNCEMENT_PAGE_SIZE));
  const pageNumbers = Array.from({ length: Math.min(pages, ANNOUNCEMENT_MAX_PAGES) - 1 }, (_, index) => index + 2);
  const remaining: Array<{ rows: Array<Record<string, unknown>>; total: number }> = [];
  for (let index = 0; index < pageNumbers.length; index += ANNOUNCEMENT_PAGE_CONCURRENCY) {
    remaining.push(...await Promise.all(pageNumbers.slice(index, index + ANNOUNCEMENT_PAGE_CONCURRENCY).map((page) => fetchAnnouncementPage(page, baseParams))));
  }
  const stableTotal = remaining.every((page) => page.total === first.total);
  const fullyExhausted = pages <= ANNOUNCEMENT_MAX_PAGES && first.total <= ANNOUNCEMENT_MAX_RECORDS && stableTotal;
  if (!fullyExhausted) diagLog("clues", "公告单日窗口未证明穷尽", day, `total=${first.total}`, `pages=${pages}`, `stableTotal=${stableTotal}`);
  const rows = [...first.rows, ...remaining.flatMap((page) => page.rows)].slice(0, ANNOUNCEMENT_MAX_RECORDS);
  const items = rows.map(announcementClue).filter((item): item is RawClue => item !== null);
  if (!fullyExhausted) return { items, range: null };
  // 接口按“公告日期”过滤，但返回的 display_time 可能落在该自然日之外
  // （盘后公告的公告日期是次日，实际在头一天晚上就展示）。证明区间必须覆盖
  // 真正返回的时间戳，否则这些公告会被当成区间外证据而整批作废。
  const windowStart = Date.parse(`${day}T00:00:00.000+08:00`);
  const windowEnd = Date.parse(`${day}T23:59:59.999+08:00`);
  const timestamps = items.map((item) => Date.parse(item.publishedAt)).filter((value) => Number.isFinite(value));
  return {
    items,
    range: {
      kind: "server-window-paginated",
      queryFrom: new Date(Math.min(windowStart, ...timestamps)).toISOString(),
      queryTo: new Date(Math.max(windowEnd, ...timestamps)).toISOString(),
      cursorExhausted: true,
    },
  };
}

/** 合并区间必须由连续自然日组成，否则不接受任何范围证明。 */
export function calendarDays(beginTime: string, endTime: string): string[] {
  const start = Date.parse(`${beginTime}T00:00:00.000Z`);
  const end = Date.parse(`${endTime}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const days: string[] = [];
  for (let value = start; value <= end; value += 86_400_000) days.push(new Date(value).toISOString().slice(0, 10));
  return days;
}

function announcementClue(row: Record<string, unknown>): RawClue | null {
  const id = String(row.art_code ?? "");
  const title = stripHtml(String(row.title_ch ?? row.title ?? ""));
  const publishedAt = parseEastMoneyTimestamp(String(row.display_time ?? row.notice_date ?? ""));
  if (!id || !title || !publishedAt) return null;
  const codes = Array.isArray(row.codes) ? row.codes as Array<Record<string, unknown>> : [];
  const stockCodes = codes
    .filter((item) => String(item.ann_type ?? "").split(",").includes("A"))
    .map((item) => String(item.stock_code ?? ""))
    .filter((code) => /^\d{6}$/.test(code));
  const firstCode = stockCodes[0] ?? "";
  const columns = Array.isArray(row.columns) ? row.columns as Array<Record<string, unknown>> : [];
  const columnNames = columns.map((item) => String(item.column_name ?? "")).filter(Boolean);
  return {
    id: `公告-${id}`,
    source: "上市公司公告",
    sourceKind: "announcement",
    title,
    summary: columnNames.length ? `${title}。公告类别：${columnNames.join("、")}。` : title,
    publishedAt,
    url: firstCode ? `https://data.eastmoney.com/notices/detail/${firstCode}/${id}.html` : "https://data.eastmoney.com/notices/",
    stockCodes,
    interactionCount: 0,
  };
}

async function fetchAnnouncementPage(page: number, baseParams: Record<string, string>) {
  const params = new URLSearchParams({ ...baseParams, page_index: String(page) });
  const payload = await fetchJson(`https://np-anotice-stock.eastmoney.com/api/security/ann?${params}`, "https://www.eastmoney.com/") as {
    data?: { list?: Array<Record<string, unknown>>; total_hits?: number };
  };
  return { rows: payload.data?.list ?? [], total: Number(payload.data?.total_hits ?? 0) };
}

async function fetchJson(url: string, referer: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, referer, accept: "application/json,text/plain,*/*" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`实时数据源返回 ${response.status}`);
  return response.json();
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, "").replace(/&nbsp;|&amp;|&quot;|&#39;/g, " ").replace(/\s+/g, " ").trim();
}

export function parseEastMoneyTimestamp(value: string): string | null {
  const normalized = value.replace(/:(\d{3})$/, ".$1").replace(" ", "T");
  const date = new Date(normalized.includes("+") || normalized.endsWith("Z") ? normalized : `${normalized}+08:00`);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function shanghaiDate(dayOffset: number) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date(Date.now() + dayOffset * 86_400_000));
}
