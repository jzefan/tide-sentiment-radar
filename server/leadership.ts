/**
 * 龙头数据源：东方财富涨停板池与龙虎榜。
 *
 * 这两份公开数据是「当前时段龙头」唯一可核验的外部依据：涨停池给出连板数、
 * 首次/最后封板时间与炸板次数，龙虎榜给出当日上榜与净买额。接口只接受交易日
 * 参数，且返回载荷里没有任何字段能反过来证明数据属于哪一天（`qdate` 是服务器
 * 当天日期，不是数据日期），因此本模块只负责解析与派生；请求日期是否成立必须
 * 由调用方用本地已保存的同日行情逐条比对（见 leadershipSync.ts），比对不通过
 * 就不落库，绝不把未经证明的数据写进池子。
 */

export type LeadershipExchange = "SH" | "SZ" | "BJ";

export interface LimitUpRecord {
  code: string;
  name: string;
  exchange: LeadershipExchange;
  tradeDate: string;
  /** 收盘价（元）；涨停池按 1/1000 元返回，这里已归一。 */
  close: number | null;
  pctChange: number | null;
  amount: number | null;
  turnover: number | null;
  floatMarketCap: number | null;
  /** 连板数；1 为首板。 */
  boardCount: number;
  /** 涨停统计「几天几板」中的天数。 */
  statDays: number | null;
  statCount: number | null;
  /** 首次封板时间，HH:MM:SS。 */
  firstSealTime: string | null;
  lastSealTime: string | null;
  /** 当日炸板次数。 */
  breakCount: number;
  /** 封单资金（元）。 */
  sealAmount: number | null;
  /** 东方财富行业板块短名，仅作兜底；调用方优先使用本地行情的行业名。 */
  industryName: string | null;
  sourceUrl: string;
}

export interface DragonTigerRecord {
  code: string;
  name: string;
  tradeDate: string;
  close: number | null;
  pctChange: number | null;
  /** 取上榜原因中净买额绝对值最大的一条，避免同一席位明细被重复累加。 */
  netAmount: number | null;
  buyAmount: number | null;
  sellAmount: number | null;
  dealAmount: number | null;
  turnover: number | null;
  /** 当日全部上榜原因的去重列表。 */
  reasons: string[];
  /** 交易所给出的上榜说明去重列表。 */
  explanations: string[];
  /** 当日按原因拆分的上榜条数。 */
  listCount: number;
  sourceUrl: string;
}

/** 一只股票在一个交易日的龙头事实（涨停池与龙虎榜合并后）。 */
export interface LeadershipDayRow {
  code: string;
  name: string;
  tradeDate: string;
  industryName: string | null;
  /** 0 表示当日未涨停（可能只上了龙虎榜）。 */
  boardCount: number;
  firstSealTime: string | null;
  lastSealTime: string | null;
  breakCount: number;
  sealAmount: number | null;
  amount: number | null;
  dragonTiger: {
    netAmount: number | null;
    buyAmount: number | null;
    sellAmount: number | null;
    reasons: string[];
    listCount: number;
  } | null;
}

export type LeadershipTier = "market" | "industry" | "none";

export interface DailyLeaderMark {
  tier: Exclude<LeadershipTier, "none">;
  boardCount: number;
  firstSealTime: string | null;
  reasons: string[];
}

export interface DailyLeaders {
  tradeDate: string;
  maxBoardCount: number;
  limitUpCount: number;
  /** 行业名 → 当日涨停家数。 */
  industryLimitUpCounts: Record<string, number>;
  /** 股票代码 → 龙头标记（市场龙头优先于行业龙头）。 */
  marks: Record<string, DailyLeaderMark>;
}

export interface QuoteForVerification {
  code: string;
  price: number | null;
  pctChange: number | null;
  /** 行情批次时间；用于判断这一批是收盘批次还是盘中批次。 */
  quoteAt?: string | null;
}

export type LeadershipVerificationMode = "close" | "intraday";

export interface LeadershipVerification {
  verified: boolean;
  mode: LeadershipVerificationMode | null;
  reason: string | null;
  comparable: number;
  matched: number;
  /** 与涨停池完全一致之外、仅因盘中时点差而放行的条数。 */
  timing: number;
  mismatched: string[];
}

const ZT_POOL_ENDPOINT = "https://push2ex.eastmoney.com/getTopicZTPool";
const ZT_POOL_UT = "7eea3edcaed734bea9cbfc24409ed989";
const BILLBOARD_ENDPOINT = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";
const MAX_POOL_PAGES = 6;
const MAX_BILLBOARD_PAGES = 20;

const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
};
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

/** 把 92500 / "143946" 这类 HHMMSS 整数归一为 HH:MM:SS；非法值返回 null。 */
export function normalizeSealTime(value: unknown): string | null {
  const number = finite(value);
  if (number === null || number <= 0) return null;
  const padded = String(Math.trunc(number)).padStart(6, "0");
  const hours = Number(padded.slice(0, 2));
  const minutes = Number(padded.slice(2, 4));
  const seconds = Number(padded.slice(4, 6));
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || !Number.isInteger(seconds)) return null;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return `${padded.slice(0, 2)}:${padded.slice(2, 4)}:${padded.slice(4, 6)}`;
}

/** 距开盘（09:25 集合竞价结束）的分钟数，用于「封板越早越强」的可比口径。 */
export function sealMinutesFromOpen(time: string | null): number | null {
  if (!time) return null;
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]) - (9 * 60 + 25);
}

function exchangeOf(market: unknown): LeadershipExchange {
  const value = finite(market);
  if (value === 1) return "SH";
  if (value === 2) return "BJ";
  return "SZ";
}

/** 解析涨停板池载荷；非交易日（tc=0 / data 为 null）返回空数组。 */
export function parseLimitUpPoolPayload(payload: unknown, tradeDate: string): LimitUpRecord[] {
  const body = record(payload);
  if (Number(body.rc) !== 0) throw new Error(`涨停板池接口返回 rc=${String(body.rc)}`);
  const data = record(body.data);
  const rows = Array.isArray(data.pool) ? data.pool.map(record) : [];
  const sourceUrl = `${ZT_POOL_ENDPOINT}?date=${tradeDate.replace(/-/g, "")}`;
  const parsed: LimitUpRecord[] = [];
  for (const row of rows) {
    const code = text(row.c);
    const name = text(row.n);
    if (!code || !name || !/^\d{6}$/.test(code)) continue;
    const rawPrice = finite(row.p);
    const stat = record(row.zttj);
    const boardCount = Math.max(1, Math.trunc(finite(row.lbc) ?? 1));
    const statDays = finite(stat.days);
    const statCount = finite(stat.ct);
    parsed.push({
      code,
      name,
      exchange: exchangeOf(row.m),
      tradeDate,
      close: rawPrice === null ? null : Math.round(rawPrice) / 1000,
      pctChange: finite(row.zdp),
      amount: finite(row.amount),
      turnover: finite(row.hs),
      floatMarketCap: finite(row.ltsz),
      boardCount,
      statDays: statDays === null ? null : Math.trunc(statDays),
      statCount: statCount === null ? null : Math.trunc(statCount),
      firstSealTime: normalizeSealTime(row.fbt),
      lastSealTime: normalizeSealTime(row.lbt),
      breakCount: Math.max(0, Math.trunc(finite(row.zbc) ?? 0)),
      sealAmount: finite(row.fund),
      industryName: text(row.hybk),
      sourceUrl,
    });
  }
  return parsed.sort((left, right) => right.boardCount - left.boardCount
    || (sealMinutesFromOpen(left.firstSealTime) ?? Number.POSITIVE_INFINITY) - (sealMinutesFromOpen(right.firstSealTime) ?? Number.POSITIVE_INFINITY)
    || left.code.localeCompare(right.code));
}

/** 解析龙虎榜明细载荷，按股票聚合上榜原因。 */
export function parseDragonTigerPayload(payload: unknown, tradeDate: string): DragonTigerRecord[] {
  const body = record(payload);
  const result = record(body.result);
  const rows = Array.isArray(result.data) ? result.data.map(record) : [];
  const sourceUrl = `${BILLBOARD_ENDPOINT}?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&filter=(TRADE_DATE='${tradeDate}')`;
  const grouped = new Map<string, DragonTigerRecord>();
  for (const row of rows) {
    const code = text(row.SECURITY_CODE);
    if (!code || !/^\d{6}$/.test(code)) continue;
    const reason = text(row.EXPLANATION);
    const explanation = text(row.EXPLAIN);
    const netAmount = finite(row.BILLBOARD_NET_AMT);
    const current = grouped.get(code) ?? {
      code,
      name: text(row.SECURITY_NAME_ABBR) ?? code,
      tradeDate,
      close: finite(row.CLOSE_PRICE),
      pctChange: finite(row.CHANGE_RATE),
      netAmount: null,
      buyAmount: null,
      sellAmount: null,
      dealAmount: null,
      turnover: finite(row.TURNOVERRATE),
      reasons: [],
      explanations: [],
      listCount: 0,
      sourceUrl,
    };
    // 同一股票可能因多个原因各有一条记录，金额字段是同一份席位明细的重复呈现，
    // 因此只保留净买额绝对值最大的一条作为该股当日金额，原因则全部保留。
    if (current.netAmount === null || Math.abs(netAmount ?? 0) > Math.abs(current.netAmount)) {
      current.netAmount = netAmount;
      current.buyAmount = finite(row.BILLBOARD_BUY_AMT);
      current.sellAmount = finite(row.BILLBOARD_SELL_AMT);
      current.dealAmount = finite(row.BILLBOARD_DEAL_AMT);
      current.close = finite(row.CLOSE_PRICE) ?? current.close;
      current.pctChange = finite(row.CHANGE_RATE) ?? current.pctChange;
      current.turnover = finite(row.TURNOVERRATE) ?? current.turnover;
    }
    if (reason && !current.reasons.includes(reason)) current.reasons.push(reason);
    if (explanation && !current.explanations.includes(explanation)) current.explanations.push(explanation);
    current.listCount += 1;
    grouped.set(code, current);
  }
  return [...grouped.values()].sort((left, right) => Math.abs(right.netAmount ?? 0) - Math.abs(left.netAmount ?? 0) || left.code.localeCompare(right.code));
}

/** 合并涨停池与龙虎榜为统一的「当日龙头事实」，行业名可由调用方用本地行情覆盖。 */
export function mergeLeadershipDay(
  limitUp: LimitUpRecord[],
  dragonTiger: DragonTigerRecord[],
  tradeDate: string,
  industryByCode?: Map<string, string | null>,
): LeadershipDayRow[] {
  const rows = new Map<string, LeadershipDayRow>();
  for (const item of limitUp) {
    rows.set(item.code, {
      code: item.code,
      name: item.name,
      tradeDate,
      industryName: industryByCode?.get(item.code) ?? item.industryName,
      boardCount: item.boardCount,
      firstSealTime: item.firstSealTime,
      lastSealTime: item.lastSealTime,
      breakCount: item.breakCount,
      sealAmount: item.sealAmount,
      amount: item.amount,
      dragonTiger: null,
    });
  }
  for (const item of dragonTiger) {
    const current = rows.get(item.code);
    const dragonTigerValue = {
      netAmount: item.netAmount,
      buyAmount: item.buyAmount,
      sellAmount: item.sellAmount,
      reasons: [...item.reasons],
      listCount: item.listCount,
    };
    if (current) {
      current.dragonTiger = dragonTigerValue;
      continue;
    }
    rows.set(item.code, {
      code: item.code,
      name: item.name,
      tradeDate,
      industryName: industryByCode?.get(item.code) ?? null,
      boardCount: 0,
      firstSealTime: null,
      lastSealTime: null,
      breakCount: 0,
      sealAmount: null,
      amount: null,
      dragonTiger: dragonTigerValue,
    });
  }
  return [...rows.values()].sort((left, right) => right.boardCount - left.boardCount
    || (sealMinutesFromOpen(left.firstSealTime) ?? Number.POSITIVE_INFINITY) - (sealMinutesFromOpen(right.firstSealTime) ?? Number.POSITIVE_INFINITY)
    || left.code.localeCompare(right.code));
}

const MARKET_LEADER_LIMIT = 3;
const INDUSTRY_LEADER_MIN_LIMIT_UPS = 2;

const leaderRank = (left: LeadershipDayRow, right: LeadershipDayRow) => right.boardCount - left.boardCount
  || (sealMinutesFromOpen(left.firstSealTime) ?? Number.POSITIVE_INFINITY) - (sealMinutesFromOpen(right.firstSealTime) ?? Number.POSITIVE_INFINITY)
  || (right.amount ?? 0) - (left.amount ?? 0)
  || left.code.localeCompare(right.code);

/**
 * 龙头判定（只使用当日可核验事实，规则固定且可复核）：
 * - 市场龙头：当日连板数 ≥ 2，且连板高度进入全市场最高梯队（最高 5 板时取 4–5 板），
 *   按「连板数 → 首次封板时间 → 成交额」排序取前三名；
 * - 行业龙头：所属行业当日涨停 ≥ 2 家，且是该行业内连板最高、封板最早的一只（同样要求 ≥ 2 板）。
 * 首板不标龙头：单日涨停无法证明「当前时段的领涨地位」。
 */
export function deriveDailyLeaders(rows: LeadershipDayRow[], tradeDate: string): DailyLeaders {
  const limitUps = rows.filter((row) => row.boardCount >= 1);
  const maxBoardCount = limitUps.reduce((max, row) => Math.max(max, row.boardCount), 0);
  const industryLimitUpCounts: Record<string, number> = {};
  for (const row of limitUps) {
    const name = row.industryName?.trim();
    if (!name) continue;
    industryLimitUpCounts[name] = (industryLimitUpCounts[name] ?? 0) + 1;
  }
  const marks: Record<string, DailyLeaderMark> = {};
  const heightFloor = maxBoardCount >= 3 ? maxBoardCount - 1 : 2;
  const marketCandidates = limitUps
    .filter((row) => row.boardCount >= 2 && row.boardCount >= heightFloor)
    .sort(leaderRank)
    .slice(0, MARKET_LEADER_LIMIT);
  for (const row of marketCandidates) {
    const reasons = [`当日 ${row.boardCount} 连板，为全市场最高梯队（最高 ${maxBoardCount} 板）`];
    if (row.firstSealTime) reasons.push(`首次封板 ${row.firstSealTime}`);
    reasons.push(row.breakCount > 0 ? `封板后炸板 ${row.breakCount} 次` : "封板后未打开");
    if (row.dragonTiger) reasons.push(row.dragonTiger.netAmount !== null && row.dragonTiger.netAmount > 0 ? `龙虎榜净买 ${formatAmount(row.dragonTiger.netAmount)}` : "当日登上龙虎榜");
    marks[row.code] = { tier: "market", boardCount: row.boardCount, firstSealTime: row.firstSealTime, reasons };
  }
  const byIndustry = new Map<string, LeadershipDayRow[]>();
  for (const row of limitUps) {
    const name = row.industryName?.trim();
    if (!name || (industryLimitUpCounts[name] ?? 0) < INDUSTRY_LEADER_MIN_LIMIT_UPS) continue;
    byIndustry.set(name, [...(byIndustry.get(name) ?? []), row]);
  }
  for (const [industryName, members] of byIndustry) {
    // 已经进入市场龙头的不再重复标记，行业内龙头顺延给该行业下一只高位连板股。
    const leader = [...members].sort(leaderRank).find((row) => row.boardCount >= 2 && !marks[row.code]);
    if (!leader) continue;
    const reasons = [`${industryName} 当日涨停 ${industryLimitUpCounts[industryName]} 家`, `行业内连板最高（${leader.boardCount} 板）`];
    if (leader.firstSealTime) reasons.push(`首次封板 ${leader.firstSealTime}`);
    marks[leader.code] = { tier: "industry", boardCount: leader.boardCount, firstSealTime: leader.firstSealTime, reasons };
  }
  return { tradeDate, maxBoardCount, limitUpCount: limitUps.length, industryLimitUpCounts, marks };
}

/** 龙头层级的中文标签；首板不算龙头，只描述连板高度。 */
export function leadershipLabel(tier: LeadershipTier, boardCount: number): string | null {
  if (tier === "market") return `${boardCount} 连板 · 市场龙头`;
  if (tier === "industry") return `${boardCount} 连板 · 行业龙头`;
  return boardCount >= 1 ? `${boardCount} 连板` : null;
}

export function formatAmount(value: number): string {
  const absolute = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (absolute >= 100_000_000) return `${sign}${(absolute / 100_000_000).toFixed(2)} 亿元`;
  if (absolute >= 10_000) return `${sign}${(absolute / 10_000).toFixed(0)} 万元`;
  return `${value.toFixed(0)} 元`;
}

/**
 * 用本地同日行情核对涨停池。
 *
 * 接口无法自证数据日期，唯一可用的证明就是与本地同日行情逐条对齐：
 * - `close` 模式（本地行情是收盘批次）：价格与涨跌幅必须全部对上；
 * - `intraday` 模式（仅用于当天盘中）：涨停池与行情批次相隔几秒，允许「行情快照取到涨停之前」
 *   这一种单向时点差，但要求至少六成完全一致，且绝不允许行情价格高于涨停池价格
 *   （那意味着本地快照比涨停池更新，无法用时间差解释）。
 * 无法提供任何可比对样本、或本地行情不是收盘批次又不在当天时，一律判定不可信。
 */
export function verifyLimitUpAgainstQuotes(
  rows: LimitUpRecord[],
  quotes: QuoteForVerification[],
  options: { mode?: LeadershipVerificationMode; finalized?: boolean } = {},
): LeadershipVerification {
  const byCode = new Map(quotes.map((quote) => [quote.code, quote]));
  const mismatched: string[] = [];
  let matched = 0;
  let timing = 0;
  for (const row of rows) {
    const quote = byCode.get(row.code);
    if (!quote || quote.price === null || row.close === null) continue;
    const priceTolerance = Math.max(0.011, Math.abs(quote.price) * 0.002);
    const priceOk = Math.abs(row.close - quote.price) <= priceTolerance;
    const pctOk = quote.pctChange === null || row.pctChange === null || Math.abs(row.pctChange - quote.pctChange) <= 0.6;
    if (priceOk && pctOk) {
      matched += 1;
      continue;
    }
    const intraday = options.mode === "intraday" && options.finalized !== true;
    // 盘中：行情批次早于涨停池写入，所以只允许「行情还在涨停价下方」这一种方向。
    const timingOk = intraday
      && quote.price <= row.close + priceTolerance
      && quote.pctChange !== null && row.pctChange !== null
      && quote.pctChange <= row.pctChange + 0.6;
    if (timingOk) timing += 1;
    else mismatched.push(row.code);
  }
  const comparable = matched + timing + mismatched.length;
  const empty = { mode: null, comparable, matched, timing, mismatched };
  if (!rows.length) return { verified: false, ...empty, reason: "涨停板池当日为空，无需入库" };
  if (!comparable) return { verified: false, ...empty, reason: "本地没有同日行情可比对，无法证明涨停池日期" };
  const required = Math.min(5, rows.length);
  if (comparable < required) return { verified: false, ...empty, reason: `可比对样本不足（${comparable}/${required}）` };
  if (mismatched.length) return { verified: false, ...empty, reason: `有 ${mismatched.length} 只涨停股与本地行情不一致` };
  if (timing > matched) return { verified: false, ...empty, reason: `盘中时点差过多（${timing}/${comparable}），无法确认同一批次` };
  const mode: LeadershipVerificationMode = options.mode === "intraday" && options.finalized !== true ? "intraday" : "close";
  return { verified: true, mode, comparable, matched, timing, mismatched, reason: null };
}

async function fetchJson(url: string, referer: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, referer, accept: "application/json,text/plain,*/*" },
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`龙头数据源返回 ${response.status}`);
  return response.json();
}

export interface LeadershipFetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** 抓取指定交易日的涨停板池（按首次封板时间升序分页取全）。 */
export async function fetchLimitUpPool(tradeDate: string, options: LeadershipFetchOptions = {}): Promise<LimitUpRecord[]> {
  const timeoutMs = options.timeoutMs ?? 12_000;
  const compactDate = tradeDate.replace(/-/g, "");
  const collected: LimitUpRecord[] = [];
  let expected = Number.POSITIVE_INFINITY;
  for (let page = 0; page < MAX_POOL_PAGES; page += 1) {
    const params = new URLSearchParams({
      ut: ZT_POOL_UT,
      dpt: "wz.ztzt",
      Pageindex: String(page),
      pagesize: "300",
      sort: "fbt:asc",
      date: compactDate,
    });
    const payload = options.fetchImpl
      ? await options.fetchImpl(`${ZT_POOL_ENDPOINT}?${params}`, { headers: { "user-agent": USER_AGENT, referer: "https://quote.eastmoney.com/" } }).then((response) => response.json())
      : await fetchJson(`${ZT_POOL_ENDPOINT}?${params}`, "https://quote.eastmoney.com/", timeoutMs, options.signal);
    const data = record(record(payload).data);
    expected = finite(data.tc) ?? 0;
    const pageRows = parseLimitUpPoolPayload(payload, tradeDate);
    collected.push(...pageRows);
    if (!pageRows.length || collected.length >= expected) break;
  }
  const deduped = new Map(collected.map((row) => [row.code, row]));
  return [...deduped.values()];
}

/** 抓取指定交易日的龙虎榜明细（按页取全）。 */
export async function fetchDragonTiger(tradeDate: string, options: LeadershipFetchOptions = {}): Promise<DragonTigerRecord[]> {
  const timeoutMs = options.timeoutMs ?? 12_000;
  const collected: DragonTigerRecord[] = [];
  let pages = 1;
  for (let page = 1; page <= Math.min(pages, MAX_BILLBOARD_PAGES); page += 1) {
    const params = new URLSearchParams({
      sortColumns: "SECURITY_CODE",
      sortTypes: "1",
      pageSize: "500",
      pageNumber: String(page),
      reportName: "RPT_DAILYBILLBOARD_DETAILSNEW",
      columns: "ALL",
      source: "WEB",
      client: "WEB",
      filter: `(TRADE_DATE='${tradeDate}')`,
    });
    const url = `${BILLBOARD_ENDPOINT}?${params}`;
    const payload = options.fetchImpl
      ? await options.fetchImpl(url, { headers: { "user-agent": USER_AGENT, referer: "https://data.eastmoney.com/" } }).then((response) => response.json())
      : await fetchJson(url, "https://data.eastmoney.com/", timeoutMs, options.signal);
    const result = record(record(payload).result);
    pages = Math.max(1, Math.trunc(finite(result.pages) ?? 1));
    const pageRows = parseDragonTigerPayload(payload, tradeDate);
    collected.push(...pageRows);
    if (!pageRows.length) break;
  }
  const deduped = new Map(collected.map((row) => [row.code, row]));
  return [...deduped.values()];
}
