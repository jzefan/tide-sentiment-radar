import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { StockSnapshot } from "../src/domain/types.ts";
import { addToWatchlist, getClueCount, getEastMoneyDailyBars, getProviderState, getWatchlist, removeFromWatchlist, saveEastMoneyDailyBars, saveProviderState } from "./database.ts";
import { fetchEastMoneyDailyBars, fetchEastMoneyPeriodBars, fetchEastMoneyTrends } from "./eastMoneyMarket.ts";
import { buildDashboard, buildRadarSnapshot, stockEvents } from "./radarEngine.ts";

const port = Number(process.env.API_PORT || 8787);
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
    const watchlistOnly = url.searchParams.get("watchlist") === "only";
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get("page_size") || 50)));

    let items = snapshot.stocks.filter((item) => {
      const matchesQuery = !query || `${item.name}${item.code}${item.market}${item.topics.join("")}`.toLowerCase().includes(query);
      const matchesSignal = signal === "all" || item.signal === signal;
      const matchesMarket = market === "all" || item.market === market;
      return matchesQuery && matchesSignal && matchesMarket && (!watchlistOnly || item.isWatchlisted);
    });
    items = [...items].sort((a, b) => compareStocks(a, b, sort));
    const total = items.length;
    const start = (page - 1) * pageSize;
    return json(response, 200, {
      items: items.slice(start, start + pageSize),
      total,
      analyzed: snapshot.stocks.filter((item) => item.analysisStatus === "scored").length,
      page,
      pageSize,
      asOf: snapshot.asOf,
    });
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

function compareStocks(a: StockSnapshot, b: StockSnapshot, sort: string) {
  if (sort === "direction") return (b.radarScore ?? -1) - (a.radarScore ?? -1);
  if (sort === "attention") return b.factors.attention - a.factors.attention;
  if (sort === "mentions") return b.mentionCount - a.mentionCount;
  if (sort === "risk") return (a.radarScore ?? 101) - (b.radarScore ?? 101);
  if (sort === "market") return b.price * b.pctChange - a.price * a.pctChange;
  if (a.isWatchlisted !== b.isWatchlisted) return a.isWatchlisted ? -1 : 1;
  return (b.alertScore ?? -1) - (a.alertScore ?? -1);
}

function json(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
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
    response.end("请先运行 pnpm build，或在开发模式使用 pnpm dev。\n");
  }
}

server.listen(port, "127.0.0.1", () => {
  console.log(`潮汐接口服务已启动：http://127.0.0.1:${port}`);
});
