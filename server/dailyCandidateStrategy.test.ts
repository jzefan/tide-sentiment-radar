import assert from "node:assert/strict";
import test from "node:test";
import {
  DAILY_FOCUS_WEIGHTS,
  amountTrend,
  overheatPenalty,
  isAtOrAboveEmpiricalQuantile,
  calculateDiscussionGrowth,
  selectDailyCandidates,
  winsorizedPercentile,
  type DailyCandidateInput,
} from "./dailyCandidateStrategy.ts";

const base = (overrides: Partial<DailyCandidateInput> = {}): DailyCandidateInput => ({
  code: "600001", name: "示例科技", exchange: "SH", listingTradingDays: 120,
  tradeDate: "2026-08-25", open: 10, high: 11, low: 9.8, close: 10.9,
  previousClose: 10, pctChange: 9, amount: 500_000_000,
  amountHistory: [100_000_000, 120_000_000, 145_000_000, 180_000_000, 500_000_000],
  marketExcess: 4, analysisStatus: "scored", textDirection: 68, directionConsensus: 80,
  textConfidence: 85, freshness: 90, discussionCount: 30, userDiscussionCount: 15, discussionElapsedMinutes: 240,
  discussionInteractions: 200, discussionHistory: [
    { count: 4, interactions: 20, elapsedMinutes: 240, verified: true }, { count: 5, interactions: 30, elapsedMinutes: 240, verified: true }, { count: 5, interactions: 25, elapsedMinutes: 240, verified: true },
    { count: 6, interactions: 35, elapsedMinutes: 240, verified: true }, { count: 7, interactions: 40, elapsedMinutes: 240, verified: true },
  ], independentEvents: 5, sourceCount: 3, hasNonForumCorroboration: true,
  industry: { name: "半导体", textHeat: 82, textDirection: 58, marketStrength: 72, breadth: 76, relation: "舆情交易双热" },
  onePriceLimit: false, reopenedLimit: false, threeDayReturnPercentile: 70,
  amountToMedianRatio: 2.4, discussionGrowthPercentile: 70, duplicateRatio: 0,
  ...overrides,
});

const selected = (...inputs: DailyCandidateInput[]) => selectDailyCandidates(inputs);

test("excludes BJ, ST, newly listed, suspended, and one-price-limit stocks", () => {
  const variants = [
    base({ code: "830001", exchange: "BJ" }), base({ code: "600002", name: "ST 示例" }),
    base({ code: "600003", listingTradingDays: 29 }), base({ code: "600004", isSuspended: true }),
    base({ code: "600005", onePriceLimit: true }),
  ];
  const result = selected(...variants, base({ code: "600006" }), base({ code: "600007" }), base({ code: "600008" }));
  assert.deepEqual(result.items.map((item) => item.code), ["600006", "600007", "600008"]);
  assert.equal(result.exclusionCounts.exchange, 1);
  assert.equal(result.exclusionCounts.risk, 1);
  assert.equal(result.exclusionCounts.listing, 1);
  assert.equal(result.exclusionCounts.invalidQuote, 1);
  assert.equal(result.exclusionCounts.onePriceLimit, 1);
});

test("keeps market floors hard while treating text and discussion as score inputs", () => {
  const rejected = [
    base({ code: "600009", amount: 99_999_999 }),
    base({ code: "600010", amountHistory: [100e6, 120e6, 0, 180e6, 500e6] }),
    base({ code: "600014", pctChange: 0 }),
    base({ code: "600015", marketExcess: 0 }),
    base({ code: "600016", analysisStatus: "unscored" }),
    base({ code: "600017", textDirection: 54.99 }),
    base({ code: "600018", independentEvents: 1 }),
    base({ code: "600019", userDiscussionCount: 0 }),
  ];
  const result = selected(...rejected, base({ code: "600020" }), base({ code: "600024" }), base({ code: "600025" }));
  assert.deepEqual(result.items.map((item) => item.code), ["600016", "600019", "600020", "600024", "600025", "600018", "600017"]);
  assert.equal(result.exclusionCounts.amount, 1);
  assert.equal(result.exclusionCounts.amountTrend, 1);
  assert.equal(result.exclusionCounts.positiveReturn, 2);
  assert.equal(result.exclusionCounts.text, undefined);
  assert.equal(result.exclusionCounts.clues, undefined);
});

test("uses text and discussion as ranking boosts and still fills ten market-qualified slots", () => {
  const marketOnly = Array.from({ length: 12 }, (_, index) => base({
    code: `601${String(index).padStart(3, "0")}`,
    analysisStatus: "unscored",
    textDirection: 50,
    directionConsensus: 50,
    textConfidence: 0,
    freshness: 0,
    discussionCount: 0,
    userDiscussionCount: 0,
    discussionInteractions: 0,
    discussionHistory: undefined,
    independentEvents: 0,
    sourceCount: 0,
    hasNonForumCorroboration: false,
    industry: {
      name: "同一行情热点",
      textHeat: 0,
      textDirection: 50,
      marketStrength: 70,
      breadth: 70,
      relation: "交易驱动",
    },
  }));
  const result = selected(...marketOnly);
  assert.equal(result.status, "available");
  assert.equal(result.items.length, 10, "the daily pool should freeze as many qualified stocks as possible, capped at ten");
  assert.equal(result.items.every((item) => item.grade === "B"), true, "market-confirmed stocks without text evidence remain auditable fallback signals");
  assert.equal(result.exclusionCounts.text, undefined);
  assert.equal(result.exclusionCounts.clues, undefined);
  assert.equal(result.exclusionCounts.discussionBaseline, undefined);
  assert.equal(result.selectionDiagnostics.relaxedIndustryConstraints, true, "industry diversity is preferred but never allowed to empty the daily pool");
});

test("rejects malformed required market fields before they enter any reference set", () => {
  const result = selected(
    base({ code: "600026", high: 9, low: 10 }), base({ code: "600027", open: 12 }),
    base({ code: "600028", pctChange: Number.NaN }), base({ code: "600029", marketExcess: Number.POSITIVE_INFINITY }),
    base({ code: "600030" }), base({ code: "600037" }), base({ code: "600038" }),
  );
  assert.equal(result.exclusionCounts.invalidInput, 4);
  assert.deepEqual(result.items.map((item) => item.code), ["600030", "600037", "600038"]);
});

test("enforces base five-day trend and A/B boundary rules", () => {
  const baseOnly = base({ code: "600011", amountHistory: [100e6, 101e6, 99e6, 106e6, 110e6] });
  const b = base({ code: "600012", amountHistory: [100e6, 101e6, 99e6, 104e6, 105e6] });
  const failing = base({ code: "600013", amountHistory: [100e6, 101e6, 99e6, 104e6, 100e6] });
  const result = selected(baseOnly, b, failing);
  assert.equal(result.scored.find((item) => item.code === "600011")?.trend.base, true);
  assert.equal(result.scored.find((item) => item.code === "600011")?.trend.gradeA, false);
  assert.equal(result.scored.find((item) => item.code === "600012")?.trend.gradeB, true);
  assert.equal(result.exclusionCounts.amountTrend, 1);
});

test("recognizes exact A and base trend boundaries", () => {
  const aBoundary = amountTrend([100, 110, 105, 115, 120]);
  const baseBoundary = amountTrend([100, 110, 105, 120, 115]);
  assert.equal(aBoundary.increases, 3);
  assert.equal(aBoundary.ratio, 1.2);
  assert.equal(aBoundary.gradeA, true);
  assert.equal(baseBoundary.increases, 2);
  assert.equal(baseBoundary.base, true);
});

test("uses five-window median discussion growth and publishes mention delta", () => {
  const growth = calculateDiscussionGrowth(9, 80, 240, [
    { count: 1, interactions: 10, elapsedMinutes: 240, verified: true }, { count: 2, interactions: 20, elapsedMinutes: 240, verified: true }, { count: 2, interactions: 20, elapsedMinutes: 240, verified: true },
    { count: 3, interactions: 30, elapsedMinutes: 240, verified: true }, { count: 9, interactions: 90, elapsedMinutes: 240, verified: true },
  ]);
  assert.equal(growth.mentionDelta, 7);
  assert.equal(growth.countMedian, 2);
  assert.equal(growth.interactionsMedian, 20);
  assert.ok(growth.value > 0);
});

test("does not score discussion growth from missing, short, or mismatched-duration history", () => {
  const histories = [undefined, base().discussionHistory!.slice(0, 4), base().discussionHistory!.map((item, index) => ({ ...item, elapsedMinutes: index === 0 ? 239 : 240 }))];
  for (const [index, discussionHistory] of histories.entries()) {
    const result = selected(base({ code: `60010${index}`, discussionHistory, discussionGrowthPercentile: 99 }), base({ code: `60011${index}` }), base({ code: `60012${index}` }));
    const candidate = result.scored.find((item) => item.code === `60010${index}`)!;
    assert.equal(candidate.discussionGrowth.value, 0);
    assert.equal(candidate.discussionGrowthScore, 0);
    assert.equal(candidate.overheatPenalty, 0);
  }
});

test("does not treat unverified historical provenance as a comparable five-window baseline", () => {
  const growth = calculateDiscussionGrowth(20, 200, 240, Array.from({ length: 5 }, () => ({ count: 0, interactions: 0, elapsedMinutes: 240, verified: false })) as any);
  assert.equal(growth.isComparable, false);
  assert.equal(growth.value, 0);
});

test("requires explicit verified provenance before discussion growth can enter mention-delta or P99 calculations", () => {
  const growth = calculateDiscussionGrowth(20, 200, 240, Array.from({ length: 5 }, () => ({ count: 1, interactions: 10, elapsedMinutes: 240 })) as any);
  assert.equal(growth.isComparable, false);
  assert.equal(growth.mentionDelta, 0);
});

test("ignores caller-supplied price reference arrays and derives price percentiles from market-clean inputs", () => {
  const inputs = [base({ code: "600131", pctChange: 1, marketExcess: 0.1 }), base({ code: "600132", pctChange: 5, marketExcess: 2 }), base({ code: "600133", pctChange: 9, marketExcess: 4 })];
  const clean = selectDailyCandidates(inputs);
  const polluted = selectDailyCandidates(inputs);
  assert.deepEqual(clean.scored.map((item) => item.scores.price), polluted.scored.map((item) => item.scores.price));
});

test("derives amount-to-median and overheat inputs instead of trusting conflicting caller fields", () => {
  const low = selected(base({ code: "600141", amountToMedianRatio: 0.01 }), base({ code: "600142" }), base({ code: "600143" }));
  const high = selected(base({ code: "600141", amountToMedianRatio: 999 }), base({ code: "600142" }), base({ code: "600143" }));
  const lowCandidate = low.scored.find((item) => item.code === "600141")!;
  const highCandidate = high.scored.find((item) => item.code === "600141")!;
  assert.equal(lowCandidate.scores.turnover, highCandidate.scores.turnover);
  assert.equal(lowCandidate.overheatPenalty, highCandidate.overheatPenalty);
});

test("derives top-one-percent overheat signals from raw returns and verified discussion growth", () => {
  const invalidGrowth = base({ code: "600151", discussionHistory: undefined, discussionGrowthPercentile: 99, sourceCount: 1, duplicateRatio: 1, threeDayReturnPercentile: 99, amountToMedianRatio: 999 });
  const candidate = selected(invalidGrowth, base({ code: "600152" }), base({ code: "600153" }), base({ code: "600154" })).scored.find((item) => item.code === "600151")!;
  assert.equal(candidate.overheatPenalty, 0);
});

test("keeps market, text, and trend references isolated to their specified eligible universes", () => {
  const core = [base({ code: "600161" }), base({ code: "600162" }), base({ code: "600163" })];
  const clean = selected(...core).scored.find((item) => item.code === "600161")!;
  const polluted = selected(
    ...core,
    base({ code: "600164", high: 9, low: 10, pctChange: 999, marketExcess: 999 }),
    base({ code: "600165", analysisStatus: "unscored", discussionCount: 999_999, discussionInteractions: 999_999 }),
    base({ code: "600166", amountHistory: [100e6, 0, 0, 0, 0], amount: 500e6 }),
  ).scored.find((item) => item.code === "600161")!;
  assert.equal(clean.scores.price, polluted.scores.price);
  assert.equal(clean.scores.discussion, polluted.scores.discussion);
  assert.equal(clean.scores.turnover, polluted.scores.turnover);
});

test("winsorizes at P5/P95 before percentiling", () => {
  const reference = Array.from({ length: 101 }, (_, index) => index);
  assert.equal(winsorizedPercentile(-100, reference), 5);
  assert.equal(winsorizedPercentile(200, reference), 95);
  assert.equal(winsorizedPercentile(50, reference), 50);
});

test("uses empirical ranks after winsorization instead of linear P5/P95 scaling", () => {
  const reference = [0, 1, 2, 3, 100];
  assert.equal(winsorizedPercentile(3, reference), 75, "the fourth ordered observation has percentile rank 75 even in a skewed sample");
});

test("gives turnover exactly 30 points and six weights sum to 100", () => {
  const result = selected(base({ code: "600021" }), base({ code: "600022" }), base({ code: "600023" }));
  assert.equal(Object.values(DAILY_FOCUS_WEIGHTS).reduce((sum, value) => sum + value, 0), 100);
  assert.ok(result.items[0]);
  assert.ok(result.items[0]!.scores.turnover <= 30);
  assert.equal(Object.values(result.items[0]!.scores).reduce((sum, value) => sum + value, 0), result.items[0]!.baseScore);
});

test("awards every sub-item's declared maximum for a fully saturated candidate", () => {
  const saturated = (code: string, industry: string) => base({
    code, high: 11, low: 10, open: 10, close: 11, previousClose: 10, pctChange: 10,
    amount: 500e6, amountHistory: [100e6, 120e6, 160e6, 200e6, 500e6], marketExcess: 10,
    textDirection: 86, directionConsensus: 100, textConfidence: 100, freshness: 100,
    independentEvents: 5, sourceCount: 3, hasNonForumCorroboration: true,
    industry: { name: industry, textHeat: 100, textDirection: 100, marketStrength: 100, breadth: 100, relation: "舆情交易双热" },
  });
  const item = selected(saturated("600171", "甲"), saturated("600172", "乙"), saturated("600173", "丙")).scored[0]!;
  assert.deepEqual(item.scores, { turnover: 30, direction: 18, discussion: 18, price: 18, industry: 12, reliability: 4 });
  assert.equal(item.baseScore, 100);
});

test("uses weak text and discussion as downgrades while retaining the price gate", () => {
  const strong = [base({ code: "600031" }), base({ code: "600032" }), base({ code: "600033" })];
  const weakText = base({ code: "600034", textDirection: 57 });
  const weakDiscussion = base({ code: "600035", discussionCount: 1, userDiscussionCount: 1, discussionInteractions: 1 });
  const weakPrice = base({ code: "600036", pctChange: 0.1, marketExcess: 0.01 });
  const result = selected(...strong, weakText, weakDiscussion, weakPrice);
  assert.deepEqual(result.items.map((item) => item.code), ["600031", "600032", "600033", "600034", "600035"]);
  assert.notEqual(result.scored.find((item) => item.code === "600034")?.grade, "A");
  assert.notEqual(result.scored.find((item) => item.code === "600035")?.grade, "A");
  assert.notEqual(result.scored.find((item) => item.code === "600036")?.grade, "A");
  assert.equal(result.items.some((item) => item.code === "600036"), false);
});

test("applies each overheat penalty and caps their total at ten", () => {
  assert.equal(overheatPenalty(base({ reopenedLimit: true }), 1, false, false), 3);
  assert.equal(overheatPenalty(base(), 2.5, true, false), 4);
  assert.equal(overheatPenalty(base({ sourceCount: 1, duplicateRatio: 0.4 }), 1, false, true), 3);
  assert.equal(overheatPenalty(base({ reopenedLimit: true, sourceCount: 1, duplicateRatio: 0.4 }), 2.5, true, true), 10);
});

test("uses the un-winsorized empirical top one percent for three-day overheat", () => {
  const inputs = Array.from({ length: 101 }, (_, value) => base({ code: `6${String(value).padStart(5, "0")}`, threeDayReturn: value }));
  const result = selected(...inputs);
  const penalty = (value: number) => result.scored.find((item) => item.inputAudit.threeDayReturn === value)?.overheatPenalty;
  assert.equal(penalty(94), 0);
  assert.equal(penalty(95), 0);
  assert.equal(penalty(99), 4);
});

test("uses the same empirical top one percent boundary for verified discussion growth", () => {
  const inputs = Array.from({ length: 101 }, (_, value) => base({
    code: `7${String(value).padStart(5, "0")}`, discussionCount: value, discussionInteractions: 0,
    discussionHistory: Array.from({ length: 5 }, () => ({ count: 0, interactions: 0, elapsedMinutes: 240, verified: true })),
    sourceCount: 1, duplicateRatio: 0.4,
  }));
  const result = selected(...inputs);
  const penalty = (value: number) => result.scored.find((item) => item.inputAudit.discussionCount === value)?.overheatPenalty;
  assert.equal(penalty(94), 0);
  assert.equal(penalty(95), 0);
  assert.equal(penalty(99), 3);
});

test("uses B candidates only when fewer than three A candidates are available", () => {
  const a = base({ code: "600051" });
  const b1 = base({ code: "600052", amountHistory: [100e6, 101e6, 99e6, 104e6, 105e6], textDirection: 58, amount: 500e6, amountToMedianRatio: 2.5 });
  const b2 = base({ code: "600053", amountHistory: [100e6, 101e6, 99e6, 104e6, 105e6], textDirection: 58, amount: 500e6, amountToMedianRatio: 2.5 });
  const result = selected(a, b1, b2);
  assert.deepEqual(result.items.map((item) => item.grade), ["A", "B", "B"]);
});

test("B fallback fills the remaining slots without displacing qualified A candidates", () => {
  const lowA = (code: string) => base({ code, pctChange: 10, marketExcess: 8, industry: null });
  const highB = (code: string) => base({
    code, amountHistory: [100e6, 110e6, 105e6, 115e6, 105e6], textDirection: 86,
    directionConsensus: 100, textConfidence: 100, freshness: 100, pctChange: 10, marketExcess: 8,
    industry: { name: `热门${code}`, textHeat: 100, textDirection: 100, marketStrength: 100, breadth: 100, relation: "舆情交易双热" },
  });
  const result = selected(lowA("600271"), lowA("600272"), highB("600273"), highB("600274"), highB("600275"));
  assert.deepEqual(result.items.filter((item) => item.grade === "A").map((item) => item.code).sort(), ["600271", "600272"], JSON.stringify(result.scored.map((item) => ({ code: item.code, grade: item.grade, final: item.finalScore, scores: item.scores, trend: item.trend }))));
  assert.equal(result.items.filter((item) => item.grade === "B").length, 3, "all qualified fallback candidates remain visible while the list stays below ten");
});

test("fills remaining capacity with B candidates even when three A candidates qualify", () => {
  const b = base({ code: "600059", amountHistory: [100e6, 101e6, 99e6, 104e6, 105e6], textDirection: 58, amount: 500e6, amountToMedianRatio: 2.5 });
  const result = selected(base({ code: "600056" }), base({ code: "600057" }), base({ code: "600058" }), b);
  assert.deepEqual(result.items.map((item) => item.grade), ["A", "A", "A", "B"]);
});

test("prefers hot and diversified industries, then relaxes concentration to fill the pool", () => {
  const hot = (code: string, industry: string) => base({ code, industry: { ...base().industry!, name: industry } });
  const cold = (code: string) => base({ code, industry: { ...base().industry!, name: "冷门", textHeat: 20, textDirection: 40, marketStrength: 30, breadth: 20, relation: "常态行业" } });
  const result = selected(hot("600061", "甲"), hot("600062", "甲"), hot("600063", "甲"), hot("600064", "甲"), hot("600065", "乙"), hot("600066", "乙"), hot("600067", "乙"), cold("600068"), cold("600069"));
  assert.equal(result.items.length, 9);
  assert.equal(result.items.filter((item) => item.industry?.name === "甲").length, 4);
  assert.ok(result.items.filter((item) => item.isHotIndustry).length >= Math.ceil(result.items.length * 0.7));
  assert.equal(result.selectionDiagnostics.relaxedIndustryConstraints, true);
});

test("relaxes industry preference and single-industry cap only when they would leave fewer than three", () => {
  const cold = (code: string) => base({ code, industry: { name: "同一行业", textHeat: 0, textDirection: 0, marketStrength: 0, breadth: 0, relation: "常态行业" } });
  const result = selected(cold("600181"), cold("600182"), cold("600183"));
  assert.equal(result.status, "available");
  assert.equal(result.items.length, 3);
  assert.equal(result.items.filter((item) => item.industry?.name === "同一行业").length, 3);
});

test("returns every qualified candidate when fewer than three qualify", () => {
  const result = selected(base({ code: "600071" }), base({ code: "600072", onePriceLimit: true }));
  assert.equal(result.status, "available");
  assert.deepEqual(result.items.map((item) => item.code), ["600071"]);
});

test("is deterministic and uses the documented stable tie-break order", () => {
  const inputs = [base({ code: "600083" }), base({ code: "600081" }), base({ code: "600082" })];
  const first = selected(...inputs);
  const second = selected(...[...inputs].reverse());
  assert.deepEqual(first, second);
  assert.deepEqual(first.items.map((item) => item.code), ["600081", "600082", "600083"]);
});

test("rejects malformed runtime inputs without producing non-finite scores", () => {
  const malformed = [
    { ...base({ code: "600201", textDirection: 101 }), textDirection: 101 },
    { ...base({ code: "600202" }), onePriceLimit: "false" },
    { ...base({ code: "600203" }), discussionCount: 1.5 },
    { ...base({ code: "600204" }), industry: { ...base().industry!, relation: "unknown" } },
    { ...base({ code: "600205" }), textConfidence: Number.NaN },
  ] as DailyCandidateInput[];
  const result = selected(...malformed, base({ code: "600206" }), base({ code: "600207" }), base({ code: "600208" }));
  assert.equal(result.exclusionCounts.invalidInput, 5);
  assert.ok(result.scored.flatMap((item) => Object.values(item.scores)).every(Number.isFinite));
});

test("requires hasNonForumCorroboration to be an explicit boolean", () => {
  const missing = { ...base({ code: "600209" }) } as Partial<DailyCandidateInput>;
  delete missing.hasNonForumCorroboration;
  const result = selected(missing as DailyCandidateInput, base({ code: "600210" }), base({ code: "600216" }), base({ code: "600217" }));
  assert.equal(result.exclusionCounts.invalidInput, 1);
  assert.equal(result.scored.some((item) => item.code === "600209"), false);
});

test("excludes duplicate codes and mixed trade dates deterministically", () => {
  const inputs = [
    base({ code: "600211" }), base({ code: "600211" }),
    base({ code: "600212", tradeDate: "2026-08-26" }),
    base({ code: "600213" }), base({ code: "600214" }), base({ code: "600215" }),
  ];
  const first = selected(...inputs);
  const second = selected(...[...inputs].reverse());
  assert.equal(first.exclusionCounts.invalidInput, 3);
  assert.deepEqual(first, second);
  assert.deepEqual(first.items.map((item) => item.code), ["600213", "600214", "600215"]);
});

test("does not apply P99 overheat deductions with fewer than one hundred reference observations", () => {
  const inputs = Array.from({ length: 99 }, (_, value) => base({ code: `8${String(value).padStart(5, "0")}`, threeDayReturn: value }));
  const candidate = selected(...inputs).scored.find((item) => item.inputAudit.threeDayReturn === 98)!;
  assert.equal(candidate.overheatPenalty, 0);
});

test("fills ten qualified stocks when a strict industry cap would truncate the pool", () => {
  const hot = (code: string) => base({ code, industry: { ...base().industry!, name: "热点" } });
  const cold = (code: string) => base({ code, industry: { ...base().industry!, name: "冷门", textHeat: 0, textDirection: 0, marketStrength: 0, breadth: 0, relation: "常态行业" } });
  const result = selected(hot("600221"), hot("600222"), hot("600223"), hot("600224"), hot("600225"), hot("600226"), cold("600227"), cold("600228"), cold("600229"), cold("600230"));
  assert.equal(result.items.length, 10);
  assert.equal(result.selectionDiagnostics.initialTarget, 10);
  assert.equal(result.selectionDiagnostics.relaxedIndustryConstraints, true);
  assert.equal(result.selectionDiagnostics.constraintTruncated, false);
});

test("returns frozen audit snapshots and prepared-reference metadata, never input references", () => {
  const input = base({ code: "600231" });
  const result = selected(input, base({ code: "600232" }), base({ code: "600233" }));
  const item = result.scored.find((candidate) => candidate.code === input.code)!;
  input.amount = 1;
  assert.equal(item.inputAudit.amount, 500_000_000);
  assert.equal(Object.isFrozen(item.inputAudit), true);
  assert.ok(result.referenceAudit.market.amount.sampleSize >= 3);
  assert.ok(Number.isFinite(result.referenceAudit.market.amount.p95));
});

test("scores five thousand representative inputs within a bounded runtime and preserves permutation-equivalence", () => {
  const inputs = Array.from({ length: 5_000 }, (_, index) => base({
    code: `9${String(index).padStart(5, "0")}`, pctChange: 1 + (index % 9), marketExcess: 0.1 + (index % 5),
    amount: 100e6 + index * 1000, amountHistory: [100e6, 110e6, 105e6, 120e6, 125e6 + index * 1000],
    discussionCount: 10 + (index % 20), discussionInteractions: 50 + (index % 100), threeDayReturn: index,
    industry: { ...base().industry!, name: `行业${index % 20}` },
  }));
  const started = performance.now();
  const first = selected(...inputs);
  const elapsed = performance.now() - started;
  const second = selected(...[...inputs].reverse());
  assert.ok(elapsed < 4_000, `strategy took ${elapsed.toFixed(0)}ms`);
  assert.deepEqual(first, second);
});

test("never exposes raw inputs or mutable industry references through public results", () => {
  const input = base({ code: "600241" });
  const result = selected(input, base({ code: "600242" }), base({ code: "600243" }));
  const item = result.items.find((candidate) => candidate.code === input.code)!;
  assert.equal("raw" in item, false);
  input.industry!.name = "被修改";
  assert.equal(item.industry?.name, "半导体");
  assert.equal(Object.isFrozen(item.industry!), true);
  assert.equal(Object.isFrozen(result.scored.find((candidate) => candidate.code === input.code)!.industry!), true);
});

test("treats unknown and malformed container shapes as invalid input without throwing", () => {
  const invoke = (input: unknown) => selectDailyCandidates(input);
  for (const input of [null, {}, [null], [42], [{ ...base(), amountHistory: null }], [{ ...base(), discussionHistory: null }], [{ ...base(), discussionHistory: [null, null, null, null, null] }]]) {
    assert.doesNotThrow(() => invoke(input));
    assert.equal(invoke(input).exclusionCounts.invalidInput, Array.isArray(input) ? input.length : 1);
  }
});

test("returns recursively frozen reference and selection audit DTOs", () => {
  const result = selected(base({ code: "600251" }), base({ code: "600252" }), base({ code: "600253" }));
  assert.equal(Object.isFrozen(result.referenceAudit), true);
  assert.equal(Object.isFrozen(result.referenceAudit.market), true);
  assert.equal(Object.isFrozen(result.referenceAudit.market.amount), true);
  assert.equal(Object.isFrozen(result.selectionDiagnostics), true);
  assert.equal(Object.isFrozen(result.selectionDiagnostics.reasons), true);
});

test("returns zero for non-finite winsorized values and supports generic empirical quantiles", () => {
  assert.equal(winsorizedPercentile(Number.NaN, [1, 2, 3]), 0);
  assert.equal(winsorizedPercentile(Number.POSITIVE_INFINITY, [1, 2, 3]), 0);
  assert.equal(isAtOrAboveEmpiricalQuantile(8, [1, 2, 3, 4, 5, 6, 7, 8], 0.75), true);
  assert.equal(isAtOrAboveEmpiricalQuantile(5, [1, 2, 3, 4, 5, 6, 7, 8], 0.75), false);
});
