import type { RawClue } from "./eastMoney.ts";

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36";
/** 讨论层刷新周期（毫秒），可用 TIDE_DISCUSSION_REFRESH_MS 配置，默认五分钟，最低一分钟。 */
const DISCUSSION_REFRESH_MS = discussionRefreshMs();
/** 每轮扫描的股票数上限（当日异动股 300+300 与自选股并集）。 */
const MAX_SCAN_STOCKS = 640;
const RECENT_HOURS = 72;
/** 每轮为评论数最多的一批帖子补充读取公开评论。 */
const REPLIES_FOR_TOP_POSTS = 60;
const REPLIES_PER_POST = 10;
const GUBA_CONCURRENCY = 4;

export interface DiscussionSourceState {
  id: "eastmoney-guba" | "eastmoney-guba-replies" | "xueqiu" | "ths-circle";
  name: string;
  state: "connected" | "degraded" | "disabled";
  detail: string;
  count: number;
}

export interface UserDiscussionBundle {
  items: RawClue[];
  failures: string[];
  sources: DiscussionSourceState[];
}

function discussionRefreshMs() {
  const value = Number(process.env.TIDE_DISCUSSION_REFRESH_MS);
  return Number.isFinite(value) && value >= 60_000 ? Math.trunc(value) : 5 * 60_000;
}

interface DiscussionCacheEntry {
  key: string;
  expiresAt: number;
  value: UserDiscussionBundle;
}

let discussionCache: DiscussionCacheEntry | null = null;

/**
 * 用户讨论覆盖策略：
 * 1. 当日异动股票（涨跌幅与成交额前列）与自选股的股吧最新帖子——这是全市场讨论热度的主体；
 * 2. 股吧全市场热帖精选与热门排行——补充长尾热点；
 * 3. 评论数最多的一批帖子读取公开顶层评论。
 * 结果按五分钟缓存，行情层仍然实时，排序因此每五分钟更新一轮。
 * 所有来源保留原始链接，不保存昵称、用户编号等身份字段，不绕过登录或验证码。
 */
export async function fetchUserDiscussionClues(stockCodes: string[], force = false): Promise<UserDiscussionBundle> {
  const codes = [...new Set(stockCodes.filter((code) => /^\d{6}$/.test(code)))].slice(0, MAX_SCAN_STOCKS);
  const cacheKey = codes.join(",");
  if (!force && discussionCache && discussionCache.key === cacheKey && discussionCache.expiresAt > Date.now()) {
    return discussionCache.value;
  }

  const bundle = await buildUserDiscussionBundle(codes);
  discussionCache = { key: cacheKey, expiresAt: Date.now() + DISCUSSION_REFRESH_MS, value: bundle };
  return bundle;
}

async function buildUserDiscussionBundle(codes: string[]): Promise<UserDiscussionBundle> {
  if (!codes.length) return {
    items: [], failures: [], sources: [
      { id: "eastmoney-guba", name: "东方财富股吧", state: "disabled", detail: "暂无重点股票", count: 0 },
      { id: "eastmoney-guba-replies", name: "东方财富股吧评论", state: "disabled", detail: "暂无重点股票", count: 0 },
      xueqiuDisabledState(),
      thsDisabledState(),
    ],
  };

  const [guba, xueqiu] = await Promise.allSettled([
    fetchEastMoneyGubaAllMarket(codes),
    fetchXueqiu(codes.slice(0, 8)),
  ]);
  const items: RawClue[] = [];
  const failures: string[] = [];
  const sources: DiscussionSourceState[] = [];

  if (guba.status === "fulfilled") {
    const { posts, replies, scannedStocks } = guba.value;
    items.push(...posts, ...replies);
    sources.push({
      id: "eastmoney-guba", name: "东方财富股吧", state: "connected",
      detail: `全市场热帖精选与 ${scannedStocks} 只异动股票帖子 · 研究用途 · 不保存用户身份`, count: posts.length,
    });
    sources.push({
      id: "eastmoney-guba-replies", name: "东方财富股吧评论", state: "connected",
      detail: `全市场评论数最多帖子的公开评论 · 不保存用户身份`, count: replies.length,
    });
  } else {
    failures.push("东方财富股吧");
    sources.push({ id: "eastmoney-guba", name: "东方财富股吧", state: "degraded", detail: safeError(guba.reason), count: 0 });
    sources.push({ id: "eastmoney-guba-replies", name: "东方财富股吧评论", state: "degraded", detail: safeError(guba.reason), count: 0 });
  }

  if (!process.env.XUEQIU_COOKIE) {
    sources.push(xueqiuDisabledState());
  } else if (xueqiu.status === "fulfilled") {
    items.push(...xueqiu.value);
    sources.push({ id: "xueqiu", name: "雪球讨论", state: "connected", detail: "使用用户自行提供的合法会话读取重点股票讨论", count: xueqiu.value.length });
  } else {
    failures.push("雪球讨论");
    sources.push({ id: "xueqiu", name: "雪球讨论", state: "degraded", detail: safeError(xueqiu.reason), count: 0 });
  }

  sources.push(thsDisabledState());
  return {
    items: items.filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index),
    failures,
    sources,
  };
}

/** 帖子列表的中间结构：既生成帖子线索，也作为评论抓取的入口。 */
interface GubaPostMeta {
  postId: string;
  code: string;
  title: string;
  publishedAt: Date;
  url: string;
  clickCount: number;
  commentCount: number;
  forwardCount: number;
  stance: number;
}

/**
 * 全市场股吧帖子 + 热门评论。异动股票逐个抓最新帖，热帖精选补充长尾，
 * 最后对评论数最多的一批帖子读取公开顶层评论。
 */
async function fetchEastMoneyGubaAllMarket(codes: string[]): Promise<{ posts: RawClue[]; replies: RawClue[]; scannedStocks: number }> {
  const stockPosts = await fetchGubaPostsForStocks(codes);
  const hotPosts = await fetchGubaHotFeed();
  const cutoff = Date.now() - RECENT_HOURS * 3_600_000;
  const posts = [...stockPosts, ...hotPosts]
    .filter((post) => post.publishedAt.valueOf() >= cutoff);
  const uniquePosts = [...new Map(posts.map((post) => [post.postId, post])).values()];

  const hotForReplies = [...uniquePosts]
    .filter((post) => post.commentCount > 0)
    .sort((a, b) => b.commentCount - a.commentCount)
    .slice(0, REPLIES_FOR_TOP_POSTS);
  const replies: RawClue[] = [];
  for (let start = 0; start < hotForReplies.length; start += GUBA_CONCURRENCY) {
    const results = await Promise.allSettled(hotForReplies.slice(start, start + GUBA_CONCURRENCY).map(fetchGubaRepliesForPost));
    replies.push(...results
      .filter((result): result is PromiseFulfilledResult<RawClue[]> => result.status === "fulfilled")
      .flatMap((result) => result.value));
  }
  return {
    posts: uniquePosts.map((post) => gubaPostToClue(post)).filter((clue): clue is RawClue => clue !== null),
    replies,
    scannedStocks: codes.length,
  };
}

async function fetchGubaPostsForStocks(codes: string[]): Promise<GubaPostMeta[]> {
  const batches: GubaPostMeta[][] = [];
  for (let start = 0; start < codes.length; start += GUBA_CONCURRENCY) {
    const results = await Promise.allSettled(codes.slice(start, start + GUBA_CONCURRENCY).map(fetchGubaPosts));
    batches.push(...results
      .filter((result): result is PromiseFulfilledResult<GubaPostMeta[]> => result.status === "fulfilled")
      .map((result) => result.value));
  }
  return batches.flat();
}

/** 股吧全市场热帖精选与热门排行（跨全部股吧的长尾热点）。 */
async function fetchGubaHotFeed(): Promise<GubaPostMeta[]> {
  const rows = await Promise.allSettled([
    fetchGubaHotSelection(),
    fetchGubaHotRanking(),
  ]);
  return rows
    .filter((result): result is PromiseFulfilledResult<GubaPostMeta[]> => result.status === "fulfilled")
    .flatMap((result) => result.value);
}

async function fetchGubaHotSelection(): Promise<GubaPostMeta[]> {
  const params = new URLSearchParams({ ps: "20", p: "1", version: "product", product: "Guba", plat: "Web" });
  const response = await fetch(`https://gbapi.eastmoney.com/hotpost/api/Selection/Articlelist?${params}`, {
    headers: { accept: "application/json,text/plain,*/*", referer: "https://guba.eastmoney.com/", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`返回状态 ${response.status}`);
  const payload = await response.json() as { rc?: number; me?: string; re?: Array<Record<string, unknown>> };
  if (payload.rc !== 1) throw new Error(String(payload.me || "热帖精选接口未返回数据"));
  return (payload.re ?? []).map(parseHotPostRow).filter((post): post is GubaPostMeta => post !== null);
}

async function fetchGubaHotRanking(): Promise<GubaPostMeta[]> {
  const params = new URLSearchParams({ ps: "50", p: "1", version: "product", product: "Guba", plat: "Web" });
  const response = await fetch(`https://gbapi.eastmoney.com/operation/api/HotRanking/List?${params}`, {
    headers: { accept: "application/json,text/plain,*/*", referer: "https://guba.eastmoney.com/", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`返回状态 ${response.status}`);
  const payload = await response.json() as { rc?: number; me?: string; re?: Array<Record<string, unknown>> };
  if (payload.rc !== 1) throw new Error(String(payload.me || "热门排行接口未返回数据"));
  return (payload.re ?? []).map(parseHotPostRow).filter((post): post is GubaPostMeta => post !== null);
}

function parseHotPostRow(row: Record<string, unknown>): GubaPostMeta | null {
  const guba = isRecord(row.post_guba) ? row.post_guba : null;
  const code = String(guba?.stockbar_code ?? row.stockbar_code ?? "");
  if (!/^\d{6}$/.test(code)) return null;
  const postId = String(row.post_id ?? "");
  const title = cleanText(String(row.post_title ?? ""));
  const publishedAt = parseChinaTime(String(row.post_publish_time ?? row.post_last_time ?? ""));
  if (!postId || !title || !publishedAt) return null;
  return {
    postId,
    code,
    title,
    publishedAt,
    url: `https://guba.eastmoney.com/news,${code},${postId}.html`,
    clickCount: finite(row.post_click_count),
    commentCount: finite(row.post_comment_count),
    forwardCount: finite(row.post_forward_count),
    stance: Number(row.bullish_bearish ?? 0),
  };
}

async function fetchGubaPosts(code: string): Promise<GubaPostMeta[]> {
  const params = new URLSearchParams({
    code, sorttype: "1", ps: "20", p: "1", version: "product", product: "Guba", plat: "Web",
  });
  const response = await fetch(`https://gbapi.eastmoney.com/webarticlelist/api/Article/Articlelist?${params}`, {
    headers: { accept: "application/json,text/plain,*/*", referer: `https://guba.eastmoney.com/list,${code}.html`, "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`返回状态 ${response.status}`);
  const payload = await response.json() as { rc?: number; me?: string; re?: Array<Record<string, unknown>> };
  if (payload.rc !== 1) throw new Error(String(payload.me || "接口未返回有效帖子"));
  return (payload.re ?? []).map((row): GubaPostMeta | null => {
    const postId = String(row.post_id ?? "");
    const title = cleanText(String(row.post_title ?? ""));
    const stockCode = String(row.stockbar_code ?? code);
    const publishedAt = parseChinaTime(String(row.post_publish_time ?? row.post_last_time ?? ""));
    if (!postId || !title || !/^\d{6}$/.test(stockCode) || !publishedAt) return null;
    return {
      postId,
      code: stockCode,
      title,
      publishedAt,
      url: `https://guba.eastmoney.com/news,${stockCode},${postId}.html`,
      clickCount: finite(row.post_click_count),
      commentCount: finite(row.post_comment_count),
      forwardCount: finite(row.post_forward_count),
      stance: Number(row.bullish_bearish ?? 0),
    };
  }).filter((post): post is GubaPostMeta => post !== null);
}

function gubaPostToClue(post: GubaPostMeta): RawClue | null {
  if (!post.postId || !post.title) return null;
  const stance = post.stance === 1 ? "看多观点" : post.stance === 2 ? "看空观点" : "用户观点";
  return {
    id: `用户讨论-东方财富-${post.postId}`,
    source: "东方财富股吧",
    sourceKind: "forum",
    title: post.title,
    summary: `${stance}：${post.title}`,
    publishedAt: post.publishedAt.toISOString(),
    url: post.url,
    stockCodes: [post.code],
    interactionCount: post.clickCount + post.commentCount * 4 + post.forwardCount * 2,
  };
}

/** 读取单个帖子的最新公开评论（顶层回复），不保存任何用户身份字段。 */
async function fetchGubaRepliesForPost(post: GubaPostMeta): Promise<RawClue[]> {
  const params = new URLSearchParams({
    postid: post.postId,
    sort: "1",
    sorttype: "1",
    p: "1",
    ps: String(REPLIES_PER_POST),
    version: "product",
    product: "Guba",
    plat: "Web",
  });
  const response = await fetch(`https://gbapi.eastmoney.com/reply/api/Reply/ArticleNewReplyList?${params}`, {
    headers: { accept: "application/json,text/plain,*/*", referer: post.url, "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`返回状态 ${response.status}`);
  const payload = await response.json() as { rc?: number; me?: string; re?: Array<Record<string, unknown>> };
  if (payload.rc !== 1) throw new Error(String(payload.me || "接口未返回有效评论"));
  const cutoff = Date.now() - RECENT_HOURS * 3_600_000;
  return (payload.re ?? []).map((row): RawClue | null => {
    const replyId = String(row.reply_id ?? "");
    const text = cleanText(String(row.reply_text ?? "")).slice(0, 240);
    const publishedAt = parseChinaTime(String(row.reply_publish_time ?? row.reply_time ?? ""));
    if (!replyId || !text || !publishedAt || publishedAt.valueOf() < cutoff) return null;
    return {
      id: `用户讨论-东方财富评论-${replyId}`,
      source: "东方财富股吧评论",
      sourceKind: "forum",
      title: text.slice(0, 80),
      summary: `在《${post.title}》下的评论：${text}`,
      publishedAt: publishedAt.toISOString(),
      url: post.url,
      stockCodes: [post.code],
      interactionCount: finite(row.reply_like_count) + finite(row.reply_comment_count) * 2,
    };
  }).filter((clue): clue is RawClue => clue !== null);
}

async function fetchXueqiu(codes: string[]): Promise<RawClue[]> {
  const cookie = process.env.XUEQIU_COOKIE;
  if (!cookie) return [];
  const batches: RawClue[][] = [];
  for (const code of codes.slice(0, 8)) {
    const symbol = `${/^6/.test(code) ? "SH" : /^8|^9|^4/.test(code) ? "BJ" : "SZ"}${code}`;
    const params = new URLSearchParams({ symbol, count: "10", source: "all" });
    const response = await fetch(`https://xueqiu.com/query/v1/status/stock_timeline.json?${params}`, {
      headers: { accept: "application/json", cookie, referer: `https://xueqiu.com/S/${symbol}`, "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`返回状态 ${response.status}`);
    const payload = await response.json() as { list?: Array<Record<string, unknown>>; statuses?: Array<Record<string, unknown>>; error_description?: string };
    if (payload.error_description) throw new Error(payload.error_description);
    const rows = payload.list ?? payload.statuses ?? [];
    const cutoff = Date.now() - RECENT_HOURS * 3_600_000;
    batches.push(rows.map((row): RawClue | null => {
      const id = String(row.id ?? row.status_id ?? "");
      const title = cleanText(String(row.title ?? row.description ?? row.text ?? "")).slice(0, 240);
      const timestamp = Number(row.created_at ?? row.createdAt ?? 0);
      const publishedAt = new Date(timestamp > 1e12 ? timestamp : timestamp * 1_000);
      if (!id || !title || Number.isNaN(publishedAt.valueOf()) || publishedAt.valueOf() < cutoff) return null;
      return {
        id: `用户讨论-雪球-${id}`,
        source: "雪球讨论",
        sourceKind: "forum",
        title,
        summary: title,
        publishedAt: publishedAt.toISOString(),
        url: `https://xueqiu.com/${String(row.user_id ?? "")}/${id}`,
        stockCodes: [code],
        interactionCount: finite(row.reply_count) * 4 + finite(row.retweet_count) * 2 + finite(row.like_count) * 2 + finite(row.fav_count),
      };
    }).filter((clue): clue is RawClue => clue !== null));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return batches.flat();
}

function xueqiuDisabledState(): DiscussionSourceState {
  return { id: "xueqiu", name: "雪球讨论", state: "disabled", detail: "需要用户提供合法会话；未配置时不读取、不绕过登录", count: 0 };
}

function thsDisabledState(): DiscussionSourceState {
  return { id: "ths-circle", name: "同花顺圈子", state: "disabled", detail: "帖子接口要求登录且禁止未授权抓取，等待平台授权数据接口", count: 0 };
}

function cleanText(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/&(?:nbsp|amp|quot|#39);/g, " ").replace(/\s+/g, " ").trim();
}

function parseChinaTime(value: string) {
  if (!value) return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}+08:00`);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function finite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeError(value: unknown) {
  const message = value instanceof Error ? value.message : "";
  if (/timed?\s*out|abort/i.test(message)) return "连接超时，稍后自动重试";
  if (/401|403|登录|会话|鉴权|unauthor/i.test(message)) return "会话无效或访问未获授权";
  if (/429|限流|频繁/i.test(message)) return "请求过于频繁，已等待稍后重试";
  if (/状态\s*5\d\d|status\s*5\d\d/i.test(message)) return "上游服务暂时异常";
  return "网络连接失败，稍后自动重试";
}
