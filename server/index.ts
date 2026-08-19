import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { StockSnapshot } from "../src/domain/types.ts";
import { addToWatchlist, getClueCount, getDailySentiment, getEastMoneyDailyBars, getMarketQuotesByTradeDate, getProviderState, getRecentAmounts, getWatchlist, listTradeDates, removeFromWatchlist, saveEastMoneyDailyBars, savePushedXueqiuDiscussions, saveProviderState } from "./database.ts";
import { fetchEastMoneyDailyBars, fetchEastMoneyPeriodBars, fetchEastMoneyTrends } from "./eastMoneyMarket.ts";
import { loadXueqiuCookie } from "./xueqiuSession.ts";
import { importXueqiuCookieVerified, launchXueqiuBrowserLogin, verifyAndSaveXueqiuCookie } from "./xueqiuBrowser.ts";
import { pinyin } from "pinyin-pro";
import { buildDashboard, buildHistoricalStocks, buildRadarSnapshot, stockEvents } from "./radarEngine.ts";

loadXueqiuCookie();
const port = Number(process.env.API_PORT || 8787);
// 绑定 0.0.0.0 以便从外部（浏览器）访问；如只需本机访问，可设 API_HOST=127.0.0.1
const host = process.env.API_HOST || "0.0.0.0";
const root = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(root, "dist");
const historyRequests = new Map<string, Promise<{ priceHistory: Array<{ date: string; close: number; volume?: number }>; state: "fresh" | "stale" | "unavailable" }>>();

const server = createServer(async (request, response) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  try {
    if (request.method === "OPTIONS") return empty(response, 204);
    if (url.pathname.startsWith("/api/")) return await routeApi(request, response, url, requestId);
    return await serveStatic(response, url.pathname);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return json(response, message.includes("实时") || message.includes("fetch") ? 503 : 500, {
      code: "DATA_UNAVAILABLE",
      message: `${message}。系统不会使用样本数据替代真实结果。`,
      retryable: true,
      requestId,
    });
  }
});

async function routeApi(request: IncomingMessage, response: ServerResponse, url: URL, requestId: string) {
  const watchlist = getWatchlist();

  if (request.method === "GET" && url.pathname === "/api/health") {
    const snapshot = await Promise.resolve(buildRadarSnapshot(watchlist)).then((value) => ({ status: "fulfilled" as const, value })).catch((reason) => ({ status: "rejected" as const, reason }));
    return json(response, 200, {
      ok: snapshot.status === "fulfilled",
      mode: snapshot.status === "fulfilled" ? (!snapshot.value.marketStale && snapshot.value.clueFailures.length === 0 ? "live" : "partial") : "unavailable",
      requestId,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    const snapshot = await buildRadarSnapshot(watchlist);
    return json(response, 200, buildDashboard(snapshot, watchlist));
  }

  if (request.method === "GET" && url.pathname === "/api/stocks") {
    const snapshot = await buildRadarSnapshot(watchlist);
    const query = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
    const signal = url.searchParams.get("signal") ?? "all";
    const market = url.searchParams.get("market") ?? "all";
    const sort = url.searchParams.get("sort") ?? "alert";
    const tagFilter = (url.searchParams.get("tags") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    const requestedScope = url.searchParams.get("scope") ?? "movers";
    const scope = new Set(["all", "movers", "watchlist"]).has(requestedScope) ? requestedScope : "movers";
    const requestedDate = url.searchParams.get("date")?.trim() ?? "";
    const date = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : "";
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get("page_size") || 50)));

    // 历史交易日：从已保存的每日行情构建该日股票快照（无当日舆情，异动标签按该日行情计算）。
    const historical = Boolean(date) && date !== snapshot.tradeDate;
    let stocks = snapshot.stocks;
    let asOf = snapshot.asOf;
    if (historical) {
      const quotes = getMarketQuotesByTradeDate(date);
      if (!quotes.length) {
        return json(response, 404, { code: "NO_DATA_FOR_DATE", message: `该交易日（${date}）没有已保存的完整行情快照`, requestId });
      }
      stocks = buildHistoricalStocks(quotes, watchlist, date, getDailySentiment(date));
      asOf = stocks[0]?.asOf ?? `${date}T15:00:00+08:00`;
    }

    // 异动候选（movers/all）展示全市场股票，符合异动条件的股票带异动标签；
    // 我的自选（watchlist）只保留自选股。搜索始终在全市场范围内进行。
    const scopeItems = stocks.filter((item) => scope === "watchlist" ? item.isWatchlisted : true);
    // 页面标题右侧永远展示全市场股票总数（不随范围与筛选变化）。
    const universeTotal = stocks.length;
    let items = scopeItems.filter((item) => {
      const matchesQuery = !query || `${item.name}${item.code}${item.market}${item.topics.join("")}`.toLowerCase().includes(query) || stockNameInitials(item.name).includes(query);
      const matchesSignal = signal === "all" || item.signal === signal;
      const matchesMarket = market === "all" || item.market === market;
      const matchesTag = tagFilter.length === 0 || (item.moverTags ?? []).some((tag) => tagFilter.includes(tag));
      return matchesQuery && matchesSignal && matchesMarket && matchesTag;
    });
    // 全市场口径不做“无分隐藏”：异动分/方向分排序时无分股票沉底即可，保证始终展示全市场。
    items = [...items].sort((a, b) => compareStocks(a, b, sort));
    const total = items.length;
    const start = (page - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);
    const amountHistory = getRecentAmounts(pageItems.map((item) => item.code), 5, historical ? date : undefined);
    const enriched = pageItems.map((item) => ({
      ...item,
      amountHistory: (amountHistory.get(item.code) ?? []).map((point) => ({ date: point.tradeDate, amount: point.amount })),
    }));
    return json(response, 200, {
      items: enriched,
      total,
      universeTotal,
      analyzed: stocks.filter((item) => item.analysisStatus === "scored").length,
      page,
      pageSize,
      asOf,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/trade-dates") {
    const dates = listTradeDates();
    return json(response, 200, { dates, latest: dates[0] ?? null });
  }

  const stockMatch = url.pathname.match(/^\/api\/stocks\/(\d{6})$/);
  if (request.method === "GET" && stockMatch) {
    const snapshot = await buildRadarSnapshot(watchlist);
    const item = snapshot.stocks.find((candidate) => candidate.code === stockMatch[1]);
    if (!item) return json(response, 404, { code: "STOCK_NOT_FOUND", message: "全市场股票池中未找到该股票", requestId });
    const history = await ensureDailyHistory(item.code, snapshot.tradeDate, item.name);
    return json(response, 200, {
      stock: { ...item, priceHistory: history.priceHistory },
      events: stockEvents(snapshot, item.code),
      marketSource: snapshot.marketStale || snapshot.marketCached ? "东方财富行情缓存" : "东方财富行情",
      historyState: history.state,
    });
  }

  const klineMatch = url.pathname.match(/^\/api\/stocks\/(\d{6})\/kline$/);
  if (request.method === "GET" && klineMatch) {
    const code = klineMatch[1];
    const period = url.searchParams.get("period") ?? "daily";
    const snapshot = await buildRadarSnapshot(watchlist);
    const item = snapshot.stocks.find((candidate) => candidate.code === code);
    if (!item) return json(response, 404, { code: "STOCK_NOT_FOUND", message: "全市场股票池中未找到该股票", requestId });
    if (!new Set(["minute", "daily", "weekly", "monthly"]).has(period)) {
      return json(response, 400, { code: "BAD_PERIOD", message: "周期必须是 minute/daily/weekly/monthly", requestId });
    }
    return json(response, 200, await loadKline(code, period as "minute" | "daily" | "weekly" | "monthly", item.name));
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    const snapshot = await buildRadarSnapshot(watchlist);
    const tone = url.searchParams.get("tone") ?? "all";
    const category = url.searchParams.get("category") ?? "all";
    const eventType = url.searchParams.get("event_type") ?? "all";
    const sourceKind = url.searchParams.get("source_kind") ?? "all";
    const items = snapshot.events.filter((event) => (tone === "all" || event.tone === tone) && (category === "all" || event.category === category) && (eventType === "all" || event.eventType === eventType) && (sourceKind === "all" || event.sourceKind === sourceKind));
    return json(response, 200, { items: items.slice(0, 400), total: items.length, asOf: snapshot.clueAsOf });
  }

  if (request.method === "GET" && url.pathname === "/api/watchlist") {
    return json(response, 200, { codes: watchlist });
  }

  const watchlistMatch = url.pathname.match(/^\/api\/watchlist\/(\d{6})$/);
  if (request.method === "PUT" && watchlistMatch) {
    const snapshot = await buildRadarSnapshot(watchlist);
    if (!snapshot.stocks.some((stock) => stock.code === watchlistMatch[1])) {
      return json(response, 404, { code: "STOCK_NOT_FOUND", message: "全市场股票池中未找到该股票", requestId });
    }
    return json(response, 200, { codes: addToWatchlist(watchlistMatch[1]) });
  }
  if (request.method === "DELETE" && watchlistMatch) {
    return json(response, 200, { codes: removeFromWatchlist(watchlistMatch[1]) });
  }

  if (request.method === "POST" && url.pathname === "/api/xueqiu/browser-login") {
    try {
      const result = await launchXueqiuBrowserLogin();
      return json(response, result.ok ? 200 : 400, { ...result, requestId });
    } catch (error) {
      return json(response, 400, { code: "BROWSER_UNAVAILABLE", message: error instanceof Error ? error.message : "浏览器登录不可用", retryable: false, requestId });
    }
  }

  if (request.method === "POST" && url.pathname === "/api/xueqiu/cookie") {
    let body = "";
    for await (const chunk of request) body += chunk;
    try {
      const payload = JSON.parse(body) as { cookie?: string };
      const result = await verifyAndSaveXueqiuCookie(payload.cookie ?? "");
      return json(response, result.ok ? 200 : 400, { ...result, requestId });
    } catch {
      return json(response, 400, { code: "BAD_JSON", message: "请求体必须是 JSON", requestId });
    }
  }

  // 仅供本机命令行（pnpm xueqiu:session）导入已由用户浏览器验证过的会话。
  if (request.method === "POST" && url.pathname === "/api/xueqiu/cookie/browser-verified") {
    if (!isLoopback(request)) {
      return json(response, 403, { code: "FORBIDDEN", message: "该接口仅允许本机调用", requestId });
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    try {
      const payload = JSON.parse(body) as { cookie?: string };
      const result = await importXueqiuCookieVerified(payload.cookie ?? "");
      return json(response, result.ok ? 200 : 400, { ...result, requestId });
    } catch {
      return json(response, 400, { code: "BAD_JSON", message: "请求体必须是 JSON", requestId });
    }
  }

  // 本机同步推送：接收由 scripts/sync-xueqiu.ts 抓取并推来的雪球讨论。
  // 服务器自身不直连雪球，仅通过该令牌保护的端点接收数据。
  if (request.method === "POST" && url.pathname === "/api/xueqiu/push") {
    const expectedToken = process.env.XUEQIU_SYNC_TOKEN?.trim();
    if (!expectedToken) {
      return json(response, 403, { code: "PUSH_DISABLED", message: "推送功能未启用，请在服务器 .env 设置 XUEQIU_SYNC_TOKEN", retryable: false, requestId });
    }
    const providedToken = (request.headers["x-sync-token"] as string | undefined) ?? url.searchParams.get("token") ?? "";
    if (providedToken !== expectedToken) {
      return json(response, 403, { code: "FORBIDDEN", message: "同步令牌无效", retryable: false, requestId });
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    try {
      const payload = JSON.parse(body) as { items?: unknown };
      const rawItems = Array.isArray(payload.items) ? payload.items : [];
      const clues = rawItems.map(parsePushedXueqiuClue).filter((clue): clue is NonNullable<typeof clue> => Boolean(clue));
      const saved = savePushedXueqiuDiscussions(clues);
      return json(response, 200, { ok: true, accepted: clues.length, saved, requestId });
    } catch {
      return json(response, 400, { code: "BAD_JSON", message: "请求体必须是 JSON", requestId });
    }
  }

  if (request.method === "GET" && url.pathname === "/api/system") {
    return json(response, 200, await systemStatus(false));
  }
  if (request.method === "POST" && url.pathname === "/api/system/refresh") {
    return json(response, 200, await systemStatus(true));
  }

  return json(response, 404, { code: "NOT_FOUND", message: "接口不存在", requestId });
}

async function systemStatus(force: boolean) {
  const watchlist = getWatchlist();
  const snapshotResult = await Promise.resolve(buildRadarSnapshot(watchlist, force)).then((value) => ({ status: "fulfilled" as const, value })).catch((reason) => ({ status: "rejected" as const, reason }));
  const snapshot = snapshotResult.status === "fulfilled" ? snapshotResult.value : null;
  const lastSync = snapshot?.clueAsOf ?? null;
  const partial = Boolean(snapshot) && (Boolean(snapshot?.marketStale) || Boolean(snapshot?.clueFailures.length));
  const historyState = getProviderState("eastmoney_kline");
  const discussionSources = snapshot?.discussionSources ?? [
    { id: "eastmoney-guba" as const, name: "东方财富股吧", state: "degraded" as const, detail: "尚未完成首次同步", count: 0 },
    { id: "eastmoney-guba-replies" as const, name: "东方财富股吧评论", state: "degraded" as const, detail: "尚未完成首次同步", count: 0 },
    { id: "xueqiu" as const, name: "雪球讨论", state: "disabled" as const, detail: "需要用户提供合法会话；未配置", count: 0 },
    { id: "weibo" as const, name: "微博讨论", state: "disabled" as const, detail: "需要本机浏览器；未配置", count: 0 },
    { id: "ths-circle" as const, name: "同花顺圈子", state: "disabled" as const, detail: "等待平台授权数据接口", count: 0 },
  ];
  return {
    mode: snapshot ? (partial ? "partial" : "live") : "unavailable",
    snapshotAsOf: snapshot?.asOf ?? new Date().toISOString(),
    marketStore: {
      connected: Boolean(snapshot), provider: snapshot ? `东方财富${snapshot.marketSourceTier === "primary" ? "实时接口" : "延迟接口"}` : "东方财富",
      tradeDate: snapshot?.tradeDate ?? null, rows: snapshot?.stocks.length ?? 0,
      detail: snapshot ? `${snapshot.marketStale ? "正在使用上一批完整真实行情" : "完整行情已通过校验并写入本地数据库"}，交易日 ${snapshot.tradeDate}` : "东方财富行情首次同步尚未完成",
    },
    universe: { total: snapshot?.stocks.length ?? 0, analyzed: snapshot?.stocks.filter((stock) => stock.analysisStatus === "scored").length ?? 0, provider: "东方财富沪深北股票池" },
    clues: { total: getClueCount(), lastSuccessAt: lastSync },
    sources: [
      { id: "market", name: "东方财富全市场行情", description: "沪深北股票的价格、涨跌与成交数据，整批校验后按交易日保存", kind: "market", state: snapshot ? (snapshot.marketStale ? "degraded" : "connected") : "degraded", lastSync: snapshot?.asOf ?? "连接失败", records: snapshot ? `${snapshot.stocks.length} 只股票` : "0 只", repository: "https://quote.eastmoney.com/" },
      { id: "history", name: "东方财富历史日线", description: (historyState?.metadata && (historyState.metadata as { provider?: string }).provider === "tencent-mirror") ? "东财历史主机在当前网络不可达，由腾讯行情镜像回填同一交易所公开行情" : "打开个股时按需回填真实日线，并先保存到本地数据库", kind: "market", state: historyState?.state ?? "disabled", lastSync: historyState?.lastSuccessAt ?? "尚未回填", records: historyState ? `最近回填 ${historyState.lastRecordCount} 条` : "0 条" },
      { id: "news", name: "财经快讯", description: "面向全市场持续获取公开财经快讯，并保留直接关联股票", kind: "news", state: snapshot && !snapshot.clueFailures.includes("财经快讯") ? "connected" : "degraded", lastSync: lastSync ?? "连接失败", records: snapshot ? `${snapshot.events.filter((event) => event.sourceKind === "news").length} 条当前线索` : "0 条" },
      { id: "announcement", name: "上市公司公告", description: "获取全市场最新公司公告及公告类别", kind: "announcement", state: snapshot && !snapshot.clueFailures.includes("公司公告") ? "connected" : "degraded", lastSync: lastSync ?? "连接失败", records: snapshot ? `${snapshot.events.filter((event) => event.sourceKind === "announcement").length} 条当前线索` : "0 条" },
      ...discussionSources.map((source) => ({ id: source.id, name: source.name, description: source.detail, kind: "forum" as const, state: source.state, lastSync: source.state === "connected" ? (lastSync ?? "刚刚") : source.state === "disabled" ? "未启用" : "连接受限", records: `${source.count} 条用户讨论` })),
      ...(snapshot?.forumEnabled ? [{ id: "licensed-forum", name: snapshot.forumSource, description: "按书面许可协议获取的论坛线索，不保存用户身份", kind: "forum" as const, state: snapshot.clueFailures.includes("授权论坛源") ? "degraded" as const : "connected" as const, lastSync: lastSync ?? "连接失败", records: `${snapshot.events.filter((event) => event.sourceKind === "forum").length} 条当前线索`, licenseId: snapshot.forumLicenseId ?? undefined, termsUrl: snapshot.forumTermsUrl ?? undefined }] : []),
    ],
  };
}

export interface KlinePoint {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  avgPrice?: number | null;
}

interface KlineResponse {
  period: "minute" | "daily" | "weekly" | "monthly";
  source: "eastmoney" | "tencent-mirror" | "cache";
  state: "fresh" | "stale" | "unavailable";
  /** 分时图的昨日收盘价（用于计算相对昨收的实时涨跌幅）。 */
  previousClose?: number | null;
  items: KlinePoint[];
}

const klineCache = new Map<string, { expiresAt: number; value: KlineResponse }>();

async function loadKline(code: string, period: "minute" | "daily" | "weekly" | "monthly", stockName: string): Promise<KlineResponse> {
  const cacheKey = `${code}:${period}`;
  const cached = klineCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const ttl = period === "minute" ? 15_000 : 5 * 60_000;
  let result: KlineResponse;
  try {
    if (period === "minute") {
      const remote = await fetchEastMoneyTrends({ code });
      result = {
        period,
        source: "eastmoney",
        state: "fresh",
        previousClose: remote.previousClose,
        items: remote.items.map((point) => ({
          time: point.time,
          open: point.price,
          high: point.price,
          low: point.price,
          close: point.price,
          volume: point.volume,
          avgPrice: point.avgPrice,
        })),
      };
    } else if (period === "daily") {
      let cachedBars = getEastMoneyDailyBars(code, { adjustment: "none", limit: 250 });
      if (cachedBars.length < 60) {
        const remote = await fetchEastMoneyDailyBars({ code, limit: 250, adjustment: "none" });
        if (stockName) remote.items = remote.items.map((bar) => ({ ...bar, name: stockName }));
        saveEastMoneyDailyBars(remote);
        cachedBars = getEastMoneyDailyBars(code, { adjustment: "none", limit: 250 });
      }
      result = {
        period,
        source: "cache",
        state: cachedBars.length ? "fresh" : "unavailable",
        items: cachedBars.map((bar) => ({ time: bar.tradeDate, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume })),
      };
    } else {
      const periodKey = period === "weekly" ? "week" : "month";
      const remote = await fetchEastMoneyPeriodBars({ code, period: periodKey, limit: 250, adjustment: "none" });
      result = {
        period,
        source: remote.provider,
        state: "fresh",
        items: remote.items.map((bar) => ({ time: bar.tradeDate, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume })),
      };
    }
  } catch {
    saveProviderState({ id: `eastmoney_kline_${period}`, kind: "market-history", state: "degraded", attemptedAt: new Date().toISOString(), recordCount: 0, error: `${period === "minute" ? "分时" : period === "daily" ? "日" : period === "weekly" ? "周" : "月"}线连接失败` });
    result = { period, source: "cache", state: "unavailable", items: [] };
  }
  klineCache.set(cacheKey, { expiresAt: Date.now() + ttl, value: result });
  return result;
}

async function ensureDailyHistory(code: string, tradeDate: string, stockName: string) {
  const existing = historyRequests.get(code);
  if (existing) return existing;
  const request = loadDailyHistory(code, tradeDate, stockName).finally(() => historyRequests.delete(code));
  historyRequests.set(code, request);
  return request;
}

async function loadDailyHistory(code: string, tradeDate: string, stockName: string): Promise<{ priceHistory: Array<{ date: string; close: number; volume?: number }>; state: "fresh" | "stale" | "unavailable" }> {
  let cached = getEastMoneyDailyBars(code, { adjustment: "none", limit: 120 });
  const latest = cached.at(-1)?.tradeDate ?? "";
  if (cached.length >= 60 && latest >= tradeDate) return { priceHistory: toPricePoints(cached.slice(-60)), state: "fresh" };
  try {
    const remote = await fetchEastMoneyDailyBars({ code, limit: 180, adjustment: "none" });
    if (stockName) {
      remote.items = remote.items.map((bar) => ({ ...bar, name: stockName }));
    }
    saveEastMoneyDailyBars(remote);
    cached = getEastMoneyDailyBars(code, { adjustment: "none", limit: 120 });
    return { priceHistory: toPricePoints(cached.slice(-60)), state: cached.length >= 2 ? "fresh" : "unavailable" };
  } catch {
    saveProviderState({ id: "eastmoney_kline", kind: "market-history", state: "degraded", attemptedAt: new Date().toISOString(), recordCount: cached.length, error: "东方财富历史日线连接失败" });
    if (cached.length >= 2) return { priceHistory: toPricePoints(cached.slice(-60)), state: "stale" };
    return { priceHistory: [], state: "unavailable" };
  }
}

function toPricePoints(bars: ReturnType<typeof getEastMoneyDailyBars>) {
  return bars.map((bar) => ({ date: bar.tradeDate, close: bar.close, ...(bar.volume === null ? {} : { volume: bar.volume }) }));
}

/** 股票名称拼音首字母缓存（如 中国平安 → zgpa），支撑拼音缩写搜索。 */
const nameInitialsCache = new Map<string, string>();

function stockNameInitials(name: string): string {
  const cached = nameInitialsCache.get(name);
  if (cached !== undefined) return cached;
  let initials = "";
  try {
    initials = pinyin(name, { pattern: "first", toneType: "none", type: "array" }).join("").toLowerCase();
  } catch {
    initials = "";
  }
  nameInitialsCache.set(name, initials);
  return initials;
}

/**
 * 排序键：alert 异动分、direction 方向分（正）、risk 方向分（负）、attention
 * 讨论热度、consensus 观点共识、mentions 关联线索、pct 实时涨跌、market 市场表现。
 * 前缀 "-" 表示升序（小→大），默认降序。alert 的自选股优先不随方向反转。
 */
function compareStocks(a: StockSnapshot, b: StockSnapshot, sort: string) {
  const ascending = sort.startsWith("-");
  const key = ascending ? sort.slice(1) : sort;
  let result: number;
  if (key === "direction") result = (b.radarScore ?? -1) - (a.radarScore ?? -1);
  else if (key === "amount") result = b.amount - a.amount;
  else if (key === "attention") result = b.factors.attention - a.factors.attention;
  else if (key === "consensus") result = b.factors.consensus - a.factors.consensus;
  else if (key === "mentions") result = b.mentionCount - a.mentionCount;
  else if (key === "pct") result = b.pctChange - a.pctChange;
  else if (key === "risk") result = (a.radarScore ?? 101) - (b.radarScore ?? 101);
  else if (key === "market") result = b.price * b.pctChange - a.price * a.pctChange;
  else {
    if (a.isWatchlisted !== b.isWatchlisted) return a.isWatchlisted ? -1 : 1;
    result = (b.alertScore ?? -1) - (a.alertScore ?? -1);
  }
  return ascending ? -result : result;
}

/** 仅放行本机回环地址，用于信任命令行导入的接口。 */
function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** 校验并规整一条由本机推送来的雪球讨论线索（只接受最小可信字段）。 */
function parsePushedXueqiuClue(raw: unknown): { id: string; source: string; sourceKind: "forum"; title: string; summary: string; publishedAt: string; url: string; stockCodes: string[]; interactionCount: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = String(record.id ?? "").trim();
  const title = String(record.title ?? "").trim().slice(0, 240);
  const publishedAt = String(record.publishedAt ?? "").trim();
  if (!id || !title || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(publishedAt)) return null;
  const stockCodes = Array.isArray(record.stockCodes)
    ? (record.stockCodes as unknown[]).map(String).filter((code) => /^\d{6}$/.test(code))
    : [];
  const summary = String(record.summary ?? title).trim().slice(0, 500);
  const url = String(record.url ?? "").slice(0, 2000);
  const interactionCount = Number(record.interactionCount);
  return {
    id,
    source: "雪球讨论",
    sourceKind: "forum",
    title,
    summary,
    publishedAt,
    url,
    stockCodes,
    interactionCount: Number.isFinite(interactionCount) && interactionCount > 0 ? Math.trunc(interactionCount) : 0,
  };
}

function json(response: ServerResponse, status: number, payload: unknown) {  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  response.end(JSON.stringify(payload));
}

function empty(response: ServerResponse, status: number) {
  response.writeHead(status, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS" });
  response.end();
}

async function serveStatic(response: ServerResponse, pathname: string) {
  const safePath = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  let target = join(distDir, safePath === "/" ? "index.html" : safePath);
  try {
    const info = await stat(target);
    if (info.isDirectory()) target = join(target, "index.html");
  } catch {
    target = join(distDir, "index.html");
  }
  try {
    const body = await readFile(target);
    const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
    response.writeHead(200, { "content-type": types[extname(target)] || "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("请先运行 npm run build，或在开发模式使用 npm run dev。\n");
  }
}

server.listen(port, host, () => {
  console.log(`潮汐接口服务已启动：http://${host}:${port}`);
});
