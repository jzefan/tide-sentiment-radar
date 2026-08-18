import type { SourceKind } from "../src/domain/types.ts";
import { fetchAuthorizedForumClues, isForumFeedConfigured } from "./forumFeed.ts";
import { fetchUserDiscussionClues, type DiscussionSourceState } from "./userPosts.ts";

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
}

interface Cache<T> {
  value: T;
  expiresAt: number;
  updatedAt: string;
  key?: string;
}

interface LiveClueBundle {
  items: RawClue[];
  failures: string[];
  forumEnabled: boolean;
  forumSource: string;
  forumLicenseId: string | null;
  forumTermsUrl: string | null;
  discussionSources: DiscussionSourceState[];
}

let clueCache: Cache<LiveClueBundle> | null = null;

export async function getLiveClues(force = false, watchlist: string[] = []): Promise<LiveClueBundle & { updatedAt: string; cached: boolean }> {
  const focusKey = [...watchlist].sort().join(",");
  if (!force && clueCache && clueCache.key === focusKey && clueCache.expiresAt > Date.now()) {
    return { ...clueCache.value, updatedAt: clueCache.updatedAt, cached: true };
  }
  const forumEnabled = isForumFeedConfigured();
  const [news, announcements, forum, discussions] = await Promise.allSettled([
    fetchFastNews(), fetchAnnouncements(), fetchAuthorizedForumClues(watchlist), fetchUserDiscussionClues(watchlist, force),
  ]);
  const failures: string[] = [];
  const items: RawClue[] = [];
  if (news.status === "fulfilled") items.push(...news.value);
  else failures.push("财经快讯");
  if (announcements.status === "fulfilled") items.push(...announcements.value);
  else failures.push("公司公告");
  let forumSource = "论坛舆情 · 待授权接入";
  let forumLicenseId: string | null = null;
  let forumTermsUrl: string | null = null;
  if (forum.status === "fulfilled") {
    items.push(...forum.value.items);
    forumSource = forum.value.sourceName;
    forumLicenseId = forum.value.licenseId;
    forumTermsUrl = forum.value.termsUrl;
  } else if (forumEnabled) failures.push("授权论坛源");
  let discussionSources: DiscussionSourceState[] = [];
  if (discussions.status === "fulfilled") {
    items.push(...discussions.value.items);
    failures.push(...discussions.value.failures);
    discussionSources = discussions.value.sources;
  } else {
    failures.push("真实用户讨论");
  }
  const deduplicated = items
    .filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  if (!deduplicated.length) {
    if (clueCache) return { ...clueCache.value, updatedAt: clueCache.updatedAt, cached: true };
    throw new Error("实时线索源均未返回数据");
  }
  const updatedAt = new Date().toISOString();
  const value = { items: deduplicated, failures, forumEnabled, forumSource, forumLicenseId, forumTermsUrl, discussionSources };
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
    const oldest = new Date(toIso(String(last?.showTime ?? ""))).valueOf();
    if (oldest <= cutoff || pageRows.length < 200) break;
    const nextCursor = String(last?.realSort ?? "");
    if (!nextCursor || nextCursor === sortEnd) break;
    sortEnd = nextCursor;
  }
  return rows.map((row): RawClue | null => {
    const id = String(row.code ?? "");
    const title = stripHtml(String(row.title ?? row.summary ?? ""));
    if (!id || !title) return null;
    const publishedAt = toIso(String(row.showTime ?? ""));
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

async function fetchAnnouncements(): Promise<RawClue[]> {
  const cutoff = Date.now() - 24 * 3_600_000;
  const baseParams = {
    sr: "-1", page_size: "100", ann_type: "A", stock_list: "", client_source: "web",
    begin_time: shanghaiDate(-1), end_time: shanghaiDate(0),
  };
  const first = await fetchAnnouncementPage(1, baseParams);
  const pages = Math.max(1, Math.ceil(first.total / 100));
  const remaining = await Promise.all(Array.from({ length: pages - 1 }, (_, index) => fetchAnnouncementPage(index + 2, baseParams)));
  const rows = [...first.rows, ...remaining.flatMap((page) => page.rows)];
  return rows.map((row): RawClue | null => {
    const id = String(row.art_code ?? "");
    const title = stripHtml(String(row.title_ch ?? row.title ?? ""));
    if (!id || !title) return null;
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
      publishedAt: toIso(String(row.display_time ?? row.notice_date ?? "")),
      url: firstCode ? `https://data.eastmoney.com/notices/detail/${firstCode}/${id}.html` : "https://data.eastmoney.com/notices/",
      stockCodes,
      interactionCount: 0,
    };
  }).filter((item): item is RawClue => item !== null && new Date(item.publishedAt).valueOf() >= cutoff);
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

function toIso(value: string) {
  const normalized = value.replace(/:(\d{3})$/, ".$1").replace(" ", "T");
  const date = new Date(normalized.includes("+") || normalized.endsWith("Z") ? normalized : `${normalized}+08:00`);
  return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
}

function shanghaiDate(dayOffset: number) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date(Date.now() + dayOffset * 86_400_000));
}
