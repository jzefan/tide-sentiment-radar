import type { RawClue } from "./eastMoney.ts";
import { diagLog } from "./diagLog.ts";

/**
 * 东方财富个股新闻（纯 HTTP，无需登录）。
 *
 * 用 stock_news_em 同款搜索接口（search-api-web.eastmoney.com/search/jsonp），
 * 按股票名称检索该股近期新闻，归一化为 RawClue 并入线索管线。
 * 与「财经快讯」不同：这里按个股名称定向检索，相关性更强，用于补充个股舆情画像。
 */
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36";
const NEWS_CONCURRENCY = 8;
const NEWS_PER_STOCK = 3;
const MAX_NEWS_STOCKS = 120;
const RECENT_HOURS = 72;

interface EastMoneyNewsRow {
  date: string;
  code: string;
  title: string;
  content: string;
  mediaName: string;
  url: string;
}

/** 对重点股票（有名称的）逐只检索近期新闻，控制并发与数量，失败单只降级不阻断。 */
export async function fetchStockNews(codes: string[], names: Map<string, string>): Promise<RawClue[]> {
  const stocks = codes
    .filter((code) => /^\d{6}$/.test(code))
    .map((code) => ({ code, name: names.get(code)?.trim() ?? "" }))
    .filter((stock) => stock.name)
    .slice(0, MAX_NEWS_STOCKS);
  if (!stocks.length) return [];

  const cutoff = Date.now() - RECENT_HOURS * 3_600_000;
  const startedAt = Date.now();
  const items: RawClue[] = [];
  let failed = 0;
  for (let start = 0; start < stocks.length; start += NEWS_CONCURRENCY) {
    const batch = stocks.slice(start, start + NEWS_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((stock) => searchStockNews(stock.code, stock.name)));
    for (const result of results) {
      if (result.status === "fulfilled") items.push(...result.value);
      else failed++;
    }
  }
  const fresh = items.filter((item) => new Date(item.publishedAt).valueOf() >= cutoff);
  diagLog("news", "个股新闻检索完成", `${((Date.now() - startedAt) / 1000).toFixed(1)}s`, `覆盖 ${stocks.length} 只`, `线索 ${fresh.length} 条`, `失败 ${failed}`);
  return fresh;
}

async function searchStockNews(code: string, name: string): Promise<RawClue[]> {
  const param = {
    uid: "",
    keyword: name,
    type: ["cmsArticleWebOld"],
    client: "web",
    clientType: "web",
    clientVersion: "curr",
    param: {
      cmsArticleWebOld: {
        searchScope: "default",
        sort: "default",
        pageIndex: 1,
        pageSize: NEWS_PER_STOCK,
        preTag: "<em>",
        postTag: "</em>",
      },
    },
  };
  const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=${encodeURIComponent(JSON.stringify(param))}`;
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, referer: "https://so.eastmoney.com/", accept: "application/json,text/plain,*/*" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`个股新闻接口返回 ${response.status}`);
  const text = await response.text();
  const payload = parseJsonp<{ result?: { cmsArticleWebOld?: Array<Record<string, unknown>> } }>(text);
  const rows = (payload?.result?.cmsArticleWebOld ?? []) as unknown as EastMoneyNewsRow[];
  return rows.map((row) => mapNewsRow(row, code)).filter((item): item is RawClue => item !== null);
}

function mapNewsRow(row: EastMoneyNewsRow, code: string): RawClue | null {
  const id = String(row.code ?? "");
  const title = stripHtml(String(row.title ?? ""));
  if (!id || !title) return null;
  return {
    id: `个股新闻-${id}`,
    source: row.mediaName ? String(row.mediaName) : "东方财富新闻",
    sourceKind: "news",
    title: title.slice(0, 120),
    summary: stripHtml(String(row.content ?? title)).slice(0, 240),
    publishedAt: toIso(String(row.date ?? "")),
    url: String(row.url ?? `http://finance.eastmoney.com/a/${id}.html`),
    stockCodes: code ? [code] : [],
    interactionCount: 0,
  };
}

function parseJsonp<T>(text: string): T | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf("(");
  const end = trimmed.lastIndexOf(")");
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(trimmed.slice(start + 1, end)) as T;
  } catch {
    return null;
  }
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, "").replace(/&nbsp;|&amp;|&quot;|&#39;/g, " ").replace(/\s+/g, " ").trim();
}

function toIso(value: string) {
  const normalized = value.replace(/:(\d{3})$/, ".$1").replace(" ", "T");
  const date = new Date(normalized.includes("+") || normalized.endsWith("Z") ? normalized : `${normalized}+08:00`);
  return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
}
