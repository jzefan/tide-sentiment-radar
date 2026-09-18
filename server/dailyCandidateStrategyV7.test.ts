import assert from "node:assert/strict";
import test from "node:test";
import {
  DAILY_FOCUS_VERSION,
  selectDailyCandidates,
  type DailyCandidateInput,
} from "./dailyCandidateStrategyV7.ts";

function base(overrides: Partial<DailyCandidateInput> = {}): DailyCandidateInput {
  return {
    code: "600001",
    name: "测试股份",
    exchange: "SH",
    listingTradingDays: 500,
    tradeDate: "2026-09-18",
    open: 10,
    high: 10.8,
    low: 9.9,
    close: 10.6,
    previousClose: 10,
    pctChange: 6,
    amount: 500_000_000,
    amountHistory: [300_000_000, 320_000_000, 360_000_000, 410_000_000, 500_000_000],
    marketExcess: 4,
    analysisStatus: "scored",
    textDirection: 72,
    directionConsensus: 80,
    textConfidence: 82,
    freshness: 90,
    discussionCount: 80,
    userDiscussionCount: 80,
    discussionInteractions: 500,
    discussionElapsedMinutes: 240,
    independentEvents: 2,
    sourceCount: 2,
    hasNonForumCorroboration: true,
    industry: {
      name: "半导体",
      textHeat: 80,
      textDirection: 70,
      marketStrength: 78,
      breadth: 72,
      relation: "舆情交易双热",
    },
    eventClusters: [{
      clusterId: "evt-a",
      title: "签署重大合同",
      category: "order",
      importance: 82,
      persistence: 80,
      novelty: 100,
      direction: 90,
      confidence: 90,
      evidenceCount: 2,
      independentSourceCount: 2,
      authorityCount: 1,
    }],
    historicalTextDirectionMedian: 52,
    sentimentDelta: 20,
    historicalEventCountMedian: 0,
    focusDaysLast5: 0,
    consecutiveFocusDays: 0,
    lastFocusDate: null,
    lastPrimaryEventClusterId: null,
    ...overrides,
  };
}

test("uses the v7 methodology version", () => {
  const result = selectDailyCandidates([base()]);
  assert.equal(result.methodologyVersion, DAILY_FOCUS_VERSION);
  assert.equal(result.methodologyVersion, "daily-focus-v7");
});

test("event breakout may qualify before a five-day amount trend is established", () => {
  const input = base({
    amountHistory: [500_000_000, 450_000_000, 430_000_000, 440_000_000, 445_000_000],
    pctChange: 1.2,
    marketExcess: 0.4,
  });
  const result = selectDailyCandidates([input]);
  const scored = result.scored[0]!;
  assert.equal(scored.eventEligible, true);
  assert.equal(scored.lane, "event");
  assert.ok(scored.researchScore2W >= 58);
});

test("repeat penalty is reset by a genuinely new important event", () => {
  const repeated = selectDailyCandidates([base({
    focusDaysLast5: 4,
    consecutiveFocusDays: 4,
    eventClusters: [{
      ...base().eventClusters![0]!,
      importance: 68,
      novelty: 60,
    }],
  })]).scored[0]!;
  const reset = selectDailyCandidates([base({
    focusDaysLast5: 4,
    consecutiveFocusDays: 4,
    eventClusters: [{
      ...base().eventClusters![0]!,
      importance: 85,
      novelty: 90,
    }],
  })]).scored[0]!;
  assert.ok(repeated.repeatPenalty > 0);
  assert.equal(reset.repeatPenalty, 0);
});

test("leadership is bounded and cannot dominate the v7 score", () => {
  const leader = selectDailyCandidates([base({
    leadership: {
      boardCount: 5,
      firstSealTime: "09:25:00",
      lastSealTime: "09:25:00",
      breakCount: 0,
      sealAmount: 50_000_000,
      dragonTiger: {
        netAmount: 100_000_000,
        buyAmount: 200_000_000,
        sellAmount: 100_000_000,
        reasons: [],
        listCount: 1,
      },
      industryLimitUps: 5,
      tier: "market",
      reasons: [],
    },
  })]).scored[0]!;
  assert.ok(leader.leadershipBonus <= 3);
});

test("does not use 3:3:2:2 board quotas and never publishes more than eight", () => {
  const inputs = Array.from({ length: 12 }, (_, index) => base({
    code: `600${String(index + 1).padStart(3, "0")}`,
    industry: {
      ...base().industry!,
      name: `行业${index}`,
    },
    eventClusters: [{
      ...base().eventClusters![0]!,
      clusterId: `evt-${index}`,
      title: `重大合同-${index}`,
    }],
  }));
  const result = selectDailyCandidates(inputs);
  assert.ok(result.items.length <= 8);
  assert.ok(result.items.every((item) => item.board === "主板"));
});

test("same real-world event contributes at most two selected stocks", () => {
  const inputs = Array.from({ length: 6 }, (_, index) => base({
    code: `6001${String(index).padStart(2, "0")}`,
    industry: { ...base().industry!, name: `行业${index}` },
    eventClusters: [{
      ...base().eventClusters![0]!,
      clusterId: "evt-shared",
      title: "同一产业政策",
    }],
  }));
  const result = selectDailyCandidates(inputs);
  assert.ok(result.items.filter((item) => item.primaryEvent?.clusterId === "evt-shared").length <= 2);
});

const hotOnlyBase = (code: string, industryName: string) => base({
  code,
  // 跑输市场 → 趋势通道不成立；没有事件 → 事件通道不成立。
  marketExcess: -1,
  eventClusters: [],
  industry: { name: industryName, textHeat: 100, textDirection: 100, marketStrength: 100, breadth: 100, relation: "舆情交易双热" },
});

test("an event lane needs a qualified event, and pure market strength stays in the trend lane", () => {
  const withoutEvent = selectDailyCandidates([base({ eventClusters: [] })]).scored[0]!;
  assert.equal(withoutEvent.primaryEvent, null);
  assert.equal(withoutEvent.eventEligible, false, "没有事件不能进入事件通道");
  assert.equal(withoutEvent.eventScore, 0);
  assert.equal(withoutEvent.lane, "trend");
  assert.equal(withoutEvent.researchScore2W, withoutEvent.trendScore, "研究分只取已成立通道的分数");
  assert.notEqual(withoutEvent.grade, null, "纯量价趋势股票仍可进入观察聚焦");
});

test("keeps at most two hot-only seats instead of filling the board with hot stocks", () => {
  const hotResult = selectDailyCandidates([
    hotOnlyBase("600001", "行业一"), hotOnlyBase("600002", "行业二"),
    hotOnlyBase("600003", "行业三"), hotOnlyBase("600004", "行业四"),
  ]);
  const hotScored = hotResult.scored[0]!;
  assert.equal(hotScored.lane, null, "既没有事件也没有趋势");
  assert.equal(hotScored.hotEligible, true, "热度分达到 80 且有可解释证据");
  assert.equal(hotScored.grade, "B", "设计 §22：热点分支不设最终分下限");
  assert.ok(hotResult.items.length <= 2, `热点位最多 2 只，实际 ${hotResult.items.length}`);
  assert.equal(hotResult.items.every((item) => item.focusType === "hot"), true);
  assert.equal(hotResult.selectionDiagnostics.hotSelected, hotResult.items.length);
});

test("hot score never enters the two-week research score", () => {
  const plain = selectDailyCandidates([base({ code: "600001" })]).scored[0]!;
  const hotter = selectDailyCandidates([base({
    code: "600001",
    leadership: {
      boardCount: 5, firstSealTime: "09:25:00", lastSealTime: "09:25:00", breakCount: 0, sealAmount: 50_000_000,
      dragonTiger: { netAmount: 100_000_000, buyAmount: 1, sellAmount: 1, reasons: [], listCount: 1 },
      industryLimitUps: 5, tier: "market", reasons: [],
    },
  })]).scored[0]!;
  assert.ok(hotter.hotScore > plain.hotScore, "龙头事实提高热度分");
  assert.equal(hotter.researchScore2W, plain.researchScore2W, "热度不参与研究分");
  // 热度只通过 20% 权重与 ≤3 的龙头加分影响最终分（龙头同时进 HotScore 的 10% 分项，双重计入但被上限约束）。
  assert.ok(hotter.finalScore - plain.finalScore <= 6, `热度对最终分的影响必须有界，实际 ${hotter.finalScore - plain.finalScore}`);
});

test("caps one industry at two candidates until supply forces a relaxation", () => {
  const spread = [0, 1, 2, 3].flatMap((industry) =>
    [0, 1, 2].map((index) => base({
      code: `6001${industry}${index}`,
      industry: { ...base().industry!, name: `行业${industry}` },
      eventClusters: [{ ...base().eventClusters![0]!, clusterId: `evt-${industry}-${index}`, title: `重大合同-${industry}-${index}` }],
    })));
  const spreadResult = selectDailyCandidates(spread);
  const countByIndustry = new Map<string, number>();
  for (const item of spreadResult.items) countByIndustry.set(item.industry!.name, (countByIndustry.get(item.industry!.name) ?? 0) + 1);
  assert.equal(Math.max(...countByIndustry.values()), 2, "候选充足时同一行业最多 2 只");
  assert.equal(spreadResult.selectionDiagnostics.relaxedIndustryLimit, false);
  assert.equal(spreadResult.items.length, 8);

  const concentrated = [0, 1, 2, 3, 4].map((index) => base({
    code: `6002${index}00`,
    industry: { ...base().industry!, name: "同一行业" },
    eventClusters: [{ ...base().eventClusters![0]!, clusterId: `evt-c-${index}`, title: `重大合同-c-${index}` }],
  }));
  const concentratedResult = selectDailyCandidates(concentrated);
  assert.equal(concentratedResult.selectionDiagnostics.relaxedIndustryLimit, true, "候选集中在同一行业时放宽到 3");
  assert.ok(concentratedResult.items.length <= 3);
});

test("leaves sentiment delta null when there is no historical baseline", () => {
  const withoutHistory = selectDailyCandidates([base({ historicalTextDirectionMedian: null, sentimentDelta: null })]).scored[0]!;
  assert.equal(withoutHistory.sentimentDelta, null, "历史不足必须为 null，不能伪造基线");
  const derived = selectDailyCandidates([base({ historicalTextDirectionMedian: 50, sentimentDelta: undefined })]).scored[0]!;
  assert.equal(derived.sentimentDelta, 22, "有历史中位数时按当天方向减去中位数");
});

test("continuation confirmation offsets part of the repeat penalty", () => {
  // 用没有事件的输入观察重复惩罚本身，避免「新重大事件清零惩罚」那条规则同时生效。
  const withContinuation = selectDailyCandidates([base({ eventClusters: [], focusDaysLast5: 2, consecutiveFocusDays: 1 })]).scored[0]!;
  const withoutContinuation = selectDailyCandidates([base({
    eventClusters: [],
    focusDaysLast5: 2,
    consecutiveFocusDays: 1,
    amountHistory: [500_000_000, 450_000_000, 430_000_000, 440_000_000, 445_000_000],
    industry: { ...base().industry!, marketStrength: 40 },
  })]).scored[0]!;
  assert.ok(withContinuation.continuationBonus >= 1);
  assert.ok(withContinuation.repeatPenalty < withoutContinuation.repeatPenalty, "持续确认抵消部分重复惩罚");
  assert.equal(withoutContinuation.repeatPenalty, 3, "无持续确认时两次聚焦记 3 分");
});

test("overheat penalty can outweigh the leadership bonus", () => {
  const market = Array.from({ length: 120 }, (_, index) => base({
    code: `6003${String(index).padStart(2, "0")}`,
    threeDayReturn: 1,
    eventClusters: [],
  }));
  const overheated = base({
    code: "600999",
    threeDayReturn: 40,
    amount: 1_200_000_000,
    reopenedLimit: true,
    leadership: {
      boardCount: 5, firstSealTime: "09:25:00", lastSealTime: "09:25:00", breakCount: 0, sealAmount: 1,
      dragonTiger: null, industryLimitUps: 1, tier: "market", reasons: [],
    },
  });
  const scored = selectDailyCandidates([...market, overheated]).scored.find((item) => item.code === "600999")!;
  assert.equal(scored.leadershipBonus, 3);
  assert.ok(scored.overheatPenalty > scored.leadershipBonus, `过热扣分（${scored.overheatPenalty}）必须能超过龙头奖励（${scored.leadershipBonus}）`);
});

test("the same inputs always produce the same ranking", () => {
  const inputs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => base({
    code: `6004${String(index).padStart(2, "0")}`,
    industry: { ...base().industry!, name: `行业${index % 3}` },
    eventClusters: [{ ...base().eventClusters![0]!, clusterId: `evt-${index % 4}`, title: `重大合同-${index % 4}` }],
  }));
  const first = selectDailyCandidates(inputs);
  const second = selectDailyCandidates([...inputs].reverse());
  assert.deepEqual(first.items.map((item) => item.code), second.items.map((item) => item.code));
  assert.deepEqual(first.selectionDiagnostics, second.selectionDiagnostics);
});

test("flags when the focus reason changed since the previous focus", () => {
  const replaced = selectDailyCandidates([base({ lastPrimaryEventClusterId: "evt-old" })]).scored[0]!;
  assert.equal(replaced.focusReasonChanged, true, "核心事件换了就是理由变化");
  const unchanged = selectDailyCandidates([base({ lastPrimaryEventClusterId: "evt-a" })]).scored[0]!;
  assert.equal(unchanged.focusReasonChanged, false, "与上次同一个事件簇不算变化");
  const appeared = selectDailyCandidates([base({ lastPrimaryEventClusterId: null })]).scored[0]!;
  assert.equal(appeared.focusReasonChanged, true, "上次没有事件、这次有了，也是理由变化");
});

test("keeps a real board-count reference for the leadership audit", () => {
  const result = selectDailyCandidates([
    base({ code: "600001" }),
    base({
      code: "600002",
      leadership: {
        boardCount: 3, firstSealTime: "09:25:00", lastSealTime: "09:25:00", breakCount: 0, sealAmount: 1,
        dragonTiger: null, industryLimitUps: 1, tier: "industry", reasons: [],
      },
    }),
  ]);
  assert.equal(result.referenceAudit.leadership.boardCount.sampleSize, 1, "参考集只统计当日真正涨停的股票");
  assert.equal(result.referenceAudit.leadership.boardCount.p5, 3);
});
