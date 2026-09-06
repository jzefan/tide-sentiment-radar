import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { DashboardData, SentimentEvent, StockSnapshot } from "../src/domain/types.ts";
import { addToWatchlist, getClueCount, getDailyCandidateList, getDailyCandidateOutcomes, getDailySentiment, getEastMoneyDailyBars, getMarketQuotesByTradeDate, getProviderState, getRecentAmounts, getRecentPctChanges, getStoredCluesBySource, getWatchlist, listDailyCandidateLists, listTradeDates, removeFromWatchlist, saveEastMoneyDailyBars, savePushedXueqiuDiscussions, saveProviderState } from "./database.ts";
import { fetchEastMoneyDailyBars, fetchEastMoneyPeriodBars, fetchEastMoneyTrends } from "./eastMoneyMarket.ts";
import { loadXueqiuCookie } from "./xueqiuSession.ts";
import { importXueqiuCookieVerified, launchXueqiuBrowserLogin, verifyAndSaveXueqiuCookie } from "./xueqiuBrowser.ts";
import { pinyin } from "pinyin-pro";
import { buildDailyCandidatePreviewFromRadar, buildDashboard, buildHistoricalStocks, buildLiveFocusFallback, buildRadarSnapshot, defaultDiscussionSources, startScheduledRefresh, stopScheduledRefresh, stockEvents } from "./radarEngine.ts";
import { buildIndustryApiResponse, getIndustryByCode, getIndustryForwardApi } from "./industryApi.ts";
import { buildIndustryAnalytics, classifyStockIndustry } from "./industryAnalytics.ts";
import { stopXueqiuLiveSession } from "./xueqiuBrowser.ts";
import { stopWeiboLiveSession } from "./weiboBrowser.ts";
import { getDailyCandidatePerformance, withFrozenBenchmarkIndustryLabels, withNextTradingDayTrends } from "./dailyCandidateService.ts";
import { isTradingSession } from "../src/domain/marketCalendar.ts";
import { getConvertibleBonds, isConvertibleBondSort, type ConvertibleBondView } from "./convertibleBonds.ts";
import { getDailyFocusPool } from "./dailyFocusPoolService.ts";
import type { DailyFocusPoolWindowSessions } from "./dailyFocusPool.ts";

loadXueqiuCookie();
const port = Number(process.env.API_PORT || 8787);
// 绑定 0.0.0.0 以便从外部（浏览器）访问；如只需本机访问，可设 API_HOST=127.0.0.1
const host = process.env.API_HOST || "0.0.0.0";
const root = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(root, "dist");
const historyRequests = new Map<string, Promise<{ priceHistory: Array<{ date: string; close: number; volume?: number }>; state: "fresh" | "stale" | "unavailable" }>>();

/** The current exchange session is intentionally preview-only; a frozen list is shown after close. */
export function shouldServeLiveDailyPreview(requestedDate: string | null, snapshotTradeDate: string, now: Date): boolean {
  return (requestedDate === null || requestedDate === snapshotTradeDate)
    && snapshotTradeDate === shanghaiDate(now)
    && isTradingSession(now);
}

function shanghaiDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

export const server = createServer(async (request, response) => {
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

  const discussionSources = {
    "eastmoney-guba": "东方财富股吧",
    "eastmoney-guba-replies": "东方财富股吧评论",
    weibo: "微博讨论",
  } as const;

  if (request.method === "GET" && url.pathname === "/api/system/discussions") {
    const sourceId = url.searchParams.get("source") ?? "";
    const source = discussionSources[sourceId as keyof typeof discussionSources];
    if (!source) return json(response, 400, { code: "BAD_SOURCE", message: "该数据源不支持查看用户讨论", requestId });
    const requestedPage = Number(url.searchParams.get("page") || 1);
    const page = Number.isFinite(requestedPage) ? Math.max(1, Math.trunc(requestedPage)) : 1;
    const pageSize = 10;
    const result = getStoredCluesBySource(source, pageSize, (page - 1) * pageSize);
    return json(response, 200, {
      source: sourceId,
      items: result.items,
      total: result.total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
    });
  }

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
    const dashboard = buildDashboard(snapshot, watchlist);
    return json(response, 200, withIndustryDashboard(dashboard, snapshot));
  }

  if (request.method === "GET" && url.pathname === "/api/industries") {
    const snapshot = await buildRadarSnapshot(watchlist);
    return json(response, 200, buildIndustryApiResponse(snapshot, {
      query: url.searchParams.get("q") ?? undefined,
      hotOnly: url.searchParams.get("hot_only") === "1" || url.searchParams.get("hot_only") === "true",
      code: url.searchParams.get("code") ?? undefined,
      relation: url.searchParams.get("relation") ?? undefined,
      horizon: parseIndustryHorizon(url.searchParams.get("horizon")),
    }));
  }

  const industryForwardMatch = url.pathname.match(/^\/api\/industries\/([^/]+)\/forward$/);
  if (request.method === "GET" && industryForwardMatch) {
    const horizon = parseIndustryHorizon(url.searchParams.get("horizon")) ?? 5;
    return json(response, 200, getIndustryForwardApi(decodeURIComponent(industryForwardMatch[1]), horizon));
  }

  const industryMatch = url.pathname.match(/^\/api\/industries\/([^/]+)$/);
  if (request.method === "GET" && industryMatch) {
    const snapshot = await buildRadarSnapshot(watchlist);
    const result = getIndustryByCode(snapshot, decodeURIComponent(industryMatch[1]));
    if (!result) return json(response, 404, { code: "INDUSTRY_NOT_FOUND", message: "当前快照中没有可分析的行业信息", requestId });
    return json(response, 200, {
      ...result,
      item: { ...result.item, profile: { ...result.item.profile, asOf: snapshot.asOf } },
      asOf: snapshot.asOf,
      clueAsOf: snapshot.clueAsOf,
      tradeDate: snapshot.tradeDate,
      methodology: {
        textMetricsExcludePrice: true,
        note: "当前行业热点是当前快照的描述性分类；T+1、T+3、T+5、T+10 后验结果将在各自观察周期完成后生成。",
        version: "行业分析规则 v1",
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/api/stocks") {
    const snapshot = await buildRadarSnapshot(watchlist);
    const query = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
    const signal = url.searchParams.get("signal") ?? "all";
    const market = url.searchParams.get("market") ?? "all";
    const sort = url.searchParams.get("sort") ?? "alert";
    const industryFilter = url.searchParams.get("industry")?.trim() ?? "";
    const hotIndustryOnly = url.searchParams.get("hot_industry") === "1" || url.searchParams.get("hot_industry") === "true";
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
    stocks = enrichStocksWithIndustry(stocks, snapshot, historical ? [] : snapshot.events, asOf);

    // 异动候选（movers/all）展示全市场股票，符合异动条件的股票带异动标签；
    // 我的自选（watchlist）只保留自选股。搜索始终在全市场范围内进行。
    const scopeItems = stocks.filter((item) => scope === "watchlist" ? item.isWatchlisted : true);
    // 页面标题右侧永远展示全市场股票总数（不随范围与筛选变化）。
    const universeTotal = stocks.length;
    let items = scopeItems.filter((item) => {
      const matchesQuery = !query || `${item.name}${item.code}${item.market}${item.topics.join("")}${item.industry?.name ?? ""}`.toLowerCase().includes(query) || stockNameInitials(item.name).includes(query);
      const matchesSignal = signal === "all" || item.signal === signal;
      const matchesMarket = market === "all" || item.market === market;
      const matchesTag = tagFilter.length === 0 || (item.moverTags ?? []).some((tag) => tagFilter.includes(tag));
      const matchesIndustry = !industryFilter || item.industry?.code === industryFilter || item.industry?.name === industryFilter;
      const matchesHotIndustry = !hotIndustryOnly || (
        (item.industryPulse?.textHeat ?? 0) >= 70
        && (item.industryPulse?.relation === "舆情交易双热" || item.industryPulse?.relation === "舆情升温、价格未确认")
      );
      return matchesQuery && matchesSignal && matchesMarket && matchesTag && matchesIndustry && matchesHotIndustry;
    });
    // 全市场口径不做“无分隐藏”：异动分/文本方向排序时无分股票沉底即可，保证始终展示全市场。
    items = [...items].sort((a, b) => compareStocks(a, b, sort));
    const total = items.length;
    const start = (page - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);
    const amountHistory = getRecentAmounts(pageItems.map((item) => item.code), 5, historical ? date : undefined);
    const returnHistory = getRecentPctChanges(pageItems.map((item) => item.code), 22, historical ? date : undefined);
    const enriched = pageItems.map((item) => ({
      ...item,
      amountHistory: (amountHistory.get(item.code) ?? []).map((point) => ({ date: point.tradeDate, amount: point.amount })),
      returnHistory: (returnHistory.get(item.code) ?? []).map((point) => ({ date: point.tradeDate, pctChange: point.pctChange })),
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

  if (request.method === "GET" && url.pathname === "/api/convertible-bonds") {
    const requestedView = url.searchParams.get("view") ?? "all";
    if (!new Set(["all", "upcoming", "latest"]).has(requestedView)) {
      return json(response, 400, { code: "BAD_BOND_VIEW", message: "view 仅支持 all、upcoming 或 latest", requestId });
    }
    const requestedPage = Number(url.searchParams.get("page") || 1);
    const requestedPageSize = Number(url.searchParams.get("page_size") || 50);
    const requestedSort = url.searchParams.get("sort")?.trim() ?? "";
    if (requestedSort && !isConvertibleBondSort(requestedSort)) {
      return json(response, 400, { code: "BAD_BOND_SORT", message: "sort 不支持该转债列表字段", requestId });
    }
    return json(response, 200, await getConvertibleBonds({
      view: requestedView as ConvertibleBondView,
      query: url.searchParams.get("q") ?? "",
      sort: requestedSort || undefined,
      page: Number.isFinite(requestedPage) ? requestedPage : 1,
      pageSize: Number.isFinite(requestedPageSize) ? requestedPageSize : 50,
      signal: AbortSignal.timeout(15_000),
    }));
  }

  if (request.method === "GET" && url.pathname === "/api/daily-candidates") {
    const date = url.searchParams.get("date");
    if (date !== null && !isRealCalendarDate(date)) return json(response, 400, { code: "BAD_DATE", message: "date 必须是有效日历日期 YYYY-MM-DD", requestId });
    const snapshot = await buildRadarSnapshot(watchlist);
    if (shouldServeLiveDailyPreview(date, snapshot.tradeDate, new Date())) {
      const preview = await buildDailyCandidatePreviewFromRadar(watchlist);
      return json(response, 200, { ...preview, outcomes: [] });
    }
    if (date === null) {
      const sameDate = getDailyCandidateList(snapshot.tradeDate);
      if (sameDate) return json(response, 200, {
        ...sameDate,
        items: withNextTradingDayTrends(sameDate.tradeDate, withFrozenBenchmarkIndustryLabels(sameDate)),
        outcomes: getDailyCandidateOutcomes(snapshot.tradeDate),
        ...(sameDate.items.length ? {} : { liveFocusItems: buildLiveFocusFallback(snapshot) }),
      });
      const preview = await buildDailyCandidatePreviewFromRadar(watchlist);
      return json(response, 200, { ...preview, outcomes: [] });
    }
    const list = getDailyCandidateList(date);
    if (!list) {
      if (date === snapshot.tradeDate) {
        const preview = await buildDailyCandidatePreviewFromRadar(watchlist);
        return json(response, 200, { ...preview, outcomes: [] });
      }
      return json(response, 404, { code: "NO_CANDIDATE_LIST_FOR_DATE", message: `交易日（${date}）没有冻结或重建的每日候选记录`, requestId });
    }
    // Outcomes are immutable, per-candidate audit records.  Including them preserves the
    // list's original status/origin while allowing the UI to explain observing/unavailable T+3.
    return json(response, 200, {
      ...list,
      items: withNextTradingDayTrends(list.tradeDate, withFrozenBenchmarkIndustryLabels(list)),
      outcomes: getDailyCandidateOutcomes(date),
      ...(date === snapshot.tradeDate && list.items.length === 0 ? { liveFocusItems: buildLiveFocusFallback(snapshot) } : {}),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/daily-focus-pool") {
    const rawSessions = url.searchParams.get("sessions") ?? "5";
    if (!new Set(["2", "3", "4", "5"]).has(rawSessions)) return json(response, 400, { code: "BAD_FOCUS_POOL_WINDOW", message: "sessions 仅支持 2、3、4 或 5", requestId });
    const windowSessions = Number(rawSessions) as DailyFocusPoolWindowSessions;
    const snapshot = await buildRadarSnapshot(watchlist);
    const stored = getDailyCandidateList(snapshot.tradeDate);
    const live = stored?.status === "frozen" ? null : await buildDailyCandidatePreviewFromRadar(watchlist);
    return json(response, 200, getDailyFocusPool(windowSessions, live ? { tradeDate: live.tradeDate, items: live.items } : null));
  }

  if (request.method === "GET" && url.pathname === "/api/daily-candidates/performance") {
    const rawWindow = url.searchParams.get("window") ?? "20";
    if (rawWindow !== "20" && rawWindow !== "60") return json(response, 400, { code: "BAD_WINDOW", message: "window 必须是 20 或 60", requestId });
    const rawCostBps = url.searchParams.get("cost_bps") ?? "0";
    const costBps = Number(rawCostBps);
    if (!Number.isSafeInteger(costBps) || costBps < 0 || costBps > 1_000) return json(response, 400, { code: "BAD_COST_BPS", message: "cost_bps 必须是 0–1000 的整数", requestId });
    return json(response, 200, getDailyCandidatePerformance(Number(rawWindow) as 20 | 60, costBps));
  }

  const stockMatch = url.pathname.match(/^\/api\/stocks\/(\d{6})$/);
  if (request.method === "GET" && stockMatch) {
    const snapshot = await buildRadarSnapshot(watchlist);
    const enrichedStocks = enrichStocksWithIndustry(snapshot.stocks, snapshot, snapshot.events, snapshot.asOf);
    const item = enrichedStocks.find((candidate) => candidate.code === stockMatch[1]);
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
  const fallbackDiscussionSources = defaultDiscussionSources();
  const byId = new Map((snapshot?.discussionSources ?? []).map((source) => [source.id, source]));
  const discussionSources = fallbackDiscussionSources.map((source) => byId.get(source.id) ?? source);
  return {
    mode: snapshot ? (partial ? "partial" : "live") : "unavailable",
    snapshotAsOf: snapshot?.asOf ?? new Date().toISOString(),
    marketStore: {
      connected: Boolean(snapshot), provider: snapshot ? `东方财富${snapshot.marketSourceTier === "primary" ? "实时接口" : "延迟接口"}` : "东方财富",
      tradeDate: snapshot?.tradeDate ?? null, rows: snapshot?.stocks.length ?? 0,
      detail: snapshot ? `${snapshot.marketStale ? "正在使用上一批完整真实行情" : "完整行情已通过校验并写入本地数据库"}，交易日 ${snapshot.tradeDate}${snapshot.marketStale ? marketSyncReason() : ""}` : "东方财富行情首次同步尚未完成",
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

/** 行情同步失败原因（精简展示，避免把完整 AggregateError 堆栈糊到页面上）。 */
function marketSyncReason(): string {
  const state = getProviderState("eastmoney_market");
  const raw = state?.error ?? "";
  if (!raw) return "";
  const cleaned = raw.replace(/\s+/g, " ").slice(0, 160);
  return `；行情同步失败：${cleaned}`;
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

function parseIndustryHorizon(value: string | null): 1 | 3 | 5 | 10 | undefined {
  const parsed = Number(value);
  return parsed === 1 || parsed === 3 || parsed === 5 || parsed === 10 ? parsed : undefined;
}

/**
 * 排序键：alert 异动分、direction 文本方向（正）、risk 文本方向（负）、attention
 * 讨论热度、consensus 观点共识、mentions 关联线索、pct 实时涨跌、market 市场表现。
 * 前缀 "-" 表示升序（小→大），默认降序。alert 的自选股优先不随方向反转。
 */
function compareStocks(a: StockSnapshot, b: StockSnapshot, sort: string) {
  const ascending = sort.startsWith("-");
  const key = ascending ? sort.slice(1) : sort;
  let result: number;
  if (key === "direction") result = (b.textDirectionScore ?? -1) - (a.textDirectionScore ?? -1);
  else if (key === "amount") result = b.amount - a.amount;
  else if (key === "attention") result = b.factors.attention - a.factors.attention;
  else if (key === "consensus") result = b.factors.consensus - a.factors.consensus;
  else if (key === "mentions") result = b.mentionCount - a.mentionCount;
  else if (key === "pct") result = b.pctChange - a.pctChange;
  else if (key === "risk") result = (a.textDirectionScore ?? 101) - (b.textDirectionScore ?? 101);
  else if (key === "industry_heat") result = (b.industryPulse?.textHeat ?? -1) - (a.industryPulse?.textHeat ?? -1);
  else if (key === "market") result = b.price * b.pctChange - a.price * a.pctChange;
  else {
    if (a.isWatchlisted !== b.isWatchlisted) return a.isWatchlisted ? -1 : 1;
    result = (b.alertScore ?? -1) - (a.alertScore ?? -1);
  }
  return ascending ? -result : result;
}

function enrichStocksWithIndustry(
  stocks: StockSnapshot[],
  snapshot: { events: SentimentEvent[]; asOf: string; clueAsOf: string; tradeDate: string },
  events: SentimentEvent[],
  asOf: string,
  analytics = buildIndustryAnalytics({ stocks, events, asOf, clueAsOf: snapshot.clueAsOf, tradeDate: snapshot.tradeDate }),
): StockSnapshot[] {
  const pulseByCode = new Map(analytics.items.map((pulse) => [pulse.profile.code, pulse]));
  const contributionByCode = new Map(analytics.stocks.map((item) => [item.code, item]));
  return stocks.map((stock) => {
    // 行情供应商未返回行业字段时，使用可解释的内置规则补齐当前快照的行业归属。
    // 这不是把今天的行业分类回填到历史行情：asOf 仍然绑定在当前快照时间上。
    const classifiedIndustry = stock.industry ?? classifyStockIndustry(stock);
    const industryCode = classifiedIndustry?.code;
    const pulse = industryCode ? pulseByCode.get(industryCode) : undefined;
    const contribution = contributionByCode.get(stock.code);
    return {
      ...stock,
      ...(classifiedIndustry
        ? { industry: { ...classifiedIndustry, asOf: stock.industry?.asOf ?? asOf } }
        : {}),
      ...(pulse ? { industryPulse: toIndustryPulseSummary(pulse, stock.industry?.asOf ?? asOf) } : {}),
      ...(contribution ? {
        industryAttribution: {
          industryReturn: contribution.industryReturn,
          marketReturn: contribution.marketReturn,
          marketExcess: contribution.marketExcess,
          industryPart: contribution.industryPart,
          stockSpecificPart: contribution.stockSpecificPart,
          state: contribution.state,
        },
      } : {}),
    };
  });
}

function toIndustryPulseSummary(pulse: ReturnType<typeof buildIndustryAnalytics>["items"][number], asOf: string) {
  return {
    ...pulse,
    profile: { ...pulse.profile, asOf },
  };
}

function withIndustryDashboard(dashboard: DashboardData, snapshot: { stocks: StockSnapshot[]; events: SentimentEvent[]; asOf: string; clueAsOf: string; tradeDate: string }): DashboardData {
  const analytics = buildIndustryAnalytics(snapshot);
  const enriched = enrichStocksWithIndustry(snapshot.stocks, snapshot, snapshot.events, snapshot.asOf, analytics);
  const byCode = new Map(enriched.map((stock) => [stock.code, stock]));
  return {
    ...dashboard,
    hotIndustries: analytics.items
      .filter((pulse) => pulse.textHeat >= 70 && (pulse.relation === "舆情交易双热" || pulse.relation === "舆情升温、价格未确认"))
      .slice(0, 8)
      .map((pulse) => toIndustryPulseSummary(pulse, snapshot.asOf)),
    watchlist: dashboard.watchlist.map((stock) => byCode.get(stock.code) ?? stock),
  };
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

function isRealCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
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

let shuttingDown = false;

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  console.log(`潮汐接口服务正在退出（${reason}）…`);

  stopScheduledRefresh();
  // 先立即断开 HTTP 长连接，确保监听端口不被请求拖住。
  server.closeIdleConnections?.();
  server.closeAllConnections?.();

  const cleanup = Promise.allSettled([
    new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    }),
    stopWeiboLiveSession(),
    stopXueqiuLiveSession(),
  ]);

  // 浏览器上下文关闭有自己的超时；进程退出最多等待 1 秒，避免 tsx watch 再次强杀。
  await Promise.race([
    cleanup,
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);
  process.exit(exitCode);
}

process.once("SIGINT", () => void shutdown("SIGINT", 0));
process.once("SIGTERM", () => void shutdown("SIGTERM", 0));

server.once("error", (error) => {
  const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "UNKNOWN";
  console.error(`潮汐接口服务启动失败（${code}）：${error instanceof Error ? error.message : String(error)}`);
  void shutdown("server-error", 1);
});

if (process.env.TIDE_DISABLE_LISTEN !== "1") {
  server.listen(port, host, () => {
    console.log(`潮汐接口服务已启动：http://${host}:${port}`);
    // 只有端口成功绑定后才启动后台抓取，避免启动失败时仍然拉起 Chrome/网络任务。
    startScheduledRefresh();
  });
}
