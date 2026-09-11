import type { DailyCandidateEntry } from "./database.ts";
import { deriveDailyLeaders, leadershipLabel, type LeadershipDayRow } from "./leadership.ts";

export type DailyFocusPoolTrendDirection = "strong-up" | "up" | "weakening" | "repairing" | "down" | "flat" | "insufficient";
export type DailyFocusPoolWindowSessions = 2 | 3 | 4 | 5;

export interface DailyFocusPoolQuote {
  code: string;
  name: string;
  tradeDate: string;
  price: number | null;
  pctChange: number | null;
  amount: number | null;
  industryName: string | null;
  quoteAt: string;
}

export interface DailyFocusPoolIndustryLink {
  code: string;
  name: string;
  relevance: number;
}

export interface DailyFocusPoolSource {
  tradeDates: string[];
  windowSessions?: DailyFocusPoolWindowSessions;
  /** 观察截止日；缺省或不在留存交易日内时按最新交易日处理。 */
  windowEndDate?: string | null;
  /** 可选择的观察截止日（倒序，含最新），用于界面上的日期下拉。 */
  availableTradeDates?: string[];
  /** 最新已留存交易日；调用方只传窗口内的日期时用它区分“历史窗口”。 */
  latestTradeDate?: string | null;
  /** 当前交易日实时预览名单的日期；不传表示窗口内只有正式冻结名单。 */
  livePreviewDate?: string | null;
  lists: Array<{ tradeDate: string; items: DailyCandidateEntry[] }>;
  quotesByDate: Map<string, DailyFocusPoolQuote[]>;
  clueIndustriesById?: Map<string, DailyFocusPoolIndustryLink[]>;
  /** 逐日龙头事实（涨停池 + 龙虎榜），用于在池子里标注龙头；缺失表示该日尚未取证。 */
  leadershipByDate?: Map<string, LeadershipDayRow[]>;
}

/** 池内一只股票在观察窗口内的龙头表现。 */
export interface DailyFocusPoolLeadership {
  isLeader: boolean;
  tier: "market" | "industry" | null;
  label: string | null;
  maxBoardCount: number | null;
  limitUpDates: string[];
  dragonTigerDates: string[];
  /** 最近一个涨停日的首次封板时间。 */
  lastFirstSealTime: string | null;
  reasons: string[];
}

export interface DailyFocusPoolItem {
  code: string;
  name: string;
  focusDates: string[];
  consecutiveDays: 1 | 2 | 3 | 4 | 5;
  firstFocusDate: string;
  lastFocusDate: string;
  sessionsSinceFocus: number;
  isHotIndustry: boolean;
  industries: Array<{ code: string; name: string; hot: boolean; source: "primary" | "clue" }>;
  dailyChanges: Array<{ tradeDate: string; price: number | null; pctChange: number | null }>;
  priceHistory: Array<{ tradeDate: string; price: number; pctChange: number | null; amount: number | null }>;
  entryPrice: number | null;
  latestPrice: number | null;
  windowPctChange: number | null;
  upDays: number;
  downDays: number;
  flatDays: number;
  trend: { direction: DailyFocusPoolTrendDirection; label: string; summary: string };
  leadership: DailyFocusPoolLeadership;
}

export interface DailyFocusPoolResponse {
  window: {
    start: string | null;
    end: string | null;
    tradeDates: string[];
    sessions: DailyFocusPoolWindowSessions;
    maxSessions: 5;
    /** 最新已留存交易日，用于“回到最新”和历史窗口提示。 */
    latestTradeDate: string | null;
    /** 可锚定的观察截止日（倒序，含最新）。 */
    availableTradeDates: string[];
    /** 当前窗口是否以最新交易日结束。 */
    isLatest: boolean;
    /** 窗口内实际有聚焦名单的日期（来源可审计：池子只由这些日期的聚焦名单构成）。 */
    listDates: string[];
    /** 当前交易日的实时预览日期；历史窗口或无预览时为 null。 */
    livePreviewDate: string | null;
  };
  asOf: string | null;
  items: DailyFocusPoolItem[];
  stats: {
    total: number;
    priced: number;
    up: number;
    down: number;
    flat: number;
    upRatio: number | null;
    downRatio: number | null;
    hotIndustry: number;
    hotIndustryRatio: number | null;
    leaders: number;
    leaderRatio: number | null;
  };
}

const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const round = (value: number) => Math.round(value * 10_000) / 10_000;

function analyzeTrend(history: DailyFocusPoolItem["priceHistory"], windowPctChange: number | null): DailyFocusPoolItem["trend"] {
  if (!history.length || windowPctChange === null) return { direction: "insufficient", label: "数据不足", summary: "窗口内有效价格不足，暂不判断趋势。" };
  if (history.length === 1) {
    if (windowPctChange > 0) return { direction: "up", label: "当日走强", summary: `只有 1 个有效交易日：当日 +${windowPctChange.toFixed(2)}%，趋势要等下一个交易日才成立。` };
    if (windowPctChange < 0) return { direction: "down", label: "当日转弱", summary: `只有 1 个有效交易日：当日 ${windowPctChange.toFixed(2)}%，趋势要等下一个交易日才成立。` };
    return { direction: "flat", label: "当日平盘", summary: "只有 1 个有效交易日且价格持平，趋势待确认。" };
  }
  const pct = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
  const changeLabelOf = (value: number | null) => value === null ? "—" : pct(value);
  const latestDay = history.at(-1)?.pctChange ?? 0;
  const previousDay = history.at(-2)?.pctChange ?? 0;
  const recent = history.slice(-3);
  const recentRise = recent.length >= 2 && recent.at(-1)!.price > recent[0]!.price;
  const recentFall = recent.length >= 2 && recent.at(-1)!.price < recent[0]!.price;
  const upDays = history.filter((point) => (point.pctChange ?? 0) > 0).length;
  const downDays = history.filter((point) => (point.pctChange ?? 0) < 0).length;
  const days = `窗口 ${history.length} 个交易日：${upDays} 涨 / ${downDays} 跌`;
  if (windowPctChange >= 5 && recentRise && upDays >= downDays) {
    return { direction: "strong-up", label: "强势上行", summary: `累计 ${pct(windowPctChange)}，${days}，且价格重心仍在抬高；最新一日 ${changeLabelOf(latestDay)}。` };
  }
  if (windowPctChange > 0 && recentRise && latestDay >= 0) {
    return { direction: "up", label: "震荡上行", summary: `累计 ${pct(windowPctChange)}，${days}，最近 3 个交易日价格抬高，最新一日 ${changeLabelOf(latestDay)}。` };
  }
  if (windowPctChange > 0) {
    return { direction: "weakening", label: "上涨趋缓", summary: `累计仍为 ${pct(windowPctChange)}，但最新一日 ${changeLabelOf(latestDay)}（前一日 ${changeLabelOf(previousDay)}），上涨动能减弱。` };
  }
  if (windowPctChange < 0 && latestDay > 0) {
    return { direction: "repairing", label: "下跌修复", summary: `累计 ${pct(windowPctChange)}，最新一日 ${changeLabelOf(latestDay)} 出现修复，${recentRise ? "最近 3 日价格回升" : "但尚未收复窗口跌幅"}。` };
  }
  if (windowPctChange < 0) {
    return { direction: "down", label: "弱势下行", summary: `累计 ${pct(windowPctChange)}，${days}${recentFall ? "，最近 3 个交易日价格继续走低" : ""}，最新一日 ${changeLabelOf(latestDay)}。` };
  }
  const range = Math.max(...history.map((point) => point.price)) - Math.min(...history.map((point) => point.price));
  const rangePct = history[0]!.price > 0 ? (range / history[0]!.price) * 100 : 0;
  return { direction: "flat", label: "横盘整理", summary: `累计约 ${pct(windowPctChange)}，${days}，窗口振幅约 ${rangePct.toFixed(2)}%。` };
}

export function buildDailyFocusPool(source: DailyFocusPoolSource): DailyFocusPoolResponse {
  const windowSessions = source.windowSessions ?? 5;
  const allTradeDates = [...new Set(source.tradeDates)].sort();
  const latestTradeDate = source.latestTradeDate ?? allTradeDates.at(-1) ?? null;
  // 观察截止日可以指向任一已留存交易日：窗口取“截止日及之前”的最后 N 个交易日，
  // 因此点击窗口里的日期等价于把窗口末端移到那天。
  const anchorDate = source.windowEndDate && allTradeDates.includes(source.windowEndDate) ? source.windowEndDate : null;
  const anchorIndex = anchorDate ? allTradeDates.lastIndexOf(anchorDate) : allTradeDates.length - 1;
  const tradeDates = (anchorIndex >= 0 ? allTradeDates.slice(0, anchorIndex + 1) : []).slice(-windowSessions);
  const dateIndex = new Map(tradeDates.map((date, index) => [date, index]));
  const occurrences = new Map<string, Array<{ tradeDate: string; item: DailyCandidateEntry }>>();
  for (const list of source.lists.filter((value) => dateIndex.has(value.tradeDate))) {
    for (const item of list.items) {
      const values = occurrences.get(item.code) ?? [];
      values.push({ tradeDate: list.tradeDate, item });
      occurrences.set(item.code, values);
    }
  }
  const quoteMaps = new Map(tradeDates.map((date) => [date, new Map((source.quotesByDate.get(date) ?? []).map((quote) => [quote.code, quote]))]));
  // 龙头事实按日派生：只有已取证（涨停池通过本地行情核对入库）的日期才有记录，
  // 未取证日期不会让股票被标成或不被标成龙头，而是在行内显示“龙头待确认”。
  const leadershipRowsByDate = new Map<string, Map<string, LeadershipDayRow>>();
  const leadersByDate = new Map<string, ReturnType<typeof deriveDailyLeaders>>();
  for (const date of tradeDates) {
    const rows = source.leadershipByDate?.get(date) ?? [];
    if (!rows.length) continue;
    leadershipRowsByDate.set(date, new Map(rows.map((row) => [row.code, row])));
    leadersByDate.set(date, deriveDailyLeaders(rows, date));
  }
  const leadershipOf = (code: string): DailyFocusPoolLeadership => {
    const limitUpDates: string[] = [];
    const dragonTigerDates: string[] = [];
    const reasons: string[] = [];
    let maxBoardCount = 0;
    let lastFirstSealTime: string | null = null;
    let tier: "market" | "industry" | null = null;
    for (const date of tradeDates) {
      const row = leadershipRowsByDate.get(date)?.get(code);
      if (!row) continue;
      if (row.boardCount >= 1) {
        limitUpDates.push(date);
        maxBoardCount = Math.max(maxBoardCount, row.boardCount);
        if (row.firstSealTime) lastFirstSealTime = row.firstSealTime;
      }
      if (row.dragonTiger) dragonTigerDates.push(date);
      const mark = leadersByDate.get(date)?.marks[code];
      if (!mark) continue;
      if (mark.tier === "market") tier = "market";
      else if (tier !== "market") tier = "industry";
      // 逐日保留判定依据：同一个理由在不同日期可能有不同数值，不能跨日去重。
      for (const reason of mark.reasons) {
        const scoped = `${date.slice(5)}：${reason}`;
        if (!reasons.includes(scoped)) reasons.push(scoped);
      }
    }
    if (maxBoardCount >= 1 && !reasons.length) reasons.push(`窗口内最高 ${maxBoardCount} 连板`);
    if (dragonTigerDates.length) reasons.push(`窗口内 ${dragonTigerDates.length} 个交易日登上龙虎榜`);
    return {
      isLeader: tier !== null,
      tier,
      label: leadershipLabel(tier ?? "none", maxBoardCount),
      maxBoardCount: maxBoardCount > 0 ? maxBoardCount : null,
      limitUpDates,
      dragonTigerDates,
      lastFirstSealTime,
      reasons: reasons.slice(0, 6),
    };
  };
  const items = [...occurrences.entries()].map(([code, rawOccurrences]): DailyFocusPoolItem => {
    const values = rawOccurrences.sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
    const focusDates = [...new Set(values.map((value) => value.tradeDate))];
    const focusSet = new Set(focusDates);
    const lastFocusDate = focusDates.at(-1)!;
    const lastFocusIndex = dateIndex.get(lastFocusDate) ?? tradeDates.length - 1;
    let consecutiveDays = 0;
    for (let index = lastFocusIndex; index >= 0 && focusSet.has(tradeDates[index]!); index -= 1) consecutiveDays += 1;
    const boundedConsecutiveDays = Math.max(1, Math.min(5, consecutiveDays)) as 1 | 2 | 3 | 4 | 5;
    const firstFocusDate = focusDates[0]!;
    const dailyChanges = tradeDates.map((date) => {
      const quote = quoteMaps.get(date)?.get(code);
      return { tradeDate: date, price: finite(quote?.price), pctChange: finite(quote?.pctChange) };
    });
    const priceHistory = dailyChanges.flatMap((point) => point.price === null
      ? []
      : [{ ...point, price: point.price, amount: finite(quoteMaps.get(point.tradeDate)?.get(code)?.amount) }]);
    const entryPrice = priceHistory[0]?.price ?? null;
    const latestPrice = priceHistory.at(-1)?.price ?? null;
    const dailyPctChanges = dailyChanges.map((point) => point.pctChange);
    const windowPctChange = dailyPctChanges.every((value): value is number => value !== null)
      ? round((dailyPctChanges.reduce((value, pctChange) => value * (1 + pctChange / 100), 1) - 1) * 100)
      : null;
    const industryMap = new Map<string, { code: string; name: string; hot: boolean; source: "primary" | "clue"; relevance: number }>();
    const addIndustry = (input: { code?: string | null; name?: string | null; hot?: boolean; source: "primary" | "clue"; relevance?: number }) => {
      const name = input.name?.trim();
      if (!name) return;
      const codeValue = input.code?.trim() || `name:${name}`;
      const current = industryMap.get(codeValue);
      const candidate = { code: codeValue, name, hot: Boolean(input.hot), source: input.source, relevance: input.relevance ?? 100 };
      if (!current || Number(candidate.hot) > Number(current.hot) || candidate.relevance > current.relevance) industryMap.set(codeValue, candidate);
    };
    for (const occurrence of values) {
      const snapshot = record(occurrence.item.snapshot);
      const industry = record(snapshot.industry);
      const primaryName = string(industry.name);
      addIndustry({ name: primaryName, hot: occurrence.item.isHotIndustry, source: "primary" });
      const events = Array.isArray(snapshot.events) ? snapshot.events.map(record) : [];
      for (const event of events) {
        const id = string(event.id);
        if (!id) continue;
        for (const link of source.clueIndustriesById?.get(id) ?? []) addIndustry({ code: link.code, name: link.name, source: "clue", relevance: link.relevance });
      }
    }
    for (const date of tradeDates) addIndustry({ name: quoteMaps.get(date)?.get(code)?.industryName, source: "primary" });
    const latestOccurrence = values.at(-1)!;
    const latestSnapshot = record(latestOccurrence.item.snapshot);
    const latestQuote = [...tradeDates].reverse().map((date) => quoteMaps.get(date)?.get(code)).find(Boolean);
    const name = string(latestSnapshot.name) ?? latestQuote?.name ?? code;
    const upDays = priceHistory.filter((point) => (point.pctChange ?? 0) > 0).length;
    const downDays = priceHistory.filter((point) => (point.pctChange ?? 0) < 0).length;
    const flatDays = priceHistory.filter((point) => point.pctChange === 0).length;
    return {
      code,
      name,
      focusDates,
      consecutiveDays: boundedConsecutiveDays,
      firstFocusDate,
      lastFocusDate,
      sessionsSinceFocus: Math.max(0, tradeDates.length - 1 - lastFocusIndex),
      isHotIndustry: values.some((value) => value.item.isHotIndustry),
      industries: [...industryMap.values()].sort((left, right) => Number(right.hot) - Number(left.hot) || Number(right.source === "primary") - Number(left.source === "primary") || right.relevance - left.relevance || left.name.localeCompare(right.name, "zh-Hans-CN")).slice(0, 6).map(({ relevance: _relevance, ...industry }) => industry),
      dailyChanges,
      priceHistory,
      entryPrice,
      latestPrice,
      windowPctChange,
      upDays,
      downDays,
      flatDays,
      trend: analyzeTrend(priceHistory, windowPctChange),
      leadership: leadershipOf(code),
    };
  }).sort((left, right) => Number(right.leadership.isLeader) - Number(left.leadership.isLeader) || Number(right.isHotIndustry) - Number(left.isHotIndustry) || (right.windowPctChange ?? -Infinity) - (left.windowPctChange ?? -Infinity) || right.focusDates.length - left.focusDates.length || left.code.localeCompare(right.code));
  const priced = items.filter((item) => item.windowPctChange !== null);
  const up = priced.filter((item) => item.windowPctChange! > 0).length;
  const down = priced.filter((item) => item.windowPctChange! < 0).length;
  const flat = priced.length - up - down;
  const hotIndustry = items.filter((item) => item.isHotIndustry).length;
  const leaders = items.filter((item) => item.leadership.isLeader).length;
  const quoteTimes = tradeDates.flatMap((date) => (source.quotesByDate.get(date) ?? []).map((quote) => quote.quoteAt)).filter(Boolean).sort();
  return {
    window: {
      start: tradeDates[0] ?? null,
      end: tradeDates.at(-1) ?? null,
      tradeDates,
      sessions: windowSessions,
      maxSessions: 5,
      latestTradeDate,
      availableTradeDates: source.availableTradeDates?.length ? [...source.availableTradeDates] : [...allTradeDates].reverse(),
      isLatest: Boolean(tradeDates.length) && tradeDates.at(-1) === latestTradeDate,
      listDates: [...new Set(source.lists.filter((list) => dateIndex.has(list.tradeDate)).map((list) => list.tradeDate))].sort(),
      livePreviewDate: source.livePreviewDate && dateIndex.has(source.livePreviewDate) ? source.livePreviewDate : null,
    },
    asOf: quoteTimes.at(-1) ?? null,
    items,
    stats: {
      total: items.length,
      priced: priced.length,
      up,
      down,
      flat,
      upRatio: priced.length ? round(up / priced.length) : null,
      downRatio: priced.length ? round(down / priced.length) : null,
      hotIndustry,
      hotIndustryRatio: items.length ? round(hotIndustry / items.length) : null,
      leaders,
      leaderRatio: items.length ? round(leaders / items.length) : null,
    },
  };
}
