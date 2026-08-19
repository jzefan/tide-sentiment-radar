import type { RawClue } from "./eastMoney.ts";
import { getPushedXueqiuDiscussions } from "./database.ts";
import { diagLog } from "./diagLog.ts";
import { getXueqiuCookie } from "./xueqiuSession.ts";
import { ensureXueqiuLiveSession, fetchXueqiuTimelineInBrowser, isXueqiuBrowserAvailable, isXueqiuLiveReady, stopXueqiuLiveSession } from "./xueqiuBrowser.ts";
import { ensureWeiboLiveSession, fetchWeiboSearch, isWeiboBrowserAvailable, isWeiboLiveReady, wipeWeiboProfile, type WeiboMblog } from "./weiboBrowser.ts";

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36";
/** 讨论层刷新周期（毫秒），可用 TIDE_DISCUSSION_REFRESH_MS 配置，默认五分钟，最低一分钟。 */
const DISCUSSION_REFRESH_MS = discussionRefreshMs();
/** 每轮扫描的股票数上限（当日异动股 150+100+50 与自选股并集）。 */
const MAX_SCAN_STOCKS = 400;
const RECENT_HOURS = 72;
/** 每轮为评论数最多的一批帖子补充读取公开评论。 */
const REPLIES_FOR_TOP_POSTS = 60;
const REPLIES_PER_POST = 10;
const GUBA_CONCURRENCY = 4;

/**
 * 临时开关：暂不抓取雪球讨论（按用户要求，2026-08-19）。
 * 需要恢复时改为 true 即可（无需改其他代码，既有会话机制原样保留）。
 */
const XUEQIU_FETCH_ENABLED = false;

export interface DiscussionSourceState {
  id: "eastmoney-guba" | "eastmoney-guba-replies" | "xueqiu" | "weibo" | "ths-circle";
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
export async function fetchUserDiscussionClues(stockCodes: string[], force = false, stockNames?: Map<string, string>): Promise<UserDiscussionBundle> {
  const codes = [...new Set(stockCodes.filter((code) => /^\d{6}$/.test(code)))].slice(0, MAX_SCAN_STOCKS);
  const cacheKey = codes.join(",");
  if (!force && discussionCache && discussionCache.key === cacheKey && discussionCache.expiresAt > Date.now()) {
    return discussionCache.value;
  }

  const bundle = await buildUserDiscussionBundle(codes, stockNames);
  discussionCache = { key: cacheKey, expiresAt: Date.now() + DISCUSSION_REFRESH_MS, value: bundle };
  return bundle;
}

async function buildUserDiscussionBundle(codes: string[], names?: Map<string, string>): Promise<UserDiscussionBundle> {
  if (!codes.length) return {
    items: [], failures: [], sources: [
      { id: "eastmoney-guba", name: "东方财富股吧", state: "disabled", detail: "暂无重点股票", count: 0 },
      { id: "eastmoney-guba-replies", name: "东方财富股吧评论", state: "disabled", detail: "暂无重点股票", count: 0 },
      xueqiuDisabledState(),
      weiboDisabledState(),
      thsDisabledState(),
    ],
  };

  diagLog("discussion", "bundle 开始", codes.length, "只");
  const bundleAt = Date.now();
  // 三条讨论源并行：股吧（帖子+评论）、微博（关键词搜索）、雪球（真浏览器会话）。
  const [guba, weibo, xueqiu] = await Promise.allSettled([
    fetchEastMoneyGubaAllMarket(codes),
    resolveWeibo(codes, names),
    resolveXueqiu(codes),
  ]);
  diagLog("discussion", `bundle 完成 ${(Date.now() - bundleAt) / 1000}s`, `guba=${guba.status}`, `weibo=${weibo.status}`, `xueqiu=${xueqiu.status}`);
  const items: RawClue[] = [];
  const failures: string[] = [];
  const sources: DiscussionSourceState[] = [];

  if (guba.status === "fulfilled") {
    const { posts, replies, scannedStocks } = guba.value;
    items.push(...posts, ...replies);
    sources.push({
      id: "eastmoney-guba", name: "东方财富股吧", state: "connected",
      detail: `异动股票帖子 · 研究用途 · 不保存用户身份 · 覆盖 ${scannedStocks} 只股票`, count: posts.length,
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

  // 微博：公开关键词搜索（匿名访客令牌即可，无需登录），覆盖全部异动股票。
  if (weibo.status === "fulfilled") {
    items.push(...weibo.value.items);
    if (weibo.value.failure) failures.push("微博讨论");
    sources.push(weibo.value.source);
  } else {
    failures.push("微博讨论");
    sources.push({ id: "weibo", name: "微博讨论", state: "degraded", detail: safeError(weibo.reason), count: 0 });
  }

  // 雪球：优先本机会话直抓；无 cookie / 无浏览器 / 被 WAF 拦时，回退「本机同步推送」
  // 的数据（scripts/sync-xueqiu.ts 推上来），保证无头服务器也能展示雪球讨论。
  if (xueqiu.status === "fulfilled") {
    items.push(...xueqiu.value.items);
    if (xueqiu.value.failure) failures.push("雪球讨论");
    sources.push(xueqiu.value.source);
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

/**
 * 解析雪球来源：优先本机会话直抓；不可用（无 cookie / 无浏览器 / 被 WAF 拦）时，
 * 回退到「本机同步推送」的数据。返回线索、来源状态与是否计入失败列表。
 */
async function resolveXueqiu(codes: string[]): Promise<{ items: RawClue[]; source: DiscussionSourceState; failure: boolean }> {
  if (!XUEQIU_FETCH_ENABLED) {
    // 暂时停用：关闭常驻浏览器会话（释放资源），不展示推送数据。
    void stopXueqiuLiveSession();
    return {
      items: [],
      source: { id: "xueqiu", name: "雪球讨论", state: "disabled", detail: "雪球讨论暂时停用（已停止抓取）", count: 0 },
      failure: false,
    };
  }
  const pushed = getPushedXueqiuDiscussions();
  const hasCookie = Boolean(getXueqiuCookie());
  if (hasCookie && isXueqiuBrowserAvailable()) {
    try {
      const live = await fetchXueqiu(codes.slice(0, 20));
      if (live.length) {
        return {
          items: live,
          source: { id: "xueqiu", name: "雪球讨论", state: "connected", detail: "使用用户自行提供的合法会话读取重点股票讨论", count: live.length },
          failure: false,
        };
      }
    } catch (error) {
      console.warn("[xueqiu] 服务端直抓失败，回退本机同步推送：", safeError(error));
    }
    if (pushed.length) {
      return {
        items: pushed,
        source: { id: "xueqiu", name: "雪球讨论", state: "connected", detail: "本机同步推送（服务端自主抓取暂不可用）", count: pushed.length },
        failure: false,
      };
    }
    return {
      items: [],
      source: { id: "xueqiu", name: "雪球讨论", state: "degraded", detail: "雪球会话失效，且暂无本机推送数据", count: 0 },
      failure: true,
    };
  }
  if (pushed.length) {
    return {
      items: pushed,
      source: { id: "xueqiu", name: "雪球讨论", state: "connected", detail: hasCookie ? "本机同步推送（服务端未安装浏览器）" : "本机同步推送（未配置服务端会话）", count: pushed.length },
      failure: false,
    };
  }
  return { items: [], source: xueqiuDisabledState(), failure: false };
}

/** 单轮微博抓取预算：超出即停止，不拖垮整轮快照。 */
const WEIBO_CYCLE_BUDGET_MS = 150_000;
/** 微博搜索并发数：实测并发 2 + 700ms 间隔（约 1.6 次/秒）可稳定搜索不触发访客风控。 */
const WEIBO_CONCURRENCY = 2;
/** 批次间隔：降低请求频率，避免触发微博访客验证风控。 */
const WEIBO_BATCH_GAP_MS = 700;
/** 微博轮转游标：每轮从不同位置开始搜索，保证预算内覆盖不全时长期能轮到全部股票。 */
let weiboCursor = 0;

/**
 * 微博讨论：对异动股票按股票名称做公开搜索（匿名访客令牌即可，无需登录），
 * 覆盖全部异动股票；只取 72 小时窗口内的帖子，不保存昵称、用户编号等身份字段。
 */
async function resolveWeibo(codes: string[], names?: Map<string, string>): Promise<{ items: RawClue[]; source: DiscussionSourceState; failure: boolean }> {
  const disabled = (detail: string): { items: RawClue[]; source: DiscussionSourceState; failure: boolean } => ({
    items: [],
    source: { id: "weibo", name: "微博讨论", state: "disabled", detail, count: 0 },
    failure: false,
  });
  if (!isWeiboBrowserAvailable()) return disabled("未安装浏览器，无法抓取微博讨论");
  if (!isWeiboLiveReady() && !(await ensureWeiboLiveSession())) {
    return disabled("微博浏览器会话暂不可用，稍后自动重试");
  }

  const keywords = codes
    .map((code) => ({ code, keyword: names?.get(code)?.trim() ?? "" }))
    .filter((item) => item.keyword);
  if (!keywords.length) return disabled("暂无股票名称，无法搜索微博讨论");

  const keywordToCode = new Map(keywords.map((item) => [item.keyword, item.code]));
  const cutoff = Date.now() - RECENT_HOURS * 3_600_000;
  const deadline = Date.now() + WEIBO_CYCLE_BUDGET_MS;
  // 轮转起始下标：每轮从不同位置开始，保证预算内覆盖不全时长期能轮到全部股票。
  const cursor = weiboCursor % keywords.length;
  const ordered = [...keywords.slice(cursor), ...keywords.slice(0, cursor)];
  const items: RawClue[] = [];
  let searched = 0;
  let failed = 0;
  const failureReasons: Record<string, number> = {};
  diagLog("weibo", "抓取循环 v3 开始", `游标 ${cursor}`, `预算 ${WEIBO_CYCLE_BUDGET_MS}ms`);
  let batchIndex = 0;
  for (let start = 0; start < ordered.length && Date.now() < deadline; start += WEIBO_CONCURRENCY) {
    const batch = ordered.slice(start, start + WEIBO_CONCURRENCY);
    const batchStartedAt = Date.now();
    // 预算硬截止：批次整体（含失败恢复）也不能超过剩余预算，避免单批卡死拖垮整轮。
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let results: Awaited<ReturnType<typeof fetchWeiboSearch>> | null = null;
    try {
      results = await Promise.race([
        fetchWeiboSearch(batch.map((item) => item.keyword)),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
    } catch (error) {
      // 页面无响应或会话被风控：重置档案（换新访客令牌），本轮停止，下轮重建。
      const raw = error instanceof Error ? error.message : String(error);
      if (raw.includes("PAGE_EVALUATE_TIMEOUT") || raw.includes("WEIBO_SESSION_BLOCKED")) {
        await wipeWeiboProfile();
        diagLog("weibo", "会话被风控，档案已重置，本轮停止");
      }
      break;
    }
    const batchMs = Date.now() - batchStartedAt;
    if (results === null) {
      diagLog("weibo", "预算耗尽，本轮停止", `已搜索 ${searched} 个`);
      break;
    }
    batchIndex++;
    // 前 3 批 + 每 10 批记一次进度，正常批次不刷屏。
    if (batchIndex <= 3 || batchIndex % 10 === 0) {
      diagLog("weibo", `批次完成 ${batchMs}ms`, `已搜索 ${searched} 个`);
    }
    for (const result of results) {
      searched++;
      if (!result.ok) {
        failed++;
        const reason = (result.error ?? "未知").slice(0, 60);
        failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
        continue;
      }
      const code = keywordToCode.get(result.keyword) ?? "";
      for (const row of result.mblogs) {
        const clue = mapWeiboRow(row, code, result.keyword, cutoff);
        if (clue) items.push(clue);
      }
    }
    // 批次间留出间隔，降低触发访客风控的频率。
    await new Promise((resolve) => setTimeout(resolve, WEIBO_BATCH_GAP_MS));
  }
  weiboCursor = (cursor + searched) % Math.max(keywords.length, 1);
  diagLog("weibo", "抓取完成", `搜索 ${searched} 个`, `线索 ${items.length} 条`, `失败 ${failed}`, `下一轮游标 ${weiboCursor}`, failureReasons);
  return {
    items,
    source: {
      id: "weibo",
      name: "微博讨论",
      state: items.length ? "connected" : "degraded",
      detail: items.length
        ? `公开微博搜索 · 仅标题摘要 · 不保存用户身份 · 覆盖 ${searched} 只股票`
        : "微博搜索未返回 72 小时内的讨论",
      count: items.length,
    },
    failure: !items.length,
  };
}

const WEIBO_MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** 解析微博时间：绝对格式（Sat Aug 15 06:43:52 +0800 2026）与相对格式（刚刚/N分钟前/今天 HH:MM 等）。 */
function parseWeiboTime(value: string): Date | null {
  if (!value) return null;
  const absolute = value.match(/^[A-Za-z]{3} ([A-Za-z]{3}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}) (\d{4})$/);
  if (absolute) {
    const [, month, day, hour, minute, second, tz, year] = absolute;
    const monthIndex = WEIBO_MONTHS[month];
    if (monthIndex === undefined) return null;
    const iso = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${day}T${hour}:${minute}:${second}${tz.slice(0, 3)}:${tz.slice(3)}`;
    const date = new Date(iso);
    return Number.isNaN(date.valueOf()) ? null : date;
  }
  const now = Date.now();
  if (value === "刚刚") return new Date(now);
  const minutesAgo = value.match(/^(\d+)分钟前$/);
  if (minutesAgo) return new Date(now - Number(minutesAgo[1]) * 60_000);
  const hoursAgo = value.match(/^(\d+)小时前$/);
  if (hoursAgo) return new Date(now - Number(hoursAgo[1]) * 3_600_000);
  const today = value.match(/^今天 (\d{2}):(\d{2})$/);
  if (today) {
    const date = new Date();
    date.setHours(Number(today[1]), Number(today[2]), 0, 0);
    return date;
  }
  const yesterday = value.match(/^昨天 (\d{2}):(\d{2})$/);
  if (yesterday) {
    const date = new Date(now - 86_400_000);
    date.setHours(Number(yesterday[1]), Number(yesterday[2]), 0, 0);
    return date;
  }
  const short = value.match(/^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (short) {
    const date = new Date(`${new Date().getFullYear()}-${short[1]}-${short[2]}T${short[3]}:${short[4]}:00+08:00`);
    return Number.isNaN(date.valueOf()) ? null : date;
  }
  return null;
}

/** 把微博搜索结果映射为线索；超出 72 小时窗口或字段缺失则返回 null。 */
function mapWeiboRow(row: WeiboMblog, code: string, keyword: string, cutoff: number): RawClue | null {
  const publishedAt = parseWeiboTime(row.created_at);
  const title = cleanText(row.text).slice(0, 240);
  if (!row.id || !title || !publishedAt || publishedAt.valueOf() < cutoff) return null;
  return {
    id: `用户讨论-微博-${row.id}`,
    source: "微博讨论",
    sourceKind: "forum",
    title: title.slice(0, 80),
    summary: `微博（${keyword}）：${title}`,
    publishedAt: publishedAt.toISOString(),
    url: `https://m.weibo.cn/detail/${row.id}`,
    stockCodes: code ? [code] : [],
    interactionCount: row.reposts_count * 3 + row.comments_count * 4 + row.attitudes_count * 2,
  };
}

function weiboDisabledState(): DiscussionSourceState {
  return { id: "weibo", name: "微博讨论", state: "disabled", detail: "未安装浏览器，无法抓取微博公开讨论", count: 0 };
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
  const cutoff = Date.now() - RECENT_HOURS * 3_600_000;
  const posts = stockPosts.filter((post) => post.publishedAt.valueOf() >= cutoff);
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

/**
 * 雪球个股讨论时间线。沿用社区实战验证的“半公开接口”纪律（参考
 * xueqiu-watch / icekale/vpush / junagent/xueqiu 等仓库）：
 * 请求头带 Referer / X-Requested-With / 真实浏览器 UA；个股时间线双端点
 * 自动切换；串行抓取且每两个请求间随机间隔 1.2–2.2 秒；遇到 429/风控页/
 * 会话失效立即停止本轮，不撞墙，等下一周期自动恢复。
 *
 * 抓取路径优先级：
 *  - 方案 A（首选）：常驻真浏览器会话存在时，用 page.evaluate 在同源页面内 fetch，
 *    自带真实 TLS + 全量 Cookie（含 xqat），基本绕开服务端直连的 WAF/TLS 风控。
 *  - 方案 B（回退）：A 不可用或失败时，用本地保存的完整 Cookie 由 Node fetch 直连。
 */
/**
 * 雪球个股讨论时间线。沿用社区实战验证的“半公开接口”纪律（参考
 * xueqiu-watch / icekale/vpush / junagent/xueqiu 等仓库）：
 * 请求头带 Referer / X-Requested-With / 真实浏览器 UA；个股时间线双端点
 * 自动切换；串行抓取且每两个请求间随机间隔 1.2–2.2 秒；遇到 429/风控页/
 * 会话失效立即停止本轮，不撞墙，等下一周期自动恢复。
 *
 * 抓取路径优先级：
 *  - 方案 A（首选）：常驻真浏览器会话存在时，用 page.evaluate 在同源页面内 fetch，
 *    自带真实 TLS + 全量 Cookie（含 xqat），基本绕开服务端直连的 WAF/TLS 风控。
 *  - 方案 B（回退）：A 不可用或失败时，用本地保存的完整 Cookie 由 Node fetch 直连。
 *
 * 导出供本机同步脚本（scripts/sync-xueqiu.ts）复用：本机抓取后推送到服务器。
 */
/** 单轮雪球抓取的软预算：建立浏览器会话 + 逐股抓取超出后停止，不拖垮整轮快照。 */
const XUEQIU_CYCLE_BUDGET_MS = 150_000;

export async function fetchXueqiu(codes: string[]): Promise<RawClue[]> {
  if (!XUEQIU_FETCH_ENABLED) return [];
  const cookie = getXueqiuCookie();
  if (!cookie) return [];
  const items = codes.slice(0, 20).map((code) => ({ code, symbol: toXueqiuSymbol(code) }));
  const deadline = Date.now() + XUEQIU_CYCLE_BUDGET_MS;
  // 优先确保有可用的真浏览器会话：常驻窗口在则复用，否则用保存的 Cookie 注入
  // 新开的 Chromium 建立会话（带冷却与总超时，失败时不反复开窗、不阻塞服务）。
  if (isXueqiuLiveReady() || (await ensureXueqiuLiveSession(cookie))) {
    try {
      return await fetchXueqiuViaBrowser(items, deadline);
    } catch (error) {
      // 真浏览器抓取失败（挑战页/页面关闭）：回退到本地 Cookie 直连。
      console.warn("[xueqiu] 真浏览器抓取失败，回退本地 Cookie 直连：", safeError(error));
    }
  }
  return await fetchXueqiuViaCookie(cookie, items, deadline);
}

/** 6 位代码 → 雪球 symbol（SH/SZ/BJ 前缀）。 */
function toXueqiuSymbol(code: string): string {
  return `${/^6/.test(code) ? "SH" : /^8|^9|^4/.test(code) ? "BJ" : "SZ"}${code}`;
}

function xueqiuEndpoints(symbol: string) {
  // 实测（2026-08）：query/v1/status/stock_timeline 已 404；statuses/stock_timeline
  // 对当前会话返回 error_code 10020；网页个股页实际调用的讨论搜索接口
  // query/v1/symbol/search/status.json 在游客会话下即可返回真实讨论，作为主端点。
  return [
    { url: `https://xueqiu.com/query/v1/symbol/search/status.json?${new URLSearchParams({ count: "10", comment: "0", symbol, hl: "0", source: "all", sort: "time", q: "", type: "11" })}`, referer: `https://xueqiu.com/S/${symbol}` },
    { url: `https://xueqiu.com/statuses/stock_timeline.json?${new URLSearchParams({ symbol_id: symbol, page: "1", count: "10" })}`, referer: `https://xueqiu.com/S/${symbol}` },
  ];
}

/** 方案 A：在常驻真浏览器页面内逐个股票抓取时间线（超过预算即止，返回已抓部分）。 */
async function fetchXueqiuViaBrowser(items: Array<{ code: string; symbol: string }>, deadline: number): Promise<RawClue[]> {
  const batches: RawClue[][] = [];
  for (const { code, symbol } of items) {
    if (Date.now() > deadline) break;
    const endpoints = xueqiuEndpoints(symbol);
    let rows: Array<Record<string, unknown>> | null = null;
    let lastError = "个股时间线端点不可用";
    for (const endpoint of endpoints) {
      try {
        const payload = await fetchXueqiuTimelineInBrowser(endpoint.url, endpoint.referer);
        if (payload.error_description || (payload.code !== undefined && payload.code !== 0)) {
          lastError = payload.error_description ?? payload.message ?? "雪球会话失效，请重新连接";
          continue;
        }
        rows = payload.list ?? payload.statuses ?? [];
        break;
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        // 命中风控挑战页：本轮停止，等待下一周期（不撞墙）。
        if (raw.includes("CHALLENGE_PAGE")) {
          throw new Error("雪球返回了风控页面，本轮停止，等待下一周期");
        }
        // 页面主线程被风控挑战卡死（evaluate 无响应）：立即停止本轮，并重建会话，
        // 避免后续每个请求都白等 15 秒，也避免常驻一个卡死的浏览器。
        if (raw.includes("PAGE_EVALUATE_TIMEOUT")) {
          await stopXueqiuLiveSession();
          throw new Error("雪球页面无响应（风控挑战卡死），已重建会话，等待下一周期");
        }
        lastError = safeError(error);
        continue;
      }
    }
    if (rows === null) throw new Error(lastError);
    batches.push(rows.map((row) => mapXueqiuRow(row, code)).filter((clue): clue is RawClue => clue !== null));
    await new Promise((resolve) => setTimeout(resolve, 1_200 + Math.floor(Math.random() * 1_000)));
  }
  return batches.flat();
}

/** 方案 B：用本地保存的完整 Cookie 由服务端 Node fetch 直连雪球数据接口（大概率被 WAF 拦）。 */
async function fetchXueqiuViaCookie(cookie: string, items: Array<{ code: string; symbol: string }>, deadline: number): Promise<RawClue[]> {
  const batches: RawClue[][] = [];
  for (const { code, symbol } of items) {
    if (Date.now() > deadline) break;
    const endpoints = xueqiuEndpoints(symbol);
    let response: Response | null = null;
    let lastError = "个股时间线端点不可用";
    for (const endpoint of endpoints) {
      const attempt = await fetch(endpoint.url, {
        headers: {
          accept: "application/json, text/plain, */*",
          cookie,
          referer: endpoint.referer,
          "x-requested-with": "XMLHttpRequest",
          "user-agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (attempt.status === 429) throw new Error("雪球请求过于频繁(429)，本轮停止，等待下一周期");
      if (!attempt.ok) {
        lastError = `返回状态 ${attempt.status}`;
        continue;
      }
      response = attempt;
      break;
    }
    if (!response) throw new Error(lastError);
    const text = await response.text();
    if (!text.trimStart().startsWith("{")) throw new Error("雪球返回了风控页面，本轮停止，等待下一周期");
    const payload = JSON.parse(text) as { code?: number; list?: Array<Record<string, unknown>>; statuses?: Array<Record<string, unknown>>; error_description?: string; message?: string };
    if (payload.error_description || (payload.code !== undefined && payload.code !== 0)) {
      throw new Error(payload.error_description ?? payload.message ?? "雪球会话失效，请重新连接");
    }
    const rows = payload.list ?? payload.statuses ?? [];
    batches.push(rows.map((row) => mapXueqiuRow(row, code)).filter((clue): clue is RawClue => clue !== null));
    await new Promise((resolve) => setTimeout(resolve, 1_200 + Math.floor(Math.random() * 1_000)));
  }
  return batches.flat();
}

/** 把雪球时间线单条记录映射为线索；超出 72 小时窗口或字段缺失则返回 null。 */
function mapXueqiuRow(row: Record<string, unknown>, code: string): RawClue | null {
  const id = String(row.id ?? row.status_id ?? "");
  const title = cleanText(String(row.title ?? row.description ?? row.text ?? "")).slice(0, 240);
  const timestamp = Number(row.created_at ?? row.createdAt ?? 0);
  const publishedAt = new Date(timestamp > 1e12 ? timestamp : timestamp * 1_000);
  const cutoff = Date.now() - RECENT_HOURS * 3_600_000;
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
}

function xueqiuDisabledState(): DiscussionSourceState {
  return { id: "xueqiu", name: "雪球讨论", state: "disabled", detail: "未配置会话。在本机运行 pnpm xueqiu:session 一键从已登录浏览器导入，或在页面点击「连接雪球」", count: 0 };
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
