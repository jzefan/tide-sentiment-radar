import { marketBoardOf, type MarketBoard } from "../src/domain/board.ts";
import type { LeadershipTier } from "./leadership.ts";
import {
  DAILY_FOCUS_MIN_AMOUNT,
  amountTrend,
  calculateDiscussionGrowth,
  isAtOrAboveEmpiricalQuantile,
  winsorizedPercentile,
  type AmountTrend,
  type DailyCandidateIndustry,
  type DailyCandidateInput as V6DailyCandidateInput,
  type DailyCandidateScores,
  type DiscussionGrowth,
  type ReferenceAudit,
  type ReferenceMetric,
} from "./dailyCandidateStrategy.ts";

export type { DiscussionWindow } from "./dailyCandidateStrategy.ts";

export const DAILY_FOCUS_VERSION = "daily-focus-v7";
export const DAILY_FOCUS_MAX_ITEMS = 8;
/** 研究位：走事件/趋势通道的候选最多占几个名额。 */
export const DAILY_FOCUS_RESEARCH_SEATS = 5;
/** 热点位：只靠当前热度进来的候选最多几个（弹性位不再补热点，避免整榜都是热点）。 */
export const DAILY_FOCUS_HOT_SEATS = 2;
export const DAILY_FOCUS_RESEARCH_WEIGHT = 0.80;
export const DAILY_FOCUS_HOT_WEIGHT = 0.20;
export const DAILY_FOCUS_LEADERSHIP_MAX = 3;
export const DAILY_FOCUS_OVERHEAT_MAX = 10;
export const DAILY_FOCUS_REPEAT_MAX = 6;

export type DailyFocusLane = "event" | "trend" | "dual" | null;
export type DailyFocusType = "research" | "hot" | "research-hot";

export interface DailyCandidateEventFeature {
  clusterId: string;
  title: string;
  category: string;
  importance: number;
  persistence: number;
  novelty: number;
  direction: number;
  confidence: number;
  evidenceCount: number;
  independentSourceCount: number;
  authorityCount: number;
}

export interface DailyCandidateInput extends V6DailyCandidateInput {
  eventClusters?: DailyCandidateEventFeature[];
  historicalTextDirectionMedian?: number | null;
  sentimentDelta?: number | null;
  historicalEventCountMedian?: number | null;
  focusDaysLast5?: number;
  consecutiveFocusDays?: number;
  lastFocusDate?: string | null;
  lastPrimaryEventClusterId?: string | null;
}

export interface DailyCandidateScored {
  code: string;
  board: MarketBoard | null;
  inputAudit: Readonly<DailyCandidateInput>;
  scores: DailyCandidateScores;
  trend: AmountTrend;
  baseScore: number;
  overheatPenalty: number;
  leadershipBonus: number;
  repeatPenalty: number;
  continuationBonus: number;
  finalScore: number;
  grade: "A" | "B" | null;
  isHotIndustry: boolean;
  industry: DailyCandidateIndustry | null;
  discussionGrowth: DiscussionGrowth;
  discussionGrowthScore: number;
  leadershipTier: LeadershipTier;
  lane: DailyFocusLane;
  focusType: DailyFocusType;
  researchScore2W: number;
  hotScore: number;
  eventScore: number;
  trendScore: number;
  eventEligible: boolean;
  trendEligible: boolean;
  hotEligible: boolean;
  catalystPersistence: number;
  eventNovelty: number;
  sentimentDelta: number | null;
  attentionAcceleration: number | null;
  primaryEvent: DailyCandidateEventFeature | null;
  /** 与上一次聚焦时的核心事件相比，理由是否发生变化。 */
  focusReasonChanged: boolean;
}

export interface V7SelectionDiagnostics {
  initialTarget: number;
  selectedCount: number;
  researchSelected: number;
  hotSelected: number;
  industryLimit: number;
  eventLimit: number;
  relaxedIndustryLimit: boolean;
  reasons: string[];
}

export interface LeadershipDiagnostics {
  covered: boolean;
  limitUpCandidates: number;
  marketLeaders: string[];
  industryLeaders: string[];
}

export interface DailyCandidateResult {
  methodologyVersion: typeof DAILY_FOCUS_VERSION;
  status: "available" | "unavailable";
  items: DailyCandidateScored[];
  scored: DailyCandidateScored[];
  exclusionCounts: Record<string, number>;
  referenceAudit: ReferenceAudit;
  selectionDiagnostics: V7SelectionDiagnostics;
  leadershipDiagnostics: LeadershipDiagnostics;
}

interface References {
  amount: number[];
  pctChange: number[];
  marketExcess: number[];
  discussionCount: number[];
  discussionInteractions: number[];
  discussionGrowth: number[];
  slope: number[];
  threeDayReturn: number[];
  /** 连板高度参考集：只统计当日真正涨停的股票。 */
  boardCount: number[];
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value));
const round = (value: number) => Math.round(value * 10) / 10;
const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const median = (values: number[]) => {
  const ordered = [...values].filter(finite).sort((a, b) => a - b);
  if (!ordered.length) return 0;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]!
    : (ordered[middle - 1]! + ordered[middle]!) / 2;
};
const score100 = (value: number, min: number, max: number) =>
  max === min ? 100 : clamp(((value - min) / (max - min)) * 100);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((child) => deepFreeze(child));
    Object.freeze(value);
  }
  return value as Readonly<T>;
}

function auditInput(input: DailyCandidateInput): Readonly<DailyCandidateInput> {
  return deepFreeze({
    ...input,
    amountHistory: [...input.amountHistory],
    discussionHistory: input.discussionHistory?.map((item) => ({ ...item })),
    industry: input.industry ? { ...input.industry } : input.industry,
    shareReduction: input.shareReduction
      ? { ...input.shareReduction, matched: [...input.shareReduction.matched] }
      : input.shareReduction,
    industryNews: input.industryNews ? { ...input.industryNews } : input.industryNews,
    leadership: input.leadership
      ? {
          ...input.leadership,
          reasons: [...input.leadership.reasons],
          dragonTiger: input.leadership.dragonTiger
            ? { ...input.leadership.dragonTiger, reasons: [...input.leadership.dragonTiger.reasons] }
            : input.leadership.dragonTiger,
        }
      : input.leadership,
    eventClusters: input.eventClusters?.map((item) => ({ ...item })),
  });
}

function validInput(value: unknown): value is DailyCandidateInput {
  if (!record(value)) return false;
  const input = value as unknown as DailyCandidateInput;
  return typeof input.code === "string"
    && typeof input.name === "string"
    && (input.exchange === "SH" || input.exchange === "SZ" || input.exchange === "BJ")
    && typeof input.tradeDate === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(input.tradeDate)
    && finite(input.listingTradingDays)
    && [input.open, input.high, input.low, input.close, input.previousClose, input.pctChange, input.amount, input.marketExcess].every(finite)
    && Array.isArray(input.amountHistory)
    && input.amountHistory.length === 5
    && input.amountHistory.every(finite)
    && finite(input.textDirection)
    && finite(input.directionConsensus)
    && finite(input.textConfidence)
    && finite(input.freshness)
    && finite(input.discussionCount)
    && finite(input.discussionInteractions)
    && finite(input.discussionElapsedMinutes)
    && finite(input.independentEvents)
    && finite(input.sourceCount)
    && typeof input.hasNonForumCorroboration === "boolean";
}

function metric(values: number[]): ReferenceMetric {
  const ordered = [...values].filter(finite).sort((a, b) => a - b);
  const q = (p: number) => {
    if (!ordered.length) return 0;
    const position = (ordered.length - 1) * p;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return ordered[low]! + (ordered[high]! - ordered[low]!) * (position - low);
  };
  return {
    sampleSize: ordered.length,
    p5: q(0.05),
    p95: q(0.95),
    p99: ordered.length >= 100 ? ordered[Math.ceil(ordered.length * 0.99) - 1]! : null,
  };
}

function referenceAudit(refs: References): ReferenceAudit {
  return deepFreeze({
    market: {
      amount: metric(refs.amount),
      pctChange: metric(refs.pctChange),
      marketExcess: metric(refs.marketExcess),
      threeDayReturn: metric(refs.threeDayReturn),
    },
    text: {
      discussionCount: metric(refs.discussionCount),
      discussionInteractions: metric(refs.discussionInteractions),
      discussionGrowth: metric(refs.discussionGrowth),
    },
    trend: { slope: metric(refs.slope) },
    leadership: { boardCount: metric(refs.boardCount) },
  });
}

function riskName(name: string) {
  return /(?:^|\s)\*?ST(?=\s|[^A-Za-z0-9]|$)|退市/i.test(name);
}

function hotIndustry(industry: DailyCandidateIndustry | null | undefined) {
  return Boolean(
    industry
    && industry.marketStrength >= 65
    && industry.breadth >= 50
    && (
      industry.textHeat >= 70
      || industry.relation === "交易驱动"
      || industry.relation === "舆情交易双热"
    ),
  );
}

function leadershipBonusOf(input: DailyCandidateInput): number {
  const leadership = input.leadership;
  if (!leadership) return 0;
  if (leadership.tier === "market") return 3;
  if (leadership.tier === "industry") return 2;
  if (leadership.boardCount >= 2 || (leadership.dragonTiger?.netAmount ?? 0) > 0) return 1;
  return 0;
}

function repeatPenaltyOf(
  input: DailyCandidateInput,
  primaryEvent: DailyCandidateEventFeature | null,
  continuationBonus: number,
): number {
  const days = Math.max(0, Math.round(input.focusDaysLast5 ?? 0));
  const consecutive = Math.max(0, Math.round(input.consecutiveFocusDays ?? 0));
  let penalty = days <= 0 ? 0 : days === 1 ? 1 : days === 2 ? 3 : days === 3 ? 5 : 6;
  if (consecutive >= 3) penalty += 1;
  if (
    primaryEvent
    && primaryEvent.novelty >= 80
    && primaryEvent.importance >= 75
  ) return 0;
  penalty -= Math.min(2, continuationBonus);
  return clamp(Math.round(penalty), 0, DAILY_FOCUS_REPEAT_MAX);
}

function scoreCandidate(input: DailyCandidateInput, refs: References): DailyCandidateScored {
  const audit = auditInput(input);
  const trend = amountTrend(input.amountHistory);
  const growth = calculateDiscussionGrowth(
    input.discussionCount,
    input.discussionInteractions,
    input.discussionElapsedMinutes,
    input.discussionHistory,
  );
  const amountMedian = Math.max(1, median(input.amountHistory));
  const amountRatio = input.amount / amountMedian;
  const closePosition = input.high === input.low
    ? 0.5
    : clamp((input.close - input.low) / (input.high - input.low), 0, 1);

  const amountPercentile = winsorizedPercentile(input.amount, refs.amount);
  const slopePercentile = winsorizedPercentile(trend.slope, refs.slope);
  const pctPercentile = winsorizedPercentile(input.pctChange, refs.pctChange);
  const excessPercentile = winsorizedPercentile(input.marketExcess, refs.marketExcess);
  const discussionPercentile = winsorizedPercentile(input.discussionCount, refs.discussionCount);
  const interactionPercentile = winsorizedPercentile(
    input.discussionInteractions,
    refs.discussionInteractions,
  );
  const growthPercentile = growth.isComparable
    ? winsorizedPercentile(growth.value, refs.discussionGrowth)
    : 0;

  const turnoverHeat = clamp(
    amountPercentile * 0.35
    + slopePercentile * 0.25
    + score100(amountRatio, 0.9, 2.5) * 0.20
    + score100(trend.increases, 0, 4) * 0.20,
  );
  const priceHeat = clamp(
    pctPercentile * 0.45
    + excessPercentile * 0.35
    + closePosition * 100 * 0.20,
  );
  const absoluteDiscussion = discussionPercentile * 0.60 + interactionPercentile * 0.40;

  const currentEventCount = input.eventClusters?.length ?? 0;
  const eventBaseline = input.historicalEventCountMedian ?? null;
  const eventAcceleration = eventBaseline === null
    ? 0
    : clamp(
        50
        + (
          Math.log1p(currentEventCount)
          - Math.log1p(Math.max(0, eventBaseline))
        ) * 40,
      );
  const attentionAcceleration = growth.isComparable
    ? round(growthPercentile * 0.60 + eventAcceleration * 0.40)
    : currentEventCount
      ? round(eventAcceleration || 50)
      : null;
  const attentionScore = attentionAcceleration ?? absoluteDiscussion;

  const industryScore = input.industry
    ? clamp(
        input.industry.marketStrength * 0.40
        + input.industry.breadth * 0.25
        + input.industry.textHeat * 0.20
        + input.industry.textDirection * 0.15,
      )
    : 0;

  const eventClusters = [...(input.eventClusters ?? [])].sort(
    (left, right) =>
      right.importance - left.importance
      || right.novelty - left.novelty
      || right.independentSourceCount - left.independentSourceCount
      || left.clusterId.localeCompare(right.clusterId),
  );
  const primaryEvent = eventClusters[0] ?? null;
  const currentClusterId = primaryEvent?.clusterId ?? null;
  const focusReasonChanged = (input.lastPrimaryEventClusterId ?? null) !== currentClusterId;
  const eventNovelty = primaryEvent?.novelty ?? 0;
  const catalystPersistence = primaryEvent?.persistence ?? (trend.base ? 65 : 35);

  const sentimentDelta = finite(input.sentimentDelta)
    ? input.sentimentDelta
    : finite(input.historicalTextDirectionMedian)
      ? input.textDirection - input.historicalTextDirectionMedian
      : null;
  const sentimentShift = sentimentDelta === null
    ? score100(input.textDirection, 50, 80)
    : score100(sentimentDelta, 0, 25);

  const reliability = primaryEvent
    ? clamp(
        Math.min(100, primaryEvent.authorityCount * 45)
        + Math.min(35, Math.max(0, primaryEvent.independentSourceCount - 1) * 18)
        + primaryEvent.confidence * 0.20,
      )
    : clamp(
        (input.hasNonForumCorroboration ? 55 : 0)
        + Math.min(30, input.sourceCount * 10)
        + Math.min(15, input.independentEvents * 5),
      );

  const marketConfirmation = clamp(
    50
    + input.pctChange * 6
    + input.marketExcess * 7
    + (closePosition - 0.5) * 30,
  );
  const turnoverConfirmation = clamp(
    turnoverHeat * 0.65
    + score100(amountRatio, 0.9, 1.8) * 0.35,
  );

  const eventScore = primaryEvent
    ? clamp(
        primaryEvent.importance * 0.20
        + primaryEvent.novelty * 0.15
        + primaryEvent.persistence * 0.15
        + sentimentShift * 0.10
        + industryScore * 0.10
        + marketConfirmation * 0.10
        + turnoverConfirmation * 0.10
        + reliability * 0.10,
      )
    : 0;

  const trendPersistence = trend.gradeA ? 90 : trend.base ? 72 : 35;
  const trendReliability = clamp(
    (input.hasNonForumCorroboration ? 45 : 0)
    + Math.min(30, input.sourceCount * 10)
    + Math.min(25, input.independentEvents * 5),
  );
  const trendScore = clamp(
    turnoverHeat * 0.25
    + priceHeat * 0.25
    + industryScore * 0.15
    + trendPersistence * 0.10
    + attentionScore * 0.10
    + score100(input.textDirection, 45, 80) * 0.10
    + trendReliability * 0.05,
  );

  const eventEligible = Boolean(
    primaryEvent
    && primaryEvent.importance >= 60
    && primaryEvent.novelty >= 55
    && primaryEvent.direction >= 55
    && (primaryEvent.authorityCount >= 1 || primaryEvent.independentSourceCount >= 2)
    && (
      input.pctChange >= -2
      || (closePosition >= 0.5 && input.marketExcess >= -1)
    ),
  );
  const trendEligible = trend.base
    && input.pctChange > 0
    && input.marketExcess > 0
    && turnoverHeat >= 50
    && priceHeat >= 50;
  const lane: DailyFocusLane = eventEligible && trendEligible
    ? "dual"
    : eventEligible
      ? "event"
      : trendEligible
        ? "trend"
        : null;

  const researchScore2W = round(Math.max(
    eventEligible ? eventScore : 0,
    trendEligible ? trendScore : 0,
  ));

  const leadershipHeat = input.leadership?.tier === "market"
    ? 100
    : input.leadership?.tier === "industry"
      ? 82
      : (input.leadership?.boardCount ?? 0) >= 2
        ? 65
        : (input.leadership?.boardCount ?? 0) === 1
          ? 50
          : 0;
  const newsExposure = primaryEvent
    ? clamp(
        primaryEvent.authorityCount * 40
        + Math.min(60, primaryEvent.evidenceCount * 15),
      )
    : 0;
  const hotScore = round(clamp(
    priceHeat * 0.25
    + turnoverHeat * 0.20
    + absoluteDiscussion * 0.15
    + attentionScore * 0.15
    + industryScore * 0.10
    + leadershipHeat * 0.10
    + newsExposure * 0.05,
  ));

  const hasHotEvidence = currentEventCount > 0
    || input.discussionCount > 0
    || hotIndustry(input.industry)
    || (input.leadership?.boardCount ?? 0) > 0
    || input.leadership?.dragonTiger != null;
  const hotEligible = hotScore >= 80 && hasHotEvidence;

  const continuationBonus = clamp(
    (trendEligible ? 1 : 0)
    + (trend.gradeA ? 1 : 0)
    + ((input.industry?.marketStrength ?? 0) >= 70 ? 1 : 0)
    + (growth.isComparable && growth.value > 0 ? 1 : 0),
    0,
    4,
  );
  const leadershipBonus = leadershipBonusOf(input);
  const repeatPenalty = repeatPenaltyOf(input, primaryEvent, continuationBonus);

  const topThreeDayReturn = refs.threeDayReturn.length >= 100
    && finite(input.threeDayReturn)
    && isAtOrAboveEmpiricalQuantile(input.threeDayReturn, refs.threeDayReturn, 0.99);
  const topDiscussionGrowth = refs.discussionGrowth.length >= 100
    && growth.isComparable
    && isAtOrAboveEmpiricalQuantile(growth.value, refs.discussionGrowth, 0.99);
  const overheatPenalty = Math.min(
    DAILY_FOCUS_OVERHEAT_MAX,
    (input.reopenedLimit ? 3 : 0)
    + (topThreeDayReturn && amountRatio >= 2.5 ? 4 : 0)
    + (
      topDiscussionGrowth
      && (input.sourceCount <= 1 || (input.duplicateRatio ?? 0) >= 0.4)
        ? 3
        : 0
    ),
  );

  const baseScore = round(
    researchScore2W * DAILY_FOCUS_RESEARCH_WEIGHT
    + hotScore * DAILY_FOCUS_HOT_WEIGHT,
  );
  const finalScore = round(clamp(
    baseScore
    + continuationBonus
    + leadershipBonus
    - overheatPenalty
    - repeatPenalty,
  ));
  const researchQualified = lane !== null && researchScore2W >= 58;
  // A：核心聚焦（研究分 72 + 最终分 70 + 可靠性下限）。
  // B：观察聚焦 —— 研究分达标，或者「热度分 ≥ 80 且有可解释证据」。
  // 设计 §22 对热点分支没有最终分下限：纯热点股的研究分为 0，若再要求最终分就会永远选不进来；
  // 热点数量由选取阶段的「热点位最多 2」控制，而不是靠分数下限。
  const grade: "A" | "B" | null =
    researchQualified && researchScore2W >= 72 && finalScore >= 70 && reliability >= 40
      ? "A"
      : (researchQualified && finalScore >= 55) || hotEligible
        ? "B"
        : null;
  const focusType: DailyFocusType =
    researchScore2W >= 72 && hotScore >= 80
      ? "research-hot"
      : researchQualified
        ? "research"
        : "hot";

  const scores: DailyCandidateScores = {
    turnover: round(turnoverHeat * 0.30),
    direction: round(score100(input.textDirection, 45, 85) * 0.18),
    discussion: round(attentionScore * 0.18),
    price: round(priceHeat * 0.18),
    industry: round(industryScore * 0.12),
    reliability: round(reliability * 0.04),
  };

  return {
    code: input.code,
    board: marketBoardOf(input.code),
    inputAudit: audit,
    scores,
    trend,
    baseScore,
    overheatPenalty,
    leadershipBonus,
    repeatPenalty,
    continuationBonus,
    finalScore,
    grade,
    isHotIndustry: hotIndustry(input.industry),
    industry: audit.industry ?? null,
    discussionGrowth: growth,
    discussionGrowthScore: growth.isComparable ? round(growthPercentile * 0.18) : 0,
    leadershipTier: input.leadership?.tier ?? "none",
    lane,
    focusType,
    researchScore2W,
    hotScore,
    eventScore: round(eventScore),
    trendScore: round(trendScore),
    eventEligible,
    trendEligible,
    hotEligible,
    catalystPersistence,
    eventNovelty,
    sentimentDelta,
    attentionAcceleration,
    primaryEvent,
    focusReasonChanged,
  };
}

function compare(left: DailyCandidateScored, right: DailyCandidateScored) {
  return right.finalScore - left.finalScore
    || right.researchScore2W - left.researchScore2W
    || right.hotScore - left.hotScore
    || right.continuationBonus - left.continuationBonus
    || left.code.localeCompare(right.code);
}

function selectDiversified(candidates: DailyCandidateScored[]): {
  items: DailyCandidateScored[];
  diagnostics: V7SelectionDiagnostics;
} {
  const selected: DailyCandidateScored[] = [];
  const codes = new Set<string>();
  const industries = new Map<string, number>();
  const events = new Map<string, number>();
  let relaxedIndustryLimit = false;

  const add = (item: DailyCandidateScored, industryLimit: number) => {
    if (codes.has(item.code) || selected.length >= DAILY_FOCUS_MAX_ITEMS) return false;
    const industry = item.industry?.name ?? "__missing__";
    const event = item.primaryEvent?.clusterId ?? null;
    if ((industries.get(industry) ?? 0) >= industryLimit) return false;
    if (event && (events.get(event) ?? 0) >= 2) return false;
    selected.push(item);
    codes.add(item.code);
    industries.set(industry, (industries.get(industry) ?? 0) + 1);
    if (event) events.set(event, (events.get(event) ?? 0) + 1);
    return true;
  };

  const ordered = [...candidates].sort(compare);
  // 研究型 = 走事件/趋势通道的（research / research-hot）；热点型 = 只靠当前热度进来的。
  const research = ordered.filter((item) => item.focusType !== "hot");
  const hot = ordered.filter((item) => item.focusType === "hot" && item.hotEligible);

  let researchSelected = 0;
  for (const item of research) {
    if (researchSelected >= DAILY_FOCUS_RESEARCH_SEATS) break;
    if (add(item, 2)) researchSelected += 1;
  }

  let hotSelected = 0;
  for (const item of hot) {
    if (hotSelected >= DAILY_FOCUS_HOT_SEATS) break;
    if (add(item, 2)) hotSelected += 1;
  }

  // 弹性位与行业放宽都只补研究型：热点位固定 2 个，不会因为候选不足被放大成整榜热点。
  for (const item of research) {
    if (selected.length >= DAILY_FOCUS_MAX_ITEMS) break;
    add(item, 2);
  }
  const researchCeiling = Math.min(
    DAILY_FOCUS_MAX_ITEMS,
    research.length + Math.min(DAILY_FOCUS_HOT_SEATS, hot.length),
  );
  if (selected.length < researchCeiling) {
    for (const item of research) {
      if (selected.length >= DAILY_FOCUS_MAX_ITEMS) break;
      if (add(item, 3)) relaxedIndustryLimit = true;
    }
  }

  const reasons = [
    "V7 以两周研究价值为主、当前热度为辅",
    `研究位优先（最多 ${DAILY_FOCUS_RESEARCH_SEATS}），热点位固定（最多 ${DAILY_FOCUS_HOT_SEATS}）`,
    "同一事件最多 2 只，同一行业默认最多 2 只",
    ...(relaxedIndustryLimit ? ["候选不足时行业上限放宽到 3"] : []),
  ];
  return {
    items: selected.sort(compare),
    diagnostics: deepFreeze({
      initialTarget: Math.min(DAILY_FOCUS_MAX_ITEMS, candidates.length),
      selectedCount: selected.length,
      researchSelected: selected.filter((item) => item.focusType !== "hot").length,
      hotSelected: selected.filter((item) => item.focusType === "hot").length,
      industryLimit: relaxedIndustryLimit ? 3 : 2,
      eventLimit: 2,
      relaxedIndustryLimit,
      reasons,
    }),
  };
}

export function selectDailyCandidates(source: unknown): DailyCandidateResult {
  const inputs = Array.isArray(source) ? source : [source];
  const invalid = inputs.filter((input) => !validInput(input)).length;
  const valid = inputs.filter(validInput);
  const exclusionCounts: Record<string, number> = {};
  if (invalid) exclusionCounts.invalidInput = invalid;

  const seen = new Set<string>();
  const eligible: DailyCandidateInput[] = [];
  for (const input of valid) {
    const reason =
      seen.has(input.code) ? "invalidInput"
      : input.exchange !== "SH" && input.exchange !== "SZ" ? "exchange"
      : riskName(input.name) ? "risk"
      : input.listingTradingDays < 30 ? "listing"
      : input.isSuspended === true || input.amount <= 0 ? "invalidQuote"
      : input.onePriceLimit ? "onePriceLimit"
      : input.shareReduction
        ? input.shareReduction.level === "major" ? "majorShareReduction" : "shareReduction"
      : input.amount < DAILY_FOCUS_MIN_AMOUNT ? "amount"
      : null;
    seen.add(input.code);
    if (reason) exclusionCounts[reason] = (exclusionCounts[reason] ?? 0) + 1;
    else eligible.push(input);
  }

  const market = valid.filter(
    (input) =>
      (input.exchange === "SH" || input.exchange === "SZ")
      && input.listingTradingDays >= 30
      && !riskName(input.name)
      && input.amount > 0,
  );
  const growthValues = market
    .map((input) => calculateDiscussionGrowth(
      input.discussionCount,
      input.discussionInteractions,
      input.discussionElapsedMinutes,
      input.discussionHistory,
    ))
    .filter((item) => item.isComparable)
    .map((item) => item.value);
  const refs: References = {
    amount: market.map((item) => item.amount),
    pctChange: market.map((item) => item.pctChange),
    marketExcess: market.map((item) => item.marketExcess),
    discussionCount: market.map((item) => item.discussionCount),
    discussionInteractions: market.map((item) => item.discussionInteractions),
    discussionGrowth: growthValues,
    slope: market.map((item) => amountTrend(item.amountHistory).slope),
    threeDayReturn: market.flatMap((item) =>
      finite(item.threeDayReturn) ? [item.threeDayReturn] : []),
    boardCount: market.flatMap((item) =>
      (item.leadership?.boardCount ?? 0) > 0 ? [item.leadership!.boardCount] : []),
  };
  const scored = eligible.map((input) => scoreCandidate(input, refs)).sort(compare);
  const qualified = scored.filter((item) => item.grade !== null);
  const selection = selectDiversified(qualified);
  const leadershipDiagnostics: LeadershipDiagnostics = {
    covered: eligible.some((input) => input.leadership != null),
    limitUpCandidates: eligible.filter((input) => (input.leadership?.boardCount ?? 0) >= 1).length,
    marketLeaders: scored.filter((item) => item.leadershipTier === "market").map((item) => item.code),
    industryLeaders: scored.filter((item) => item.leadershipTier === "industry").map((item) => item.code),
  };

  return {
    methodologyVersion: DAILY_FOCUS_VERSION,
    status: selection.items.length ? "available" : "unavailable",
    items: selection.items,
    scored,
    exclusionCounts,
    referenceAudit: referenceAudit(refs),
    selectionDiagnostics: selection.diagnostics,
    leadershipDiagnostics,
  };
}
