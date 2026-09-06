/** Pure, deterministic market-first selection policy (1–10 candidates + T+1 validation). */
export const DAILY_FOCUS_VERSION = "daily-focus-v3";
export const DAILY_FOCUS_WEIGHTS = { turnover: 30, direction: 18, discussion: 18, price: 18, industry: 12, reliability: 4 } as const;
export const DAILY_FOCUS_MIN_AMOUNT = 100_000_000;
export type DailyIndustryRelation = "舆情交易双热" | "舆情升温、价格未确认" | "交易驱动" | "常态行业";
export type AnalysisStatus = "scored" | "unscored" | "failed";
export interface DailyCandidateIndustry { name: string; textHeat: number; textDirection: number; marketStrength: number; breadth: number; relation: DailyIndustryRelation; }
export interface DiscussionWindow { count: number; interactions: number; elapsedMinutes: number; /** Only explicit true admits a window to the comparable baseline. */ verified?: boolean; }
export interface DailyCandidateInput {
  code: string; name: string; exchange: string; listingTradingDays: number; tradeDate: string;
  open: number; high: number; low: number; close: number; previousClose: number; pctChange: number; amount: number; amountHistory: number[]; marketExcess: number;
  analysisStatus: AnalysisStatus; textDirection: number; directionConsensus: number; textConfidence: number; freshness: number;
  discussionCount: number; userDiscussionCount: number; discussionInteractions: number; discussionElapsedMinutes: number; discussionHistory?: DiscussionWindow[];
  independentEvents: number; sourceCount: number; hasNonForumCorroboration: boolean; industry?: DailyCandidateIndustry | null;
  isSuspended?: boolean; onePriceLimit?: boolean; reopenedLimit?: boolean; threeDayReturn?: number; duplicateRatio?: number;
  /** Ignored legacy caller data; strategy derives these values itself. */
  threeDayReturnPercentile?: number; amountToMedianRatio?: number; discussionGrowthPercentile?: number;
}
export interface DailyCandidateScores { turnover: number; direction: number; discussion: number; price: number; industry: number; reliability: number; }
export interface AmountTrend { base: boolean; gradeA: boolean; gradeB: boolean; slope: number; increases: number; ratio: number; }
export interface DiscussionGrowth { value: number; mentionDelta: number; countMedian: number; interactionsMedian: number; isComparable: boolean; }
export interface ReferenceMetric { sampleSize: number; p5: number; p95: number; p99: number | null; }
export interface ReferenceAudit { market: { amount: ReferenceMetric; pctChange: ReferenceMetric; marketExcess: ReferenceMetric; threeDayReturn: ReferenceMetric }; text: { discussionCount: ReferenceMetric; discussionInteractions: ReferenceMetric; discussionGrowth: ReferenceMetric }; trend: { slope: ReferenceMetric }; }
export interface SelectionDiagnostics { initialTarget: number; requiredHot: number; relaxedIndustryConstraints: boolean; constraintTruncated: boolean; reasons: string[]; }
export interface DailyCandidateScored { code: string; inputAudit: Readonly<DailyCandidateInput>; scores: DailyCandidateScores; trend: AmountTrend; baseScore: number; overheatPenalty: number; finalScore: number; grade: "A" | "B" | null; isHotIndustry: boolean; industry: DailyCandidateIndustry | null; discussionGrowth: DiscussionGrowth; discussionGrowthScore: number; }
export interface DailyCandidateResult { methodologyVersion: typeof DAILY_FOCUS_VERSION; status: "available" | "unavailable"; items: DailyCandidateScored[]; scored: DailyCandidateScored[]; exclusionCounts: Record<string, number>; referenceAudit: ReferenceAudit; selectionDiagnostics: SelectionDiagnostics; }
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
interface PreparedMetric extends ReferenceMetric { ordered: number[]; }
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
function validInput(input: unknown): input is DailyCandidateInput {
  if (!record(input) || !Array.isArray(input.amountHistory) || (input.discussionHistory !== undefined && (!Array.isArray(input.discussionHistory) || !input.discussionHistory.every(record)))) return false;
  const candidate = input as unknown as DailyCandidateInput;
  const signals = [candidate.textDirection, candidate.directionConsensus, candidate.textConfidence, candidate.freshness];
  const optionalBooleans = [candidate.isSuspended, candidate.onePriceLimit, candidate.reopenedLimit];
  return typeof candidate.code === "string" && candidate.code.length > 0 && typeof candidate.name === "string" && typeof candidate.tradeDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(candidate.tradeDate) && typeof candidate.exchange === "string" && integer(candidate.listingTradingDays) &&
    [candidate.open, candidate.high, candidate.low, candidate.close, candidate.previousClose, candidate.amount, candidate.pctChange, candidate.marketExcess].every(finite) && candidate.amount >= 0 && candidate.open > 0 && candidate.high > 0 && candidate.low > 0 && candidate.close > 0 && candidate.previousClose > 0 && candidate.high >= candidate.low && candidate.open >= candidate.low && candidate.open <= candidate.high && candidate.close >= candidate.low && candidate.close <= candidate.high &&
    candidate.amountHistory.length === 5 && candidate.amountHistory.every((value) => finite(value) && value >= 0) && signals.every((value) => finite(value) && value >= 0 && value <= 100) && integer(candidate.discussionCount) && integer(candidate.userDiscussionCount) && integer(candidate.discussionInteractions) && integer(candidate.independentEvents) && integer(candidate.sourceCount) && positive(candidate.discussionElapsedMinutes) && (candidate.duplicateRatio === undefined || finite(candidate.duplicateRatio) && candidate.duplicateRatio >= 0 && candidate.duplicateRatio <= 1) && (candidate.threeDayReturn === undefined || finite(candidate.threeDayReturn)) && typeof candidate.hasNonForumCorroboration === "boolean" && optionalBooleans.every((value) => value === undefined || typeof value === "boolean") && statuses.has(candidate.analysisStatus) && validIndustry(candidate.industry);
}
const risk = (name: string) => /(?:^|\s)\*?ST(?=\s|[^A-Za-z0-9]|$)|退市/i.test(name);
const invalidQuote = (input: DailyCandidateInput) => input.isSuspended === true || input.amount <= 0;
const marketClean = (input: DailyCandidateInput) => (input.exchange === "SH" || input.exchange === "SZ") && input.listingTradingDays >= 30 && !risk(input.name) && !invalidQuote(input);
const hot = (industry: DailyCandidateIndustry | null | undefined) => Boolean(industry
  && industry.marketStrength >= 65
  && industry.breadth >= 50
  && (industry.textHeat >= 70 || industry.relation === "交易驱动" || industry.relation === "舆情交易双热"));
function deepFreeze<T>(value: T): Readonly<T> { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value as Record<string, unknown>).forEach((child) => deepFreeze(child)); Object.freeze(value); } return value as Readonly<T>; }
const auditInput = (input: DailyCandidateInput): Readonly<DailyCandidateInput> => deepFreeze({ ...input, amountHistory: [...input.amountHistory], discussionHistory: input.discussionHistory?.map((item) => ({ ...item })), industry: input.industry ? { ...input.industry } : input.industry });

interface PreparedReferences { market: { amount: PreparedMetric; pctChange: PreparedMetric; marketExcess: PreparedMetric; threeDayReturn: PreparedMetric }; text: { discussionCount: PreparedMetric; discussionInteractions: PreparedMetric; discussionGrowth: PreparedMetric }; trend: { slope: PreparedMetric }; audit: ReferenceAudit; }
function prepare(market: DailyCandidateInput[], text: DailyCandidateInput[], trend: DailyCandidateInput[]): PreparedReferences {
  const growths = text.map((item) => calculateDiscussionGrowth(item.discussionCount, item.discussionInteractions, item.discussionElapsedMinutes, item.discussionHistory)).filter((item) => item.isComparable).map((item) => item.value);
  const refs = { market: { amount: metric(market.map((item) => item.amount)), pctChange: metric(market.map((item) => item.pctChange)), marketExcess: metric(market.map((item) => item.marketExcess)), threeDayReturn: metric(market.flatMap((item) => item.threeDayReturn === undefined ? [] : [item.threeDayReturn])) }, text: { discussionCount: metric(text.map((item) => item.discussionCount)), discussionInteractions: metric(text.map((item) => item.discussionInteractions)), discussionGrowth: metric(growths) }, trend: { slope: metric(trend.map((item) => amountTrend(item.amountHistory).slope)) } };
  return { ...refs, audit: deepFreeze({ market: { amount: auditMetric(refs.market.amount), pctChange: auditMetric(refs.market.pctChange), marketExcess: auditMetric(refs.market.marketExcess), threeDayReturn: auditMetric(refs.market.threeDayReturn) }, text: { discussionCount: auditMetric(refs.text.discussionCount), discussionInteractions: auditMetric(refs.text.discussionInteractions), discussionGrowth: auditMetric(refs.text.discussionGrowth) }, trend: { slope: auditMetric(refs.trend.slope) } }) as ReferenceAudit };
}

interface InternalScored extends DailyCandidateScored { raw: DailyCandidateInput; }
function score(input: DailyCandidateInput, refs: PreparedReferences): InternalScored {
  const inputAudit = auditInput(input); const trend = amountTrend(input.amountHistory); const growth = calculateDiscussionGrowth(input.discussionCount, input.discussionInteractions, input.discussionElapsedMinutes, input.discussionHistory); const amountRatio = input.amount / median(input.amountHistory); const position = input.high === input.low ? .5 : clamp((input.close - input.low) / (input.high - input.low), 0, 1); const relation = input.industry?.relation; const relationValue = relation === "舆情交易双热" ? 100 : relation === "舆情升温、价格未确认" ? 60 : relation === "交易驱动" ? 35 : 0;
  const growthScore = growth.isComparable ? points(metricScore(growth.value, refs.text.discussionGrowth), 0, 100, 9) : 0;
  const scores: DailyCandidateScores = { turnover: points(metricScore(trend.slope, refs.trend.slope), 0, 100, 8) + points(trend.increases, 0, 4, 6) + points(trend.ratio, 1, 1.5, 5) + points(metricScore(input.amount, refs.market.amount), 0, 100, 6) + points(amountRatio, ...DAILY_FOCUS_BOUNDS.amountRatio, 5), direction: points(input.textDirection, ...DAILY_FOCUS_BOUNDS.directionStrength, 9) + points(input.directionConsensus, 0, 100, 4) + points(input.textConfidence, 0, 100, 3) + points(input.freshness, 0, 100, 2), discussion: points(metricScore(input.discussionCount, refs.text.discussionCount), 0, 100, 5) + points(metricScore(input.discussionInteractions, refs.text.discussionInteractions), 0, 100, 4) + growthScore, price: points(metricScore(input.pctChange, refs.market.pctChange), 0, 100, 8) + points(metricScore(input.marketExcess, refs.market.marketExcess), 0, 100, 6) + points(position, 0, 1, 4), industry: input.industry ? points(input.industry.textHeat, 0, 100, 3) + points(input.industry.textDirection, 0, 100, 2) + points(input.industry.marketStrength, 0, 100, 3) + points(input.industry.breadth, 0, 100, 2) + points(relationValue, 0, 100, 2) : 0, reliability: points(input.independentEvents, ...DAILY_FOCUS_BOUNDS.independentEvents, 1) + points(input.sourceCount, ...DAILY_FOCUS_BOUNDS.sourceCount, 1) + (input.hasNonForumCorroboration ? 2 : 0) };
  const penalty = overheatPenalty(input, amountRatio, input.threeDayReturn !== undefined && topOnePercent(input.threeDayReturn, refs.market.threeDayReturn), growth.isComparable && topOnePercent(growth.value, refs.text.discussionGrowth)); const baseScore = Object.values(scores).reduce((sum, value) => sum + value, 0); const finalScore = Math.round(clamp(baseScore - penalty));
  const grade = gradeCandidate({ scores, trend, finalScore, textDirection: input.textDirection });
  return { raw: input, code: input.code, inputAudit, scores, trend, baseScore, overheatPenalty: penalty, finalScore, grade, isHotIndustry: hot(input.industry), industry: inputAudit.industry ?? null, discussionGrowth: growth, discussionGrowthScore: growthScore };
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
const compare = (left: DailyCandidateScored, right: DailyCandidateScored) => right.finalScore - left.finalScore || right.scores.turnover - left.scores.turnover || right.discussionGrowthScore - left.discussionGrowthScore || right.scores.industry - left.scores.industry || (left.code < right.code ? -1 : left.code > right.code ? 1 : 0);
function selectWithIndustry<T extends DailyCandidateScored>(candidates: T[], target: number): { items: T[]; diagnostics: SelectionDiagnostics } {
  const selected: T[] = [];
  const selectedCodes = new Set<string>();
  const counts = new Map<string, number>();
  const requiredHot = Math.min(target, Math.ceil(target * .7));
  let relaxed = false;
  const add = (item: T, strict: boolean) => {
    if (selectedCodes.has(item.code) || selected.length >= target) return false;
    const key = item.industry?.name ?? "__missing__";
    if (strict && (counts.get(key) ?? 0) >= 3) return false;
    selected.push(item);
    selectedCodes.add(item.code);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return true;
  };
  const sortedCandidates = [...candidates].sort(compare);
  for (const item of sortedCandidates.filter((item) => item.isHotIndustry)) {
    if (selected.length >= requiredHot) break;
    add(item, true);
  }
  for (const item of sortedCandidates) add(item, true);
  // Industry concentration is a preference. If qualified supply is concentrated,
  // relax the cap so the page still freezes every available slot up to ten.
  if (selected.length < target) {
    relaxed = true;
    for (const item of sortedCandidates) add(item, false);
  }
  const truncated = selected.length < target;
  return {
    items: selected.sort(compare),
    diagnostics: deepFreeze({
      initialTarget: target,
      requiredHot,
      relaxedIndustryConstraints: relaxed,
      constraintTruncated: truncated,
      reasons: truncated ? ["qualified candidates exhausted"] : [],
    }) as SelectionDiagnostics,
  };
}
export function selectDailyCandidates(source: unknown): DailyCandidateResult {
  if (!Array.isArray(source)) { const refs = prepare([], [], []); const selection = selectWithIndustry([], 0); return { methodologyVersion: DAILY_FOCUS_VERSION, status: "unavailable", items: [], scored: [], exclusionCounts: { invalidInput: 1 }, referenceAudit: refs.audit, selectionDiagnostics: selection.diagnostics }; }
  const inputs: unknown[] = source; const exclusionCounts: Record<string, number> = {}; const invalid = new Set<number>(); inputs.forEach((input, index) => { if (!validInput(input)) invalid.add(index); }); const dates = new Map<string, number>(); inputs.forEach((input, index) => { if (!invalid.has(index)) dates.set((input as DailyCandidateInput).tradeDate, (dates.get((input as DailyCandidateInput).tradeDate) ?? 0) + 1); }); const canonicalDate = [...dates.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]; inputs.forEach((input, index) => { if (!invalid.has(index) && (input as DailyCandidateInput).tradeDate !== canonicalDate) invalid.add(index); }); const codes = new Map<string, number[]>(); inputs.forEach((input, index) => { if (!invalid.has(index)) { const candidate = input as DailyCandidateInput; codes.set(candidate.code, [...(codes.get(candidate.code) ?? []), index]); } }); codes.forEach((indexes) => { if (indexes.length > 1) indexes.forEach((index) => invalid.add(index)); }); if (invalid.size) exclusionCounts.invalidInput = invalid.size;
  const eligible: DailyCandidateInput[] = []; inputs.forEach((unknownInput, index) => { if (invalid.has(index)) return; const input = unknownInput as DailyCandidateInput; const reason = input.exchange !== "SH" && input.exchange !== "SZ" ? "exchange" : risk(input.name) ? "risk" : input.listingTradingDays < 30 ? "listing" : invalidQuote(input) ? "invalidQuote" : input.onePriceLimit ? "onePriceLimit" : input.amount < DAILY_FOCUS_MIN_AMOUNT ? "amount" : !amountTrend(input.amountHistory).base ? "amountTrend" : input.pctChange <= 0 || input.marketExcess <= 0 ? "positiveReturn" : null; if (reason) exclusionCounts[reason] = (exclusionCounts[reason] ?? 0) + 1; else eligible.push(input); });
  const market = inputs.flatMap((input, index) => !invalid.has(index) && marketClean(input as DailyCandidateInput) ? [input as DailyCandidateInput] : []); const text = market.filter((input) => input.analysisStatus === "scored"); const trend = market.filter((input) => input.amountHistory.every(positive)); const refs = prepare(market, text, trend); const scored = eligible.map((input) => score(input, refs)).sort(compare); const qualified = scored.filter((item) => item.grade !== null); const target = Math.min(10, qualified.length); const selection = selectWithIndustry(qualified, target); const internalItems = selection.items; const expose = ({ raw: _raw, ...item }: InternalScored): DailyCandidateScored => item;
  return { methodologyVersion: DAILY_FOCUS_VERSION, status: internalItems.length ? "available" : "unavailable", items: internalItems.map(expose), scored: scored.map(expose), exclusionCounts, referenceAudit: refs.audit, selectionDiagnostics: selection.diagnostics };
}
