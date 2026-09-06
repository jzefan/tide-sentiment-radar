import type { SentimentEvent, StockSnapshot } from "../src/domain/types.ts";
import type { MarketQuote } from "./marketSync.ts";
import type { DiscussionSourceState } from "./userPosts.ts";
import {
  getDailyCandidateList,
  getDailyCandidateOutcomes,
  getMarketQuotesByTradeDate,
  getRecentAmounts,
  getRecentPctChanges,
  getTradeDatesAfter,
  listDailyCandidateLists,
  saveDailyCandidateList,
  saveDailyCandidateOutcomes,
  type DailyCandidateEntry,
  type DailyCandidateList,
  type DailyCandidateOutcome,
} from "./database.ts";
import { buildIndustryAnalytics, classifyStockIndustry } from "./industryAnalytics.ts";
import { DAILY_FOCUS_VERSION, selectDailyCandidates, type DailyCandidateInput, type DailyCandidateScored, type DiscussionWindow } from "./dailyCandidateStrategy.ts";
import { isTradingDate, verifiedTradingDaysSinceListing } from "../src/domain/marketCalendar.ts";

export interface DailyCandidateDiscussionSource extends DiscussionSourceState {
  /** Explicit source watermark retained for evidence-quality audit and scoring. */
  coveredThrough?: string | null;
}

export interface DailyCandidateSourceState {
  id: string;
  role: "discussion" | "authority";
  state: "connected" | "degraded" | "disabled";
  /** Source-provided content watermark, never a bundle-level fetch timestamp proxy. */
  coveredThrough: string | null;
  observedAt: string | null;
  queryFrom: string | null;
  queryTo: string | null;
  /** Exact stock coverage proved by a discussion adapter; authority feeds may leave this empty. */
  coveredCodes: string[];
  /** Exact event ids returned by this verified adapter window. */
  eventIds?: string[];
}

/** Historical discussion aggregates are admissible only with their own range proof. */
export interface DailyCandidateDiscussionWindow extends DiscussionWindow {
  code: string;
  verified: true;
  sourceId: string;
  adapterId: string;
  state: "connected";
  tradeDate: string;
  featureStart: string;
  featureCutoff: string;
  queryFrom: string;
  queryTo: string;
  coveredThrough: string;
  /** Server-echoed per-code coverage retained with the historical aggregate. */
  coveredCodes: string[];
  cursorExhausted: true;
}

/**
 * The orchestration boundary deliberately accepts every volatile input.  It neither fetches data
 * nor reads the clock, so preview/freeze decisions remain reproducible from a captured snapshot.
 */
export interface DailyCandidateSource {
  quotes: MarketQuote[];
  stocks: StockSnapshot[];
  events: SentimentEvent[];
  tradeDate: string;
  marketAsOf: string;
  clueAsOf: string;
  marketStale: boolean;
  discussionSources: DailyCandidateDiscussionSource[];
  clueFailures: string[];
  sourceStates: DailyCandidateSourceState[];
  /** Five prior complete windows captured with adapter-specific server range proofs. */
  discussionWindowsByCode?: Record<string, DailyCandidateDiscussionWindow[]>;
  /** Real exchange trading dates ending on tradeDate, supplied by the adapter. */
  recentTradeDates: string[];
  previousTradeDate: string;
  /** Result of the existing full-market batch validator, supplied by the caller. */
  marketComplete: boolean;
  /** Trading-calendar decision supplied by caller (prevents using local current date). */
  isTradingDay: boolean;
  /** Defaults to 15:30 Asia/Shanghai; persisted with methodology metadata. */
  freezeDeadlineMinutes?: number;
}

export interface DailyCandidateListResponse {
  tradeDate: string;
  methodologyVersion: string;
  status: "preview" | "frozen" | "unavailable" | "reconstructed";
  origin: "prospective" | "reconstructed";
  featureCutoff: string;
  marketAsOf: string | null;
  clueAsOf: string | null;
  frozenAt: string | null;
  items: DailyCandidateEntryResponse[];
  dataQuality: Record<string, unknown>;
  exclusionCounts: Record<string, number>;
  reason: string | null;
}

export interface DailyCandidateNextDayTrend {
  direction: "up";
  label: "强看涨" | "偏多";
  /** 冻结时的综合信号分，用于表达强弱，不是上涨概率。 */
  signalScore: number;
  targetTradeDate: string | null;
  actual: null | {
    tradeDate: string;
    pctChange: number;
    status: "matched" | "missed" | "flat";
    phase: "intraday" | "closed";
    observedAt: string;
  };
}

export interface DailyCandidateEntryResponse extends DailyCandidateEntry {
  nextDayTrend: DailyCandidateNextDayTrend;
}

const DAY_MS = 86_400_000;
const cutoffFor = (tradeDate: string) => `${tradeDate}T07:00:00.000Z`; // 15:00 Asia/Shanghai
const deadlineFor = (tradeDate: string, minutes: number) => new Date(`${tradeDate}T07:00:00.000Z`).valueOf() + minutes * 60_000;
const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const beforeOrAt = (value: string | null | undefined, cutoff: string) => Boolean(value && value <= cutoff);
const atOrAfter = (value: string | null | undefined, cutoff: string) => Boolean(value && value >= cutoff);
const eventFor = (events: SentimentEvent[], code: string) => events.filter((event) => event.relatedStocks.some((stock) => stock.code === code));
const isRiskName = (name: string) => /(?:^|\s)\*?ST(?=\s|[^A-Za-z0-9]|$)|退市/i.test(name);
const sourceQuality = (sourceKind: SentimentEvent["sourceKind"]) => sourceKind === "announcement" ? 95 : sourceKind === "news" ? 82 : 55;
const toneScore = (tone: SentimentEvent["tone"]) => tone === "positive" ? 72 : tone === "negative" ? -72 : 0;
const eventFingerprint = (event: SentimentEvent) => {
  const stableId = event.id.trim();
  if (stableId) return `id:${stableId}`;
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  const timestamp = Date.parse(event.publishedAt);
  const timeBucket = Number.isFinite(timestamp) ? Math.floor(timestamp / (5 * 60_000)) : normalize(event.publishedAt);
  const stocks = [...event.relatedStocks].map((stock) => stock.code).sort().join(",");
  return `fallback:${normalize(event.title)}|${normalize(event.source)}|${stocks}|${timeBucket}`;
};
/** A single syndicated evidence item cannot inflate event or source independence. */
function dedupeCandidateEvents(events: SentimentEvent[]): SentimentEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = eventFingerprint(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const tradingDaysSince = (listingDate: string | null, tradeDate: string) => verifiedTradingDaysSinceListing(listingDate, tradeDate);

/** The price benchmark and market-excess reference use the same auditable SH/SZ universe. */
function cleanMarketQuote(quote: MarketQuote, source: DailyCandidateSource): boolean {
  return (quote.exchange === "SH" || quote.exchange === "SZ")
    && quote.tradeDate === source.tradeDate
    && Number.isFinite(quote.pctChange)
    && tradingDaysSince(quote.listingDate, source.tradeDate) >= 30
    && !isRiskName(quote.name)
    && quote.amount > 0
    && quote.price !== null && quote.price > 0
    && quote.open !== null && quote.open > 0
    && quote.high !== null && quote.high > 0
    && quote.low !== null && quote.low > 0
    && quote.previousClose !== null && quote.previousClose > 0;
}

/** Board-aware limit state derived from immutable close-session OHLC metadata. */
export function calculateBoardLimitState(quote: Pick<MarketQuote, "code" | "name" | "previousClose" | "open" | "high" | "low" | "price" | "limitPercent">): { limitPercent: 5 | 10 | 20 | null; reachedLimit: boolean; onePriceLimit: boolean; reopenedLimit: boolean } {
  const configured = quote.limitPercent === 5 || quote.limitPercent === 10 || quote.limitPercent === 20 ? quote.limitPercent : null;
  // Regulatory board rules change. Without source/version/effective-date metadata
  // this classifier must not infer a limit from a code prefix or name.
  const limitPercent = configured;
  const { previousClose, open, high, low, price } = quote;
  if (limitPercent === null || previousClose === null || open === null || high === null || low === null || price === null || previousClose <= 0) return { limitPercent, reachedLimit: false, onePriceLimit: false, reopenedLimit: false };
  const limitPrice = Math.round(previousClose * (1 + limitPercent / 100) * 100) / 100;
  const reachedLimit = high >= limitPrice - .005;
  const onePriceLimit = reachedLimit && Math.abs(high - low) < .005;
  // A gap/open tells us nothing about an intraday limit break. The recorded low
  // is the immutable OHLC evidence that the board actually reopened.
  const reopenedLimit = reachedLimit && low < limitPrice - .005 && price >= limitPrice * .99;
  return { limitPercent, reachedLimit, onePriceLimit, reopenedLimit };
}

/**
 * Cutoff-reproducible text signal. Every event's contribution decays by half
 * every 12 hours, after weighting by source quality and model confidence.
 */
export function calculateCutoffTextSignals(events: Array<Pick<SentimentEvent, "sourceKind" | "tone" | "confidence" | "publishedAt">>, cutoff: string): { sentiment: number; textDirection: number; directionConsensus: number; sourceQuality: number; textConfidence: number; freshness: number } {
  const cutoffAt = Date.parse(cutoff);
  const weighted = events.flatMap((event) => {
    const publishedAt = Date.parse(event.publishedAt);
    if (!Number.isFinite(cutoffAt) || !Number.isFinite(publishedAt)) return [];
    const ageHours = Math.max(0, (cutoffAt - publishedAt) / 3_600_000);
    const confidence = Math.max(0, Math.min(100, event.confidence)) / 100;
    const weight = sourceQuality(event.sourceKind) * confidence * 2 ** (-ageHours / 12);
    return weight > 0 ? [{ event, ageHours, weight, score: toneScore(event.tone) }] : [];
  });
  if (!weighted.length) return { sentiment: 0, textDirection: 50, directionConsensus: 50, sourceQuality: 0, textConfidence: 0, freshness: 0 };
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  const sentiment = weighted.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight;
  const positive = weighted.filter((item) => item.score > 0).reduce((sum, item) => sum + item.weight, 0);
  const negative = weighted.filter((item) => item.score < 0).reduce((sum, item) => sum + item.weight, 0);
  const directional = positive + negative;
  const latestAge = Math.min(...weighted.map((item) => item.ageHours));
  return {
    sentiment,
    textDirection: Math.max(0, Math.min(100, Math.round(50 + sentiment / 2))),
    directionConsensus: directional ? Math.round(100 - (Math.min(positive, negative) / directional) * 100) : 50,
    sourceQuality: Math.round(weighted.reduce((sum, item) => sum + sourceQuality(item.event.sourceKind) * item.weight, 0) / totalWeight),
    textConfidence: Math.round(weighted.reduce((sum, item) => sum + item.event.confidence * item.weight, 0) / totalWeight),
    freshness: Math.max(0, Math.round(100 - latestAge * 3)),
  };
}

function featureCutoffForElapsed(tradeDate: string, elapsedMinutes: number): string {
  const elapsed = Math.max(1, Math.min(240, Math.round(elapsedMinutes)));
  const sessionMinute = elapsed <= 120 ? 9 * 60 + 30 + elapsed : 13 * 60 + (elapsed - 120);
  const hour = String(Math.floor(sessionMinute / 60)).padStart(2, "0"); const minute = String(sessionMinute % 60).padStart(2, "0");
  return new Date(`${tradeDate}T${hour}:${minute}:00.000+08:00`).toISOString();
}

function previewWindow(source: DailyCandidateSource, now: Date): { featureCutoff: string; elapsedMinutes: number } {
  const officialCutoff = cutoffFor(source.tradeDate); const current = now.toISOString();
  if (current >= officialCutoff) return { featureCutoff: officialCutoff, elapsedMinutes: 240 };
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const minutes = read("hour") * 60 + read("minute");
  const elapsedMinutes = minutes < 9 * 60 + 30 ? 1 : minutes < 11 * 60 + 30 ? minutes - (9 * 60 + 30) : minutes < 13 * 60 ? 120 : Math.min(240, 120 + minutes - 13 * 60);
  return { featureCutoff: current, elapsedMinutes: Math.max(1, elapsedMinutes) };
}

function discussionHistory(codes: string[], source: DailyCandidateSource, elapsedMinutes: number): Map<string, DailyCandidateDiscussionWindow[]> {
  const result = new Map<string, DailyCandidateDiscussionWindow[]>(codes.map((code) => [code, []]));
  const priorSessions = source.recentTradeDates.filter((date) => date < source.tradeDate).slice(-5);
  const priorByDate = new Map(source.recentTradeDates.map((date, index) => [date, source.recentTradeDates[index - 1] ?? null]));
  const deriveFromRangeProof = (code: string): DailyCandidateDiscussionWindow[] => {
    if (priorSessions.length !== 5) return [];
    const eligibleStates = source.sourceStates
      .filter((state) => state.role === "discussion" && state.state === "connected" && state.queryFrom !== null && state.queryTo !== null && state.coveredThrough !== null && state.coveredCodes.includes(code))
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const state of eligibleStates) {
      const eventIds = new Set(state.eventIds ?? []);
      const windows = priorSessions.flatMap((tradeDate): DailyCandidateDiscussionWindow[] => {
        const previous = priorByDate.get(tradeDate);
        if (!previous) return [];
        const featureStart = cutoffFor(previous);
        const featureCutoff = featureCutoffForElapsed(tradeDate, elapsedMinutes);
        if (state.queryFrom! > featureStart || state.queryTo! < featureCutoff || state.coveredThrough! < featureCutoff) return [];
        const related = dedupeCandidateEvents(source.events.filter((event) => event.sourceKind === "forum"
          && event.adapterId === state.id
          && eventIds.has(event.id)
          && event.publishedAt > featureStart
          && event.publishedAt <= featureCutoff
          && event.relatedStocks.some((stock) => stock.code === code)));
        return [{
          code,
          count: related.length,
          interactions: related.reduce((sum, event) => sum + Math.max(0, event.heat), 0),
          elapsedMinutes,
          verified: true,
          sourceId: state.id,
          adapterId: state.id,
          state: "connected",
          tradeDate,
          featureStart,
          featureCutoff,
          queryFrom: state.queryFrom!,
          queryTo: state.queryTo!,
          coveredThrough: state.coveredThrough!,
          coveredCodes: [...state.coveredCodes],
          cursorExhausted: true,
        }];
      });
      if (windows.length === 5) return windows;
    }
    return [];
  };
  for (const code of codes) {
    const windows = source.discussionWindowsByCode?.[code] ?? [];
    const auditable = windows.length === 5 && windows.every((window, index) => {
      const tradeDate = priorSessions[index];
      const previous = tradeDate ? priorByDate.get(tradeDate) : null;
      return Boolean(tradeDate && previous
        && window.verified === true
        && window.state === "connected"
        && window.adapterId === window.sourceId
        && window.cursorExhausted === true
        && window.coveredCodes.includes(code)
        && window.tradeDate === tradeDate
        && window.featureStart === cutoffFor(previous)
        && window.featureCutoff === featureCutoffForElapsed(tradeDate, elapsedMinutes)
        && window.queryFrom <= window.featureStart
        && window.queryTo >= window.featureCutoff
        && window.coveredThrough >= window.featureCutoff
        && window.elapsedMinutes === elapsedMinutes);
    });
    result.set(code, auditable ? windows.map((window) => ({ ...window })) : deriveFromRangeProof(code));
  }
  return result;
}

function derivedStock(quote: MarketQuote, events: SentimentEvent[], asOf: string, featureCutoff: string): StockSnapshot {
  const text = calculateCutoffTextSignals(events, featureCutoff);
  const ageMinutes = events.length ? Math.max(0, (Date.parse(featureCutoff) - Math.max(...events.map((event) => Date.parse(event.publishedAt)))) / 60_000) : Infinity;
  const factors = { sentiment: Math.round(text.sentiment), attention: Math.min(100, 24 + events.length * 12), velocity: Math.max(0, Math.round(95 - ageMinutes / 30)), consensus: text.directionConsensus, sourceQuality: text.sourceQuality, priceConfirm: 80, freshness: text.freshness };
  const industryProfile = classifyStockIndustry({
    code: quote.code,
    name: quote.name,
    industry: quote.industryName ? {
      code: "",
      name: quote.industryName,
      parent: quote.industryName,
      level: "行业",
      taxonomy: "东方财富行业",
      asOf,
    } : undefined,
  });
  return {
    code: quote.code, name: quote.name, market: quote.market, price: quote.price ?? 0, pctChange: quote.pctChange ?? 0, amount: quote.amount ?? 0,
    radarScore: null, textDirectionScore: events.length ? text.textDirection : null, alertScore: null,
    signal: "证据不足", analysisStatus: events.length ? "scored" : "no_clues", factors, mentionCount: events.length,
    mentionDelta: 0, topics: [...new Set(events.flatMap((event) => event.topics))], summary: "", sparkline: [], sentimentTrend: [], priceHistory: [], sourceMix: {}, asOf,
    ...(industryProfile ? { industry: { ...industryProfile, asOf } } : {}),
  };
}

/** Preserve source industries even when no text event exists for that industry. */
function buildMarketIndustrySignals(quotes: MarketQuote[], marketReturn: number, asOf: string): Map<string, NonNullable<DailyCandidateInput["industry"]>> {
  const groups = new Map<string, { name: string; quotes: MarketQuote[] }>();
  for (const quote of quotes) {
    const profile = classifyStockIndustry({
      code: quote.code,
      name: quote.name,
      industry: quote.industryName ? { code: "", name: quote.industryName, parent: quote.industryName, level: "行业", taxonomy: "东方财富行业", asOf } : undefined,
    });
    if (!profile) continue;
    const group = groups.get(profile.code) ?? { name: profile.name, quotes: [] };
    group.quotes.push(quote);
    groups.set(profile.code, group);
  }
  const totalAmount = quotes.reduce((sum, quote) => sum + Math.max(0, quote.amount), 0);
  const result = new Map<string, NonNullable<DailyCandidateInput["industry"]>>();
  for (const group of groups.values()) {
    const industryReturn = group.quotes.reduce((sum, quote) => sum + quote.pctChange, 0) / group.quotes.length;
    const breadth = group.quotes.filter((quote) => quote.pctChange > 0).length / group.quotes.length;
    const amountShare = totalAmount ? group.quotes.reduce((sum, quote) => sum + Math.max(0, quote.amount), 0) / totalAmount : 0;
    const marketStrength = Math.min(100, Math.max(0, Math.round(50 + (industryReturn - marketReturn) * 9 + (breadth - .5) * 45 + Math.min(8, amountShare * .2))));
    const relation = group.quotes.length >= 3 && marketStrength >= 65 ? "交易驱动" as const : "常态行业" as const;
    const signal = { name: group.name, textHeat: 0, textDirection: 50, marketStrength, breadth: Math.round(breadth * 100), relation };
    for (const quote of group.quotes) result.set(quote.code, signal);
  }
  return result;
}

function buildInputs(source: DailyCandidateSource, cutoff = cutoffFor(source.tradeDate), elapsedMinutes = 240): { inputs: DailyCandidateInput[]; evidence: Map<string, SentimentEvent[]>; benchmark: Array<{ code: string; industryCode: string | null; industryName: string | null }>; verifiedDiscussionCodes: number } {
  const featureStart = cutoffFor(source.previousTradeDate);
  const verifiedStates = new Map(source.sourceStates
    .filter((state) => state.state === "connected" && state.queryFrom !== null && state.queryTo !== null)
    .map((state) => [state.id, { ...state, eventIds: new Set(state.eventIds ?? []), coveredCodes: new Set(state.coveredCodes ?? []) }]));
  const authorizedEvents = source.events.flatMap((event): SentimentEvent[] => {
    if (!(event.publishedAt > featureStart && beforeOrAt(event.publishedAt, cutoff)) || !event.adapterId) return [];
    const state = verifiedStates.get(event.adapterId); if (!state?.eventIds.has(event.id)) return [];
    if (state.role !== "discussion") return [event];
    const relatedStocks = event.relatedStocks.filter((stock) => state.coveredCodes.has(stock.code));
    return relatedStocks.length ? [{ ...event, relatedStocks }] : [];
  });
  const events = dedupeCandidateEvents(authorizedEvents);
  const codes = [...new Set(source.quotes.map((quote) => quote.code))];
  const amounts = getRecentAmounts(codes, 5, source.tradeDate);
  const returns = getRecentPctChanges(codes, 3, source.tradeDate);
  const histories = discussionHistory(codes, source, elapsedMinutes);
  const verifiedDiscussionCodes = [...histories.values()].filter((history) => history.length === 5 && history.every((window) => window.verified === true)).length;
  const derivedStocks = source.quotes.map((quote) => derivedStock(quote, eventFor(events, quote.code), source.marketAsOf, cutoff));
  const stockByCode = new Map(derivedStocks.map((stock) => [stock.code, stock]));
  const analytics = buildIndustryAnalytics({ stocks: derivedStocks, events, asOf: source.marketAsOf, clueAsOf: source.clueAsOf, tradeDate: source.tradeDate });
  const industryByCode = new Map(analytics.stocks.map((stock) => [stock.code, stock]));
  const cleanMarket = source.quotes.filter((quote) => cleanMarketQuote(quote, source));
  const marketPct = cleanMarket.length ? cleanMarket.reduce((sum, quote) => sum + quote.pctChange, 0) / cleanMarket.length : 0;
  const marketIndustryByCode = buildMarketIndustrySignals(cleanMarket, marketPct, source.marketAsOf);
  const evidence = new Map<string, SentimentEvent[]>();
  const inputs = source.quotes.flatMap((quote): DailyCandidateInput[] => {
    const stock = stockByCode.get(quote.code);
    const { open, high, low, previousClose, price } = quote;
    if (!stock || !open || !high || !low || !previousClose || !price || open <= 0 || high <= 0 || low <= 0 || previousClose <= 0) return [];
    const relevant = eventFor(events, quote.code);
    const relevantBeforeDedupe = eventFor(authorizedEvents, quote.code);
    const textSignal = calculateCutoffTextSignals(relevant, cutoff);
    const limitState = calculateBoardLimitState(quote);
    // The market list endpoint does not expose a trustworthy per-security limit
    // percentage. A positive one-price board is still observable directly from
    // immutable OHLC/pct-change fields and remains excluded without guessing the
    // exact board rule.
    const observableOnePriceLimit = limitState.limitPercent === null
      && Math.abs(high - low) < .005
      && quote.pctChange >= 4.8;
    evidence.set(quote.code, relevant);
    // `events` already passed the audited (previous close, current close] cutoff;
    // do not silently shrink discussion to a same-day intraday sub-window.
    const forum = relevant.filter((event) => event.sourceKind === "forum");
    const industryContribution = industryByCode.get(quote.code);
    const pulse = industryContribution ? analytics.items.find((item) => item.profile.code === industryContribution.industry.code) : undefined;
    const sourceCount = new Set(relevant.map((event) => event.source)).size;
    return [{
      code: quote.code, name: quote.name, exchange: quote.exchange, listingTradingDays: tradingDaysSince(quote.listingDate, source.tradeDate), tradeDate: source.tradeDate,
      open, high, low, close: price, previousClose, pctChange: quote.pctChange, amount: quote.amount,
      amountHistory: (amounts.get(quote.code) ?? []).map((item) => item.amount), marketExcess: quote.pctChange - marketPct,
      analysisStatus: stock.analysisStatus === "scored" ? "scored" : stock.analysisStatus === "stale" ? "failed" : "unscored",
      textDirection: stock.textDirectionScore ?? 0, directionConsensus: stock.factors.consensus, textConfidence: textSignal.textConfidence, freshness: stock.factors.freshness,
      discussionCount: forum.length, userDiscussionCount: forum.length, discussionInteractions: forum.reduce((sum, event) => sum + event.heat, 0), discussionElapsedMinutes: elapsedMinutes,
      discussionHistory: histories.get(quote.code), independentEvents: relevant.length, sourceCount,
      duplicateRatio: relevantBeforeDedupe.length ? (relevantBeforeDedupe.length - relevant.length) / relevantBeforeDedupe.length : 0,
      hasNonForumCorroboration: relevant.some((event) => event.sourceKind === "news" || event.sourceKind === "announcement"),
      industry: pulse ? { name: pulse.profile.name, textHeat: pulse.textHeat, textDirection: pulse.textDirection, marketStrength: pulse.marketStrength, breadth: pulse.breadth, relation: pulse.relation } : marketIndustryByCode.get(quote.code) ?? null,
      isSuspended: quote.amount <= 0, onePriceLimit: limitState.onePriceLimit || observableOnePriceLimit, reopenedLimit: limitState.reopenedLimit,
      threeDayReturn: (returns.get(quote.code) ?? []).reduce((sum, item) => sum + item.pctChange, 0),
    }];
  });
  const benchmark = cleanMarket.map((quote) => {
    const industry = classifyStockIndustry({ code: quote.code, name: quote.name, industry: quote.industryName ? { code: "", name: quote.industryName, parent: quote.industryName, level: "行业", taxonomy: "东方财富行业", asOf: source.marketAsOf } : undefined });
    return { code: quote.code, industryCode: industry?.code ?? null, industryName: industry?.name ?? null };
  });
  return { inputs, evidence, benchmark, verifiedDiscussionCodes };
}

function quality(source: DailyCandidateSource, cutoff: string): { ready: boolean; reason: string | null; detail: Record<string, unknown> } {
  if (!source.marketComplete) return { ready: false, reason: "当日沪深完整行情未就绪", detail: { market: "incomplete" } };
  // A batch fetched after 15:00 is the immutable close input. Its wall-clock
  // cache age must not invalidate it later in the evening, and an illiquid
  // stock's own last-trade timestamp need not equal the batch close timestamp.
  if (!atOrAfter(source.marketAsOf, cutoff) || source.quotes.some((quote) => quote.tradeDate !== source.tradeDate)) {
    return { ready: false, reason: "行情数据未覆盖收盘", detail: { market: "before-close" } };
  }
  const cleanQuotes = source.quotes.filter((quote) => cleanMarketQuote(quote, source));
  const limitMetadataCovered = cleanQuotes.filter((quote) => quote.limitPercent === 5 || quote.limitPercent === 10 || quote.limitPercent === 20).length;
  const stateReady = (role: DailyCandidateSourceState["role"]) => source.sourceStates.some((state) => state.role === role && state.state === "connected" && atOrAfter(state.coveredThrough, cutoff) && state.queryFrom !== null && state.queryTo !== null && state.queryFrom <= cutoffFor(source.previousTradeDate) && state.queryTo >= cutoff);
  const discussionReady = stateReady("discussion");
  const authorityReady = stateReady("authority");
  return {
    ready: true,
    reason: null,
    detail: {
      market: source.marketStale ? "close-complete-stored" : "complete",
      marketRows: source.quotes.length,
      discussion: discussionReady ? "covered" : "degraded",
      authority: authorityReady ? "available" : "degraded",
      boardLimitMetadata: limitMetadataCovered === cleanQuotes.length ? "complete" : limitMetadataCovered ? "partial" : "unavailable",
      boardLimitCovered: limitMetadataCovered,
      boardLimitUniverse: cleanQuotes.length,
      clueFailures: source.clueFailures,
      sourceStates: source.sourceStates,
    },
  };
}

function entry(item: DailyCandidateScored, evidence: SentimentEvent[]): DailyCandidateEntry {
  return {
    code: item.code, rank: 0, grade: item.grade!, isHotIndustry: item.isHotIndustry, baseScore: item.baseScore, overheatPenalty: item.overheatPenalty, finalScore: item.finalScore,
    scores: item.scores,
    snapshot: { ...item.inputAudit, industry: item.industry, discussionGrowth: item.discussionGrowth, events: evidence.map((event) => ({ id: event.id, title: event.title, source: event.source, sourceKind: event.sourceKind, tone: event.tone, confidence: event.confidence, heat: event.heat, publishedAt: event.publishedAt, ...(event.url ? { url: event.url } : {}) })) },
    reasons: [
      "成交额趋势确认",
      "当日上涨且跑赢市场",
      evidence.length ? "文本或讨论提供加分" : "文本与讨论缺失，按市场信号入选",
      item.industry ? `行业：${item.industry.name}` : "行业数据缺失",
    ],
  };
}

function nextVerifiedTradingDate(tradeDate: string): string | null {
  const start = new Date(`${tradeDate}T00:00:00.000Z`);
  if (!Number.isFinite(start.valueOf())) return null;
  for (let offset = 1; offset <= 14; offset += 1) {
    const candidate = new Date(start.valueOf() + offset * DAY_MS).toISOString().slice(0, 10);
    if (isTradingDate(candidate)) return candidate;
  }
  return null;
}

/**
 * Adds a forward-looking T+1 direction signal derived only from the frozen entry,
 * then joins the next session's quote when it becomes available. The signal score
 * is the existing research score and must never be presented as a probability.
 */
export function withNextTradingDayTrends(tradeDate: string, items: DailyCandidateEntry[]): DailyCandidateEntryResponse[] {
  const targetTradeDate = nextVerifiedTradingDate(tradeDate);
  const nextQuotes = targetTradeDate ? getMarketQuotesByTradeDate(targetTradeDate) : [];
  const quoteByCode = new Map(nextQuotes.map((quote) => [quote.code, quote]));
  return items.map((item) => {
    const quote = quoteByCode.get(item.code);
    const actualPctChange = typeof quote?.pctChange === "number" && Number.isFinite(quote.pctChange) ? quote.pctChange : null;
    const actual = targetTradeDate && quote && actualPctChange !== null
      ? {
          tradeDate: targetTradeDate,
          pctChange: actualPctChange,
          status: actualPctChange > 0 ? "matched" as const : actualPctChange < 0 ? "missed" as const : "flat" as const,
          phase: quote.quoteAt >= cutoffFor(targetTradeDate) ? "closed" as const : "intraday" as const,
          observedAt: quote.quoteAt,
        }
      : null;
    return {
      ...item,
      nextDayTrend: {
        direction: "up",
        label: item.grade === "A" ? "强看涨" : "偏多",
        signalScore: item.finalScore,
        targetTradeDate,
        actual,
      },
    };
  });
}

/** Backfill only the industry label from the list's own immutable benchmark. */
export function withFrozenBenchmarkIndustryLabels(list: DailyCandidateList): DailyCandidateEntry[] {
  const benchmarkIndustry = new Map(list.benchmarkMembers.flatMap((member) => member.industryName ? [[member.code, member.industryName] as const] : []));
  return list.items.map((item) => {
    const snapshot = item.snapshot && typeof item.snapshot === "object" && !Array.isArray(item.snapshot) ? item.snapshot as Record<string, unknown> : {};
    const industry = snapshot.industry && typeof snapshot.industry === "object" && !Array.isArray(snapshot.industry) ? snapshot.industry as Record<string, unknown> : {};
    if (typeof industry.name === "string" && industry.name.trim()) return item;
    const name = benchmarkIndustry.get(item.code);
    return name ? { ...item, snapshot: { ...snapshot, industry: { name, relation: "关系未留存", source: "frozen-benchmark" } } } : item;
  });
}

function response(list: DailyCandidateList): DailyCandidateListResponse {
  const items = withFrozenBenchmarkIndustryLabels(list);
  return { tradeDate: list.tradeDate, methodologyVersion: list.methodologyVersion, status: list.status === "reconstructed" ? "reconstructed" : list.status === "frozen" ? "frozen" : "unavailable", origin: list.origin, featureCutoff: list.featureCutoff, marketAsOf: list.marketAsOf, clueAsOf: list.clueAsOf, frozenAt: list.frozenAt, items: withNextTradingDayTrends(list.tradeDate, items), dataQuality: list.dataQuality as Record<string, unknown>, exclusionCounts: list.exclusionCounts as Record<string, number>, reason: list.reason };
}

function previewFromInputs(source: DailyCandidateSource, now: Date, assembled: ReturnType<typeof buildInputs>, cutoff = cutoffFor(source.tradeDate)): DailyCandidateListResponse {
  const result = selectDailyCandidates(assembled.inputs);
  const items = withNextTradingDayTrends(source.tradeDate, result.items.map((item, index) => ({ ...entry(item, assembled.evidence.get(item.code) ?? []), rank: index + 1 })));
  return {
    tradeDate: source.tradeDate, methodologyVersion: DAILY_FOCUS_VERSION, status: "preview", origin: "prospective", featureCutoff: cutoff, marketAsOf: source.marketAsOf, clueAsOf: source.clueAsOf,
    frozenAt: null, items, dataQuality: { previewAt: now.toISOString(), ...quality(source, cutoffFor(source.tradeDate)).detail, discussionBaseline: assembled.verifiedDiscussionCodes > 0 ? "verified" : "unavailable", verifiedDiscussionCandidates: assembled.verifiedDiscussionCodes, clueFailures: source.clueFailures, referenceAudit: result.referenceAudit, selectionDiagnostics: result.selectionDiagnostics }, exclusionCounts: result.exclusionCounts,
    reason: result.status === "available" ? null : "没有标的通过当日筛选门槛",
  };
}

export function buildDailyCandidatePreview(source: DailyCandidateSource, now: Date): DailyCandidateListResponse {
  const window = previewWindow(source, now);
  return previewFromInputs(source, now, buildInputs(source, window.featureCutoff, window.elapsedMinutes), window.featureCutoff);
}

export function maybeFreezeDailyCandidates(source: DailyCandidateSource, now: Date): DailyCandidateListResponse | null {
  if (!source.isTradingDay) return null;
  const existing = getDailyCandidateList(source.tradeDate);
  const recoverableUnavailable = existing?.status === "unavailable"
    && existing.origin === "prospective"
    && existing.items.length === 0;
  if (existing && !recoverableUnavailable) return response(existing);
  const cutoff = cutoffFor(source.tradeDate);
  if (now.valueOf() < Date.parse(cutoff)) return null;
  const deadlineMinutes = source.freezeDeadlineMinutes ?? 30;
  const readiness = quality(source, cutoff);
  const afterDeadline = now.valueOf() >= deadlineFor(source.tradeDate, deadlineMinutes);
  if (!readiness.ready && !afterDeadline) return existing ? response(existing) : null;
  if (!readiness.ready) {
    if (existing) return response(existing);
    return response(saveDailyCandidateList({
      tradeDate: source.tradeDate, methodologyVersion: DAILY_FOCUS_VERSION, status: "unavailable", origin: "prospective", featureCutoff: cutoff,
      marketAsOf: source.marketAsOf, clueAsOf: source.clueAsOf, frozenAt: now.toISOString(), universeCount: source.quotes.length, eligibleCount: 0, selectedCount: 0,
      methodology: { version: DAILY_FOCUS_VERSION, deadlineMinutes }, dataQuality: readiness.detail, exclusionCounts: {}, reason: readiness.reason, benchmarkMembers: [], items: [],
    }));
  }
  const assembled = buildInputs(source, cutoff, 240);
  const preview = previewFromInputs(source, now, assembled, cutoff);
  if (preview.items.length === 0) {
    if (!afterDeadline) return existing ? response(existing) : null;
    if (existing) return response(existing);
    return response(saveDailyCandidateList({
      tradeDate: source.tradeDate, methodologyVersion: DAILY_FOCUS_VERSION, status: "unavailable", origin: "prospective", featureCutoff: cutoff,
      marketAsOf: source.marketAsOf, clueAsOf: source.clueAsOf, frozenAt: now.toISOString(), universeCount: source.quotes.length, eligibleCount: preview.items.length, selectedCount: 0,
      methodology: { version: DAILY_FOCUS_VERSION, deadlineMinutes }, dataQuality: preview.dataQuality, exclusionCounts: preview.exclusionCounts, reason: "没有标的通过当日筛选门槛", benchmarkMembers: [], items: [],
    }));
  }
  const recoveredFrom = existing ? {
    status: existing.status,
    methodologyVersion: existing.methodologyVersion,
    reason: existing.reason,
    frozenAt: existing.frozenAt,
  } : null;
  return response(saveDailyCandidateList({
    tradeDate: source.tradeDate, methodologyVersion: DAILY_FOCUS_VERSION, status: "frozen", origin: "prospective", featureCutoff: cutoff,
    marketAsOf: source.marketAsOf, clueAsOf: source.clueAsOf, frozenAt: now.toISOString(), universeCount: source.quotes.length, eligibleCount: preview.items.length, selectedCount: preview.items.length,
    methodology: { version: DAILY_FOCUS_VERSION, deadlineMinutes, referenceAudit: preview.dataQuality.referenceAudit, selectionDiagnostics: preview.dataQuality.selectionDiagnostics, ...(recoveredFrom ? { recoveredFrom } : {}) }, dataQuality: preview.dataQuality, exclusionCounts: preview.exclusionCounts, reason: null,
    benchmarkMembers: assembled.benchmark, items: preview.items,
  }, { replaceUnavailableWithFrozen: Boolean(recoveredFrom) }));
}

function observing(list: DailyCandidateList, code: string): DailyCandidateOutcome {
  return { signalTradeDate: list.tradeDate, code, horizon: 3, status: "observing", entryTradeDate: null, entryOpen: null, exitTradeDate: null, exitClose: null, stockReturn: null, marketReturn: null, marketExcess: null, industryReturn: null, industryExcess: null, maxAdverse: null, coverage: null, dataAsOf: null, completedAt: null, reason: "等待 T+3" };
}

/** Settles only immutable, prospective frozen lists.  `tradeDate` is the supplied latest market day, never an implicit current date. */
export function settleDailyCandidateOutcomes(tradeDate: string): number {
  let settled = 0;
  for (const list of listDailyCandidateLists().filter((item) => item.status === "frozen" && item.origin === "prospective" && item.tradeDate < tradeDate)) {
    const dates = getTradeDatesAfter(list.tradeDate, 3);
    const confirmationDates = getTradeDatesAfter(list.tradeDate, 6);
    const permanentlyInsufficient = confirmationDates.length >= 6 && confirmationDates[5]! <= tradeDate;
    const start = dates[0]; const end = dates[2];
    if (!start || !end || end > tradeDate) {
      for (const item of list.items) {
        try { saveDailyCandidateOutcomes([observing(list, item.code)]); } catch { /* existing outcome is immutable or already observing */ }
      }
      continue;
    }
    const startQuotes = new Map(getMarketQuotesByTradeDate(start).map((quote) => [quote.code, quote]));
    const endCutoff = cutoffFor(end);
    const closeQuotes = getMarketQuotesByTradeDate(end).filter((quote) => atOrAfter(quote.quoteAt, endCutoff));
    if (!closeQuotes.length) {
      for (const item of list.items) {
        try { saveDailyCandidateOutcomes([observing(list, item.code)]); } catch { /* existing outcome is immutable or already observing */ }
      }
      continue;
    }
    const endQuotes = new Map(closeQuotes.map((quote) => [quote.code, quote]));
    const benchmarkReturns = list.benchmarkMembers.flatMap((member) => {
      const open = startQuotes.get(member.code)?.open; const close = endQuotes.get(member.code)?.price;
      return open && close ? [{ member, value: close / open - 1 }] : [];
    });
    const coverage = list.benchmarkMembers.length ? benchmarkReturns.length / list.benchmarkMembers.length : 0;
    const dataAsOf = [...endQuotes.values()].map((quote) => quote.quoteAt).sort().at(-1) ?? null;
    // Market coverage is a property of the frozen benchmark, so it takes priority and finalizes
    // every frozen entry consistently—even an entry with its own missing price.
    if (coverage < .9) {
      for (const item of list.items) {
        const initial = observing(list, item.code);
        try { saveDailyCandidateOutcomes([initial]); } catch { /* already persisted */ }
        const unavailable: DailyCandidateOutcome = { ...initial, status: "unavailable", coverage: round(coverage), dataAsOf, completedAt: dataAsOf, reason: "冻结市场基准覆盖率低于 90%" };
        try { saveDailyCandidateOutcomes([unavailable]); settled++; } catch { /* final result stays immutable */ }
      }
      continue;
    }
    for (const item of list.items) {
      const initial = observing(list, item.code);
      try { saveDailyCandidateOutcomes([initial]); } catch { /* already persisted */ }
      const open = startQuotes.get(item.code)?.open; const exit = endQuotes.get(item.code);
      if (!open || !exit?.price) {
        if (!permanentlyInsufficient) continue;
        const unavailable: DailyCandidateOutcome = { ...initial, status: "unavailable", coverage: round(coverage), dataAsOf, completedAt: dataAsOf, reason: "入选股票缺少 T+1 开盘或 T+3 收盘行情" };
        try { saveDailyCandidateOutcomes([unavailable]); settled++; } catch { /* final result stays immutable */ }
        continue;
      }
      const stockReturn = exit.price / open - 1;
      const marketReturn = benchmarkReturns.reduce((sum, item) => sum + item.value, 0) / benchmarkReturns.length;
      const member = list.benchmarkMembers.find((value) => value.code === item.code);
      const industry = member?.industryCode ? benchmarkReturns.filter((value) => value.member.industryCode === member.industryCode).map((value) => value.value) : [];
      const lows = dates.flatMap((date) => getMarketQuotesByTradeDate(date).flatMap((quote) => quote.code === item.code && quote.low !== null ? [quote.low] : []));
      const industryReturn = industry.length ? industry.reduce((sum, value) => sum + value, 0) / industry.length : null;
      const completed: DailyCandidateOutcome = {
        ...initial, status: "completed", entryTradeDate: start, entryOpen: open, exitTradeDate: end, exitClose: exit.price,
        stockReturn: round(stockReturn), marketReturn: round(marketReturn), marketExcess: round(stockReturn - marketReturn), industryReturn: industryReturn === null ? null : round(industryReturn), industryExcess: industryReturn === null ? null : round(stockReturn - industryReturn),
        maxAdverse: lows.length ? round(Math.min(...lows.map((low) => low / open - 1))) : null, coverage: round(coverage), dataAsOf: exit.quoteAt, completedAt: exit.quoteAt, reason: null,
      };
      try { saveDailyCandidateOutcomes([completed]); settled++; } catch { /* final result stays immutable */ }
    }
  }
  return settled;
}

/** Rolling performance deliberately reads only prospective frozen lists and completed outcomes. */
export function getDailyCandidatePerformance(window: 20 | 60 = 20, costBps = 0) {
  const all = listDailyCandidateLists().filter((list) => list.origin === "prospective" && list.status === "frozen").sort((left, right) => right.tradeDate.localeCompare(left.tradeDate));
  const methodologyVersion = all[0]?.methodologyVersion ?? null;
  const days = all.filter((list) => list.methodologyVersion === methodologyVersion).flatMap((list) => {
    const outcomeByCode = new Map(getDailyCandidateOutcomes(list.tradeDate).filter((outcome) => outcome.status === "completed" && outcome.marketExcess !== null).map((outcome) => [outcome.code, outcome]));
    return outcomeByCode.size === list.items.length ? [{ tradeDate: list.tradeDate, outcomes: list.items.map((item) => ({ ...outcomeByCode.get(item.code)!, grade: item.grade, isHotIndustry: item.isHotIndustry })) }] : [];
  }).slice(0, window);
  const excesses = days.flatMap((day) => day.outcomes.map((outcome) => outcome.marketExcess!));
  const average = excesses.length ? excesses.reduce((sum, value) => sum + value, 0) / excesses.length : null;
  const sorted = [...excesses].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length ? (sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2) : null;
  const group = (predicate: (outcome: typeof days[number]["outcomes"][number]) => boolean) => { const values = days.flatMap((day) => day.outcomes.filter(predicate).map((outcome) => outcome.marketExcess!)); return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null; };
  const dailyEqualWeight = days.map((day) => day.outcomes.reduce((sum, outcome) => sum + outcome.marketExcess!, 0) / day.outcomes.length);
  const blocks = Array.from({ length: Math.floor(dailyEqualWeight.length / 3) }, (_, index) => dailyEqualWeight.slice(index * 3, index * 3 + 3).reduce((sum, value) => sum + value, 0) / 3);
  const blockMean = blocks.length ? blocks.reduce((sum, value) => sum + value, 0) / blocks.length : null;
  const blockStd = blocks.length > 1 && blockMean !== null ? Math.sqrt(blocks.reduce((sum, value) => sum + (value - blockMean) ** 2, 0) / (blocks.length - 1)) : null;
  return { window, methodologyVersion, costBps, sampleDays: days.length, sampleStage: days.length < 20 ? "accumulating" : days.length < 60 ? "exploratory" : "mature", dailyEqualWeightMarketExcess: dailyEqualWeight.length ? round(dailyEqualWeight.reduce((sum, value) => sum + value, 0) / dailyEqualWeight.length) : null, averageMarketExcess: average === null ? null : round(average), netAverageMarketExcess: average === null ? null : round(average - costBps / 10_000), hitRate: excesses.length ? round(excesses.filter((value) => value > 0).length / excesses.length) : null, medianMarketExcess: median === null ? null : round(median), groups: { A: group((outcome) => outcome.grade === "A"), B: group((outcome) => outcome.grade === "B"), hotIndustry: group((outcome) => outcome.isHotIndustry), nonHotIndustry: group((outcome) => !outcome.isHotIndustry) }, confidenceInterval: days.length >= 60 && blockMean !== null && blockStd !== null ? { low: round(blockMean - 1.96 * blockStd / Math.sqrt(blocks.length)), high: round(blockMean + 1.96 * blockStd / Math.sqrt(blocks.length)), blockDays: 3 } : null };
}
