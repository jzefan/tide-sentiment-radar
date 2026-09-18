import { sealMinutesFromOpen, type LeadershipTier } from "./leadership.ts";
import { MARKET_BOARDS, marketBoardOf, type MarketBoard } from "../src/domain/board.ts";

/** Pure, deterministic market-first selection policy (1–10 candidates + T+1 validation). */
export const DAILY_FOCUS_VERSION = "daily-focus-v6";
export const DAILY_FOCUS_WEIGHTS = { turnover: 30, direction: 18, discussion: 18, price: 18, industry: 12, reliability: 4 } as const;
/**
 * 板块配额的推荐比例（主板:中小板:创业板:科创板 = 3:3:2:2，合计 10）。
 * 这是「推荐值」而不是硬约束：某个板块没有合格候选时，它的名额会让给其他板块；
 * 某个板块候选很多时，也可以在补位阶段多拿几个，目标是尽量凑满 10 只。
 */
export const DAILY_FOCUS_BOARD_QUOTAS: Readonly<Record<MarketBoard, number>> = { 主板: 3, 中小板: 3, 创业板: 2, 科创板: 2 };
/** 龙头加分上限：不改变六维基础分的 100 分制，只作为入选加分与排序依据。 */
export const DAILY_FOCUS_LEADERSHIP_MAX = 12;
/** 未达龙头标准的涨停股加分上限：涨停是事实，但用户要的是「当前时段的龙头」，不能让普通涨停挤掉龙头。 */
export const DAILY_FOCUS_LEADERSHIP_NON_LEADER_MAX = 5;
export const DAILY_FOCUS_MIN_AMOUNT = 100_000_000;
export type DailyIndustryRelation = "舆情交易双热" | "舆情升温、价格未确认" | "交易驱动" | "常态行业";
export type AnalysisStatus = "scored" | "unscored" | "failed";
export interface DailyCandidateIndustry { name: string; textHeat: number; textDirection: number; marketStrength: number; breadth: number; relation: DailyIndustryRelation; }
/** 当日数据窗口内已核验的股东减持信号；命中即不可放宽地排除出候选。 */
export interface DailyCandidateShareReduction { level: "major" | "minor"; title: string; publishedAt: string; sourceKind: string; matched: string[]; }
/** 热门行业新闻确认：条数与方向构成“行业舆情”角度的评分输入。 */
export interface DailyCandidateIndustryNews { count: number; textDirection: number; }
/** 龙虎榜事实：同一股票当日只保留净买额绝对值最大的一条席位明细。 */
export interface DailyCandidateDragonTiger {
  netAmount: number | null;
  buyAmount: number | null;
  sellAmount: number | null;
  reasons: string[];
  listCount: number;
}
/**
 * 当日龙头事实（来自涨停板池 + 龙虎榜，落库前已与本地行情逐条核对）。
 * `tier` 由 leadership.ts 按全市场当日涨停事实判定，策略只负责加分与排序。
 */
export interface DailyCandidateLeadership {
  /** 连板数；1 为首板，0 表示当日未涨停但可能登上龙虎榜。 */
  boardCount: number;
  firstSealTime: string | null;
  lastSealTime: string | null;
  breakCount: number;
  sealAmount: number | null;
  dragonTiger: DailyCandidateDragonTiger | null;
  /** 所属行业当日涨停家数（按候选集合内的涨停股统计）。 */
  industryLimitUps: number;
  tier: LeadershipTier;
  reasons: string[];
}
export interface DiscussionWindow { count: number; interactions: number; elapsedMinutes: number; /** Only explicit true admits a window to the comparable baseline. */ verified?: boolean; }
export interface DailyCandidateInput {
  code: string; name: string; exchange: string; listingTradingDays: number; tradeDate: string;
  open: number; high: number; low: number; close: number; previousClose: number; pctChange: number; amount: number; amountHistory: number[]; marketExcess: number;
  analysisStatus: AnalysisStatus; textDirection: number; directionConsensus: number; textConfidence: number; freshness: number;
  discussionCount: number; userDiscussionCount: number; discussionInteractions: number; discussionElapsedMinutes: number; discussionHistory?: DiscussionWindow[];
  independentEvents: number; sourceCount: number; hasNonForumCorroboration: boolean; industry?: DailyCandidateIndustry | null;
  /** 减持信号来自公告等可核验来源；缺失表示当日窗口内没有可核验的减持证据。 */
  shareReduction?: DailyCandidateShareReduction | null;
  /** 行业舆情角度：候选所属行业的当日新闻条数与方向分。 */
  industryNews?: DailyCandidateIndustryNews | null;
  /** 当日龙头事实；缺失表示该交易日尚未取证涨停池/龙虎榜，按 0 分处理而非套用满分。 */
  leadership?: DailyCandidateLeadership | null;
  isSuspended?: boolean; onePriceLimit?: boolean; reopenedLimit?: boolean; threeDayReturn?: number; duplicateRatio?: number;
  /** Ignored legacy caller data; strategy derives these values itself. */
  threeDayReturnPercentile?: number; amountToMedianRatio?: number; discussionGrowthPercentile?: number;
}
export interface DailyCandidateScores { turnover: number; direction: number; discussion: number; price: number; industry: number; reliability: number; }
export interface AmountTrend { base: boolean; gradeA: boolean; gradeB: boolean; slope: number; increases: number; ratio: number; }
export interface DiscussionGrowth { value: number; mentionDelta: number; countMedian: number; interactionsMedian: number; isComparable: boolean; }
export interface ReferenceMetric { sampleSize: number; p5: number; p95: number; p99: number | null; }
export interface ReferenceAudit { market: { amount: ReferenceMetric; pctChange: ReferenceMetric; marketExcess: ReferenceMetric; threeDayReturn: ReferenceMetric }; text: { discussionCount: ReferenceMetric; discussionInteractions: ReferenceMetric; discussionGrowth: ReferenceMetric }; trend: { slope: ReferenceMetric }; leadership: { boardCount: ReferenceMetric }; }
export interface BoardQuotaDiagnostics {
  /** 推荐的板块比例（3:3:2:2）。 */
  quotas: Readonly<Record<MarketBoard, number>>;
  /** 各板块进入候选的合格股票数量。 */
  qualified: Record<MarketBoard | "未知", number>;
  /** 各板块实际入选数量。 */
  selected: Record<MarketBoard | "未知", number>;
  /** 因为某板块合格候选不足而让出的名额。 */
  shortfall: number;
  /** 补位阶段是否放宽了板块配额（某个板块的入选数超过配额）。 */
  relaxedBoardQuotas: boolean;
}
export interface SelectionDiagnostics { initialTarget: number; requiredHot: number; relaxedIndustryConstraints: boolean; constraintTruncated: boolean; boardQuota: BoardQuotaDiagnostics; reasons: string[]; }
export interface LeadershipDiagnostics { covered: boolean; limitUpCandidates: number; marketLeaders: string[]; industryLeaders: string[]; }
export interface DailyCandidateScored { code: string; board: MarketBoard | null; inputAudit: Readonly<DailyCandidateInput>; scores: DailyCandidateScores; trend: AmountTrend; baseScore: number; overheatPenalty: number; leadershipBonus: number; finalScore: number; grade: "A" | "B" | null; isHotIndustry: boolean; industry: DailyCandidateIndustry | null; discussionGrowth: DiscussionGrowth; discussionGrowthScore: number; leadershipTier: LeadershipTier; }
export interface DailyCandidateResult { methodologyVersion: typeof DAILY_FOCUS_VERSION; status: "available" | "unavailable"; items: DailyCandidateScored[]; scored: DailyCandidateScored[]; exclusionCounts: Record<string, number>; referenceAudit: ReferenceAudit; selectionDiagnostics: SelectionDiagnostics; leadershipDiagnostics: LeadershipDiagnostics; }
export const DAILY_FOCUS_BOUNDS = { directionStrength: [55, 86], amountRatio: [1, 2.5], independentEvents: [2, 5], sourceCount: [1, 3], closePosition: [0, 1] } as const;
export const OVERHEAT_MIN_SAMPLE_SIZE = 100;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
const integer = (value: unknown): value is number => finite(value) && Number.isInteger(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const points = (value: number, min: number, max: number, weight: number) => max === min ? weight : clamp((value - min) / (max - min), 0, 1) * weight;
const sorted = (values: number[]) => [...values].filter(finite).sort((left, right) => left - right);
const quantileSorted = (all: number[], percentile: number) => { if (!all.length) return 0; const index = (all.length - 1) * percentile; const lower = Math.floor(index); const upper = Math.ceil(index); return all[lower]! + (all[upper]! - all[lower]!) * (index - lower); };
const quantile = (values: number[], percentile: number) => quantileSorted(sorted(values), percentile);
const median = (values: number[]) => quantile(values, 0.5);
export interface PreparedMetric extends ReferenceMetric { ordered: number[]; }
const metric = (values: number[]): PreparedMetric => {
  const all = sorted(values);
  const p5 = quantileSorted(all, 0.05); const p95 = quantileSorted(all, 0.95);
  return { sampleSize: all.length, p5, p95, p99: all.length >= OVERHEAT_MIN_SAMPLE_SIZE ? all[Math.ceil(0.99 * all.length) - 1]! : null, ordered: all };
};
const lowerBound = (values: number[], target: number) => { let low = 0; let high = values.length; while (low < high) { const middle = (low + high) >>> 1; if (values[middle]! < target) low = middle + 1; else high = middle; } return low; };
const upperBound = (values: number[], target: number) => { let low = 0; let high = values.length; while (low < high) { const middle = (low + high) >>> 1; if (values[middle]! <= target) low = middle + 1; else high = middle; } return low; };
const metricScore = (value: number, reference: PreparedMetric) => {
  if (!finite(value) || !reference.sampleSize) return 0;
  if (reference.p95 === reference.p5) return value >= reference.p95 ? 100 : 0;
  const bounded = clamp(value, reference.p5, reference.p95);
  const lower = lowerBound(reference.ordered, bounded); const upper = upperBound(reference.ordered, bounded);
  if (upper > lower) return clamp(((lower + (upper - lower - 1) / 2) / Math.max(1, reference.sampleSize - 1)) * 100);
  const right = Math.min(reference.sampleSize - 1, lower); const left = Math.max(0, right - 1);
  const lowValue = reference.ordered[left]!; const highValue = reference.ordered[right]!;
  const fraction = highValue === lowValue ? 0 : (bounded - lowValue) / (highValue - lowValue);
  return clamp(((left + fraction) / Math.max(1, reference.sampleSize - 1)) * 100);
};
const topOnePercent = (value: number, reference: ReferenceMetric) => reference.p99 !== null && value >= reference.p99;
const auditMetric = ({ sampleSize, p5, p95, p99 }: PreparedMetric): ReferenceMetric => ({ sampleSize, p5, p95, p99 });

/** Generic unsmoothed nearest-rank quantile predicate. Ties at threshold all qualify. */
export function isAtOrAboveEmpiricalQuantile(value: number, reference: number[], percentile: number): boolean { const all = sorted(reference); return finite(value) && finite(percentile) && percentile > 0 && percentile <= 1 && all.length > 0 && value >= all[Math.ceil(percentile * all.length) - 1]!; }
export function winsorizedPercentile(value: number, reference: number[]): number { return metricScore(value, metric(reference)); }

export function calculateDiscussionGrowth(count: number, interactions: number, elapsedMinutes: number, history: DiscussionWindow[] = []): DiscussionGrowth {
  const comparable = positive(elapsedMinutes) && history.length === 5 && history.every((item) => item.verified === true && integer(item.count) && integer(item.interactions) && item.elapsedMinutes === elapsedMinutes);
  if (!comparable) return { value: 0, mentionDelta: 0, countMedian: 0, interactionsMedian: 0, isComparable: false };
  const countMedian = median(history.map((item) => item.count)); const interactionsMedian = median(history.map((item) => item.interactions));
  return { value: .7 * (Math.log1p(count) - Math.log1p(countMedian)) + .3 * (Math.log1p(interactions) - Math.log1p(interactionsMedian)), mentionDelta: count - countMedian, countMedian, interactionsMedian, isComparable: true };
}
export function amountTrend(history: number[]): AmountTrend {
  if (history.length !== 5 || history.some((value) => !positive(value))) return { base: false, gradeA: false, gradeB: false, slope: 0, increases: 0, ratio: 0 };
  const logs = history.map(Math.log); const mean = logs.reduce((sum, value) => sum + value, 0) / 5; const slope = logs.reduce((sum, value, index) => sum + (index - 2) * (value - mean), 0) / 10;
  const increases = history.slice(1).filter((value, index) => value > history[index]!).length; const ratio = history[4]! / history[0]!; const base = slope > 0 && ratio > 1 && increases >= 2;
  return { base, gradeA: base && increases >= 3 && ratio >= 1.2, gradeB: base && increases >= 2 && ratio >= 1.05, slope, increases, ratio };
}

const relations = new Set<DailyIndustryRelation>(["舆情交易双热", "舆情升温、价格未确认", "交易驱动", "常态行业"]);
const statuses = new Set<AnalysisStatus>(["scored", "unscored", "failed"]);
const validIndustry = (industry: unknown): industry is DailyCandidateIndustry | null | undefined => industry === undefined || industry === null || (record(industry) && typeof industry.name === "string" && industry.name.trim().length > 0 && typeof industry.relation === "string" && relations.has(industry.relation as DailyIndustryRelation) && [industry.textHeat, industry.textDirection, industry.marketStrength, industry.breadth].every((value) => finite(value) && value >= 0 && value <= 100));
const validShareReduction = (value: unknown): value is DailyCandidateShareReduction | null | undefined => value === undefined || value === null || (record(value)
  && (value.level === "major" || value.level === "minor")
  && typeof value.title === "string" && value.title.trim().length > 0
  && typeof value.publishedAt === "string" && value.publishedAt.length > 0
  && typeof value.sourceKind === "string" && value.sourceKind.length > 0
  && Array.isArray(value.matched) && value.matched.every((item) => typeof item === "string"));
const validIndustryNews = (value: unknown): value is DailyCandidateIndustryNews | null | undefined => value === undefined || value === null || (record(value)
  && integer(value.count) && value.count > 0
  && finite(value.textDirection) && value.textDirection >= 0 && value.textDirection <= 100);
const validLeadership = (value: unknown): value is DailyCandidateLeadership | null | undefined => value === undefined || value === null || (record(value)
  && integer(value.boardCount) && value.boardCount >= 0 && value.boardCount <= 30
  && (value.firstSealTime === null || (typeof value.firstSealTime === "string" && /^\d{2}:\d{2}:\d{2}$/.test(value.firstSealTime)))
  && (value.lastSealTime === null || (typeof value.lastSealTime === "string" && /^\d{2}:\d{2}:\d{2}$/.test(value.lastSealTime)))
  && integer(value.breakCount)
  && (value.sealAmount === null || finite(value.sealAmount))
  && (value.dragonTiger === null || (record(value.dragonTiger)
    && (value.dragonTiger.netAmount === null || finite(value.dragonTiger.netAmount))
    && (value.dragonTiger.buyAmount === null || finite(value.dragonTiger.buyAmount))
    && (value.dragonTiger.sellAmount === null || finite(value.dragonTiger.sellAmount))
    && Array.isArray(value.dragonTiger.reasons) && value.dragonTiger.reasons.every((item) => typeof item === "string")
    && integer(value.dragonTiger.listCount)))
  && integer(value.industryLimitUps)
  && (value.tier === "market" || value.tier === "industry" || value.tier === "none")
  && Array.isArray(value.reasons) && value.reasons.every((item) => typeof item === "string"));
function validInput(input: unknown): input is DailyCandidateInput {
  if (!record(input) || !Array.isArray(input.amountHistory) || (input.discussionHistory !== undefined && (!Array.isArray(input.discussionHistory) || !input.discussionHistory.every(record)))) return false;
  const candidate = input as unknown as DailyCandidateInput;
  const signals = [candidate.textDirection, candidate.directionConsensus, candidate.textConfidence, candidate.freshness];
  const optionalBooleans = [candidate.isSuspended, candidate.onePriceLimit, candidate.reopenedLimit];
  return typeof candidate.code === "string" && candidate.code.length > 0 && typeof candidate.name === "string" && typeof candidate.tradeDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(candidate.tradeDate) && typeof candidate.exchange === "string" && integer(candidate.listingTradingDays) &&
    [candidate.open, candidate.high, candidate.low, candidate.close, candidate.previousClose, candidate.amount, candidate.pctChange, candidate.marketExcess].every(finite) && candidate.amount >= 0 && candidate.open > 0 && candidate.high > 0 && candidate.low > 0 && candidate.close > 0 && candidate.previousClose > 0 && candidate.high >= candidate.low && candidate.open >= candidate.low && candidate.open <= candidate.high && candidate.close >= candidate.low && candidate.close <= candidate.high &&
    candidate.amountHistory.length === 5 && candidate.amountHistory.every((value) => finite(value) && value >= 0) && signals.every((value) => finite(value) && value >= 0 && value <= 100) && integer(candidate.discussionCount) && integer(candidate.userDiscussionCount) && integer(candidate.discussionInteractions) && integer(candidate.independentEvents) && integer(candidate.sourceCount) && positive(candidate.discussionElapsedMinutes) && (candidate.duplicateRatio === undefined || finite(candidate.duplicateRatio) && candidate.duplicateRatio >= 0 && candidate.duplicateRatio <= 1) && (candidate.threeDayReturn === undefined || finite(candidate.threeDayReturn)) && typeof candidate.hasNonForumCorroboration === "boolean" && optionalBooleans.every((value) => value === undefined || typeof value === "boolean") && statuses.has(candidate.analysisStatus) && validIndustry(candidate.industry) && validShareReduction(candidate.shareReduction) && validIndustryNews(candidate.industryNews) && validLeadership(candidate.leadership);
}
const risk = (name: string) => /(?:^|\s)\*?ST(?=\s|[^A-Za-z0-9]|$)|退市/i.test(name);
const invalidQuote = (input: DailyCandidateInput) => input.isSuspended === true || input.amount <= 0;
const marketClean = (input: DailyCandidateInput) => (input.exchange === "SH" || input.exchange === "SZ") && input.listingTradingDays >= 30 && !risk(input.name) && !invalidQuote(input);
const hot = (industry: DailyCandidateIndustry | null | undefined) => Boolean(industry
  && industry.marketStrength >= 65
  && industry.breadth >= 50
  && (industry.textHeat >= 70 || industry.relation === "交易驱动" || industry.relation === "舆情交易双热"));
function deepFreeze<T>(value: T): Readonly<T> { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value as Record<string, unknown>).forEach((child) => deepFreeze(child)); Object.freeze(value); } return value as Readonly<T>; }
const auditInput = (input: DailyCandidateInput): Readonly<DailyCandidateInput> => deepFreeze({ ...input, amountHistory: [...input.amountHistory], discussionHistory: input.discussionHistory?.map((item) => ({ ...item })), industry: input.industry ? { ...input.industry } : input.industry, shareReduction: input.shareReduction ? { ...input.shareReduction, matched: [...input.shareReduction.matched] } : input.shareReduction, industryNews: input.industryNews ? { ...input.industryNews } : input.industryNews, leadership: input.leadership ? { ...input.leadership, reasons: [...input.leadership.reasons], dragonTiger: input.leadership.dragonTiger ? { ...input.leadership.dragonTiger, reasons: [...input.leadership.dragonTiger.reasons] } : input.leadership.dragonTiger } : input.leadership });

interface PreparedReferences { market: { amount: PreparedMetric; pctChange: PreparedMetric; marketExcess: PreparedMetric; threeDayReturn: PreparedMetric }; text: { discussionCount: PreparedMetric; discussionInteractions: PreparedMetric; discussionGrowth: PreparedMetric }; trend: { slope: PreparedMetric }; leadership: { boardCount: PreparedMetric }; audit: ReferenceAudit; }
function prepare(market: DailyCandidateInput[], text: DailyCandidateInput[], trend: DailyCandidateInput[]): PreparedReferences {
  const growths = text.map((item) => calculateDiscussionGrowth(item.discussionCount, item.discussionInteractions, item.discussionElapsedMinutes, item.discussionHistory)).filter((item) => item.isComparable).map((item) => item.value);
  // 连板高度的参考集只统计当日真正涨停的股票：全市场里绝大多数是 0 板，
  // 混进来会把分位数压成 0/100 的二值，任何一只涨停股都拿到满分。
  const boardCounts = trend.flatMap((item) => (item.leadership?.boardCount ?? 0) > 0 ? [item.leadership!.boardCount] : []);
  const refs = { market: { amount: metric(market.map((item) => item.amount)), pctChange: metric(market.map((item) => item.pctChange)), marketExcess: metric(market.map((item) => item.marketExcess)), threeDayReturn: metric(market.flatMap((item) => item.threeDayReturn === undefined ? [] : [item.threeDayReturn])) }, text: { discussionCount: metric(text.map((item) => item.discussionCount)), discussionInteractions: metric(text.map((item) => item.discussionInteractions)), discussionGrowth: metric(growths) }, trend: { slope: metric(trend.map((item) => amountTrend(item.amountHistory).slope)) }, leadership: { boardCount: metric(boardCounts) } };
  return { ...refs, audit: deepFreeze({ market: { amount: auditMetric(refs.market.amount), pctChange: auditMetric(refs.market.pctChange), marketExcess: auditMetric(refs.market.marketExcess), threeDayReturn: auditMetric(refs.market.threeDayReturn) }, text: { discussionCount: auditMetric(refs.text.discussionCount), discussionInteractions: auditMetric(refs.text.discussionInteractions), discussionGrowth: auditMetric(refs.text.discussionGrowth) }, trend: { slope: auditMetric(refs.trend.slope) }, leadership: { boardCount: auditMetric(refs.leadership.boardCount) } }) as ReferenceAudit };
}

/**
 * 龙头加分（0–12）只使用可核验事实：连板高度、首次封板时间、炸板次数、龙虎榜与行业涨停家数。
 * 未取证（leadership 为空）一律记 0，不把缺失当满分；加分不改变六维基础分的 100 分制。
 */
export function leadershipBonusOf(input: DailyCandidateInput, boardCountReference: PreparedMetric): number {
  const leadership = input.leadership;
  if (!leadership) return 0;
  const boardCount = leadership.boardCount;
  const limitUp = boardCount >= 1;
  // 首板只是「今天涨停」，没有连板高度可言：高度分与封板分只给两板以上的候选，
  // 首板最多拿行业涨停家数（板块合力）与龙虎榜。这样加分真正指向龙头而不是任何涨停。
  const leaderLike = boardCount >= 2;
  const heightScore = leaderLike ? points(metricScore(boardCount, boardCountReference), 0, 100, 5) + points(boardCount, 1, 5, 2) : 0;
  const minutes = sealMinutesFromOpen(leadership.firstSealTime);
  const sealScore = leaderLike && minutes !== null ? points(240 - clamp(minutes, 0, 240), 0, 240, 3) : 0;
  const dragonTigerScore = leadership.dragonTiger ? ((leadership.dragonTiger.netAmount ?? 0) > 0 ? 2 : 1) : 0;
  const industryHeatScore = limitUp ? points(leadership.industryLimitUps, 1, 5, 2) : 0;
  const tierScore = leadership.tier === "market" ? 2 : leadership.tier === "industry" ? 1 : 0;
  const breakPenalty = limitUp ? Math.min(3, Math.max(0, leadership.breakCount)) : 0;
  // 只有被判定为龙头的股票才能吃到满额加分；普通涨停（含连板但非龙头）封顶 5 分。
  const cap = leadership.tier === "none" ? DAILY_FOCUS_LEADERSHIP_NON_LEADER_MAX : DAILY_FOCUS_LEADERSHIP_MAX;
  return Math.round(clamp(heightScore + sealScore + dragonTigerScore + industryHeatScore + tierScore - breakPenalty, 0, cap));
}

interface InternalScored extends DailyCandidateScored { raw: DailyCandidateInput; }
function score(input: DailyCandidateInput, refs: PreparedReferences): InternalScored {
  const inputAudit = auditInput(input); const trend = amountTrend(input.amountHistory); const growth = calculateDiscussionGrowth(input.discussionCount, input.discussionInteractions, input.discussionElapsedMinutes, input.discussionHistory); const amountRatio = input.amount / median(input.amountHistory); const position = input.high === input.low ? .5 : clamp((input.close - input.low) / (input.high - input.low), 0, 1); const relation = input.industry?.relation; const relationValue = relation === "舆情交易双热" ? 100 : relation === "舆情升温、价格未确认" ? 60 : relation === "交易驱动" ? 35 : 0;
  const growthScore = growth.isComparable ? points(metricScore(growth.value, refs.text.discussionGrowth), 0, 100, 9) : 0;
  // 行业舆情角度：行业当天有新闻才加分，条数与方向各 1 分，合计仍为 12 分的行业共振权重。
  const industryNewsScore = input.industryNews ? points(input.industryNews.count, 0, 3, 1) + points(input.industryNews.textDirection, 50, 80, 1) : 0;
  const scores: DailyCandidateScores = { turnover: points(metricScore(trend.slope, refs.trend.slope), 0, 100, 8) + points(trend.increases, 0, 4, 6) + points(trend.ratio, 1, 1.5, 5) + points(metricScore(input.amount, refs.market.amount), 0, 100, 6) + points(amountRatio, ...DAILY_FOCUS_BOUNDS.amountRatio, 5), direction: points(input.textDirection, ...DAILY_FOCUS_BOUNDS.directionStrength, 9) + points(input.directionConsensus, 0, 100, 4) + points(input.textConfidence, 0, 100, 3) + points(input.freshness, 0, 100, 2), discussion: points(metricScore(input.discussionCount, refs.text.discussionCount), 0, 100, 5) + points(metricScore(input.discussionInteractions, refs.text.discussionInteractions), 0, 100, 4) + growthScore, price: points(metricScore(input.pctChange, refs.market.pctChange), 0, 100, 8) + points(metricScore(input.marketExcess, refs.market.marketExcess), 0, 100, 6) + points(position, 0, 1, 4), industry: input.industry ? points(input.industry.textHeat, 0, 100, 2) + points(input.industry.textDirection, 0, 100, 2) + points(input.industry.marketStrength, 0, 100, 3) + points(input.industry.breadth, 0, 100, 2) + points(relationValue, 0, 100, 1) + industryNewsScore : 0, reliability: points(input.independentEvents, ...DAILY_FOCUS_BOUNDS.independentEvents, 1) + points(input.sourceCount, ...DAILY_FOCUS_BOUNDS.sourceCount, 1) + (input.hasNonForumCorroboration ? 2 : 0) };
  const penalty = overheatPenalty(input, amountRatio, input.threeDayReturn !== undefined && topOnePercent(input.threeDayReturn, refs.market.threeDayReturn), growth.isComparable && topOnePercent(growth.value, refs.text.discussionGrowth)); const baseScore = Object.values(scores).reduce((sum, value) => sum + value, 0);
  const leadershipBonus = leadershipBonusOf(input, refs.leadership.boardCount);
  const finalScore = Math.round(clamp(baseScore + leadershipBonus - penalty));
  const grade = gradeCandidate({ scores, trend, finalScore, textDirection: input.textDirection });
  return { raw: input, code: input.code, board: marketBoardOf(input.code), inputAudit, scores, trend, baseScore, overheatPenalty: penalty, leadershipBonus, finalScore, grade, isHotIndustry: hot(input.industry), industry: inputAudit.industry ?? null, discussionGrowth: growth, discussionGrowthScore: growthScore, leadershipTier: input.leadership?.tier ?? "none" };
}
export function overheatPenalty(input: Pick<DailyCandidateInput, "reopenedLimit" | "sourceCount" | "duplicateRatio">, amountRatio: number, topThreeDayReturn: boolean, topDiscussionGrowth: boolean): number { return Math.min(10, (input.reopenedLimit ? 3 : 0) + (topThreeDayReturn && amountRatio >= 2.5 ? 4 : 0) + (topDiscussionGrowth && (input.sourceCount <= 1 || (input.duplicateRatio ?? 0) >= .4) ? 3 : 0)); }
export function gradeCandidate(candidate: Pick<DailyCandidateScored, "scores" | "trend" | "finalScore"> & { textDirection: number }): "A" | "B" | null {
  if (candidate.finalScore >= 72
    && candidate.scores.turnover >= 21
    && candidate.scores.direction >= 9.9
    && candidate.scores.discussion >= 9.9
    && candidate.scores.price >= 9.9
    && candidate.textDirection >= 58
    && candidate.trend.gradeA) return "A";
  // Text, discussion, and authority evidence improve ranking and may promote an
  // A signal, but their absence must not erase an otherwise strong market setup.
  return candidate.finalScore >= 40
    && candidate.scores.turnover >= 15
    && candidate.scores.price >= 9
    && candidate.trend.base ? "B" : null;
}
const compare = (left: DailyCandidateScored, right: DailyCandidateScored) => right.finalScore - left.finalScore || right.leadershipBonus - left.leadershipBonus || right.scores.turnover - left.scores.turnover || right.discussionGrowthScore - left.discussionGrowthScore || right.scores.industry - left.scores.industry || (left.code < right.code ? -1 : left.code > right.code ? 1 : 0);
const boardKeyOf = (code: string): MarketBoard | "未知" => marketBoardOf(code) ?? "未知";

const emptyBoardCounts = (): Record<MarketBoard | "未知", number> => ({ 主板: 0, 中小板: 0, 创业板: 0, 科创板: 0, 未知: 0 });

/**
 * 板块配额 + 行业分散的确定性选取。
 *
 * 1. 热门行业优先：按全局分数顺序，先把热门行业且所在板块还有配额的名额填到 70%；
 * 2. 配额填充：继续按全局分数顺序，每个板块最多拿 `quotas[板块]` 只（3:3:2:2）；
 * 3. 补位：某些板块合格候选不足时名额会空出来，此时放宽板块配额，按全局分数把剩下的
 *    名额补满（先受行业上限约束，仍不满再放宽行业上限），尽量凑满 10 只。
 *
 * 板块配额只决定「谁能进来」，最终展示顺序仍按分数排序。
 */
function selectWithIndustry<T extends DailyCandidateScored>(candidates: T[], target: number, quotas: Readonly<Record<MarketBoard, number>> = DAILY_FOCUS_BOARD_QUOTAS): { items: T[]; diagnostics: SelectionDiagnostics } {
  const selected: T[] = [];
  const selectedCodes = new Set<string>();
  const counts = new Map<string, number>();
  const boardSelected = emptyBoardCounts();
  const requiredHot = Math.min(target, Math.ceil(target * .7));
  let relaxed = false;
  const add = (item: T, strict: boolean, boardLimited: boolean) => {
    if (selectedCodes.has(item.code) || selected.length >= target) return false;
    const key = item.industry?.name ?? "__missing__";
    if (strict && (counts.get(key) ?? 0) >= 3) return false;
    const board = boardKeyOf(item.code);
    if (boardLimited) {
      // 未知板块（B 股、未来新增前缀等）不占配额，但也不跟四个板块抢配额名额：
      // 它只在补位阶段入选，保证推荐比例不被边缘情况打乱。
      if (board === "未知") return false;
      if (boardSelected[board] >= (quotas[board] ?? 0)) return false;
    }
    selected.push(item);
    selectedCodes.add(item.code);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    boardSelected[board] += 1;
    return true;
  };
  const sortedCandidates = [...candidates].sort(compare);
  for (const item of sortedCandidates.filter((item) => item.isHotIndustry)) {
    if (selected.length >= requiredHot) break;
    add(item, true, true);
  }
  for (const item of sortedCandidates) add(item, true, true);
  // 配额阶段结束时各板块拿到了多少；没填满的名额就是让给其他板块的部分。
  const boardFilledByQuota = { ...boardSelected };
  const quotaShortfall = MARKET_BOARDS.reduce((sum, board) => sum + Math.max(0, (quotas[board] ?? 0) - boardFilledByQuota[board]), 0);
  // 板块候选不足会让名额空出来：放宽板块配额补满（行业上限仍生效）。
  if (selected.length < target) {
    for (const item of sortedCandidates) {
      if (selected.length >= target) break;
      add(item, true, false);
    }
  }
  // 行业集中只是偏好：供给集中在少数行业时进一步放宽，保住 10 个名额。
  if (selected.length < target) {
    for (const item of sortedCandidates) {
      if (selected.length >= target) break;
      if (add(item, false, false)) relaxed = true;
    }
  }
  const qualifiedBoards = emptyBoardCounts();
  for (const item of candidates) qualifiedBoards[boardKeyOf(item.code)] += 1;
  const selectedOverQuota = MARKET_BOARDS.some((board) => boardSelected[board] > (quotas[board] ?? 0));
  const boardRelaxed = quotaShortfall > 0 || selectedOverQuota;
  const truncated = selected.length < target;
  const reasons = [
    ...(truncated ? ["qualified candidates exhausted"] : []),
    ...(boardRelaxed ? ["board quota relaxed to fill the target"] : []),
  ];
  return {
    items: selected.sort(compare),
    diagnostics: deepFreeze({
      initialTarget: target,
      requiredHot,
      relaxedIndustryConstraints: relaxed,
      constraintTruncated: truncated,
      boardQuota: { quotas: { ...quotas }, qualified: qualifiedBoards, selected: boardSelected, shortfall: quotaShortfall, relaxedBoardQuotas: boardRelaxed },
      reasons,
    }) as SelectionDiagnostics,
  };
}
export function selectDailyCandidates(source: unknown): DailyCandidateResult {
  if (!Array.isArray(source)) { const refs = prepare([], [], []); const selection = selectWithIndustry([], 0); return { methodologyVersion: DAILY_FOCUS_VERSION, status: "unavailable", items: [], scored: [], exclusionCounts: { invalidInput: 1 }, referenceAudit: refs.audit, selectionDiagnostics: selection.diagnostics, leadershipDiagnostics: { covered: false, limitUpCandidates: 0, marketLeaders: [], industryLeaders: [] } }; }
  const inputs: unknown[] = source; const exclusionCounts: Record<string, number> = {}; const invalid = new Set<number>(); inputs.forEach((input, index) => { if (!validInput(input)) invalid.add(index); }); const dates = new Map<string, number>(); inputs.forEach((input, index) => { if (!invalid.has(index)) dates.set((input as DailyCandidateInput).tradeDate, (dates.get((input as DailyCandidateInput).tradeDate) ?? 0) + 1); }); const canonicalDate = [...dates.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]; inputs.forEach((input, index) => { if (!invalid.has(index) && (input as DailyCandidateInput).tradeDate !== canonicalDate) invalid.add(index); }); const codes = new Map<string, number[]>(); inputs.forEach((input, index) => { if (!invalid.has(index)) { const candidate = input as DailyCandidateInput; codes.set(candidate.code, [...(codes.get(candidate.code) ?? []), index]); } }); codes.forEach((indexes) => { if (indexes.length > 1) indexes.forEach((index) => invalid.add(index)); }); if (invalid.size) exclusionCounts.invalidInput = invalid.size;
  const eligible: DailyCandidateInput[] = []; inputs.forEach((unknownInput, index) => { if (invalid.has(index)) return; const input = unknownInput as DailyCandidateInput; const reason = input.exchange !== "SH" && input.exchange !== "SZ" ? "exchange" : risk(input.name) ? "risk" : input.listingTradingDays < 30 ? "listing" : invalidQuote(input) ? "invalidQuote" : input.onePriceLimit ? "onePriceLimit" : input.shareReduction ? input.shareReduction.level === "major" ? "majorShareReduction" : "shareReduction" : input.amount < DAILY_FOCUS_MIN_AMOUNT ? "amount" : !amountTrend(input.amountHistory).base ? "amountTrend" : input.pctChange <= 0 || input.marketExcess <= 0 ? "positiveReturn" : null; if (reason) exclusionCounts[reason] = (exclusionCounts[reason] ?? 0) + 1; else eligible.push(input); });
  const market = inputs.flatMap((input, index) => !invalid.has(index) && marketClean(input as DailyCandidateInput) ? [input as DailyCandidateInput] : []); const text = market.filter((input) => input.analysisStatus === "scored"); const trend = market.filter((input) => input.amountHistory.every(positive)); const refs = prepare(market, text, trend); const scored = eligible.map((input) => score(input, refs)).sort(compare); const qualified = scored.filter((item) => item.grade !== null); const target = Math.min(10, qualified.length); const selection = selectWithIndustry(qualified, target); const internalItems = selection.items; const expose = ({ raw: _raw, ...item }: InternalScored): DailyCandidateScored => item;
  const leadershipDiagnostics: LeadershipDiagnostics = {
    covered: eligible.some((input) => input.leadership != null),
    limitUpCandidates: eligible.filter((input) => (input.leadership?.boardCount ?? 0) >= 1).length,
    marketLeaders: scored.filter((item) => item.leadershipTier === "market").map((item) => item.code),
    industryLeaders: scored.filter((item) => item.leadershipTier === "industry").map((item) => item.code),
  };
  return { methodologyVersion: DAILY_FOCUS_VERSION, status: internalItems.length ? "available" : "unavailable", items: internalItems.map(expose), scored: scored.map(expose), exclusionCounts, referenceAudit: refs.audit, selectionDiagnostics: selection.diagnostics, leadershipDiagnostics };
}
