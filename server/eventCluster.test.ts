import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEventClusters,
  classifyEventCategory,
  eventTitleSimilarity,
  isRoutineFiling,
  scoreEventNovelty,
  timelinessScore,
} from "./eventCluster.ts";
import type { SentimentEvent } from "../src/domain/types.ts";

function event(overrides: Partial<SentimentEvent> = {}): SentimentEvent {
  return {
    id: "e1",
    title: "某公司签署10亿元重大合同",
    category: "公司公告",
    eventType: "公司",
    publishedAt: "2026-09-18T02:00:00.000Z",
    source: "上市公司公告",
    sourceKind: "announcement",
    tone: "positive",
    confidence: 92,
    heat: 80,
    summary: "",
    topics: [],
    relatedStocks: [{ code: "600001", name: "测试", relevance: 100, reason: "", tone: "positive" }],
    corroboration: 90,
    ...overrides,
  };
}

test("classifies durable catalysts", () => {
  assert.equal(classifyEventCategory("公司签署重大采购合同"), "order");
  assert.equal(classifyEventCategory("重大资产重组方案获批"), "ma");
  assert.equal(classifyEventCategory("前三季度净利润预增80%"), "earnings");
});

test("clusters syndicated reports into one real-world event", () => {
  const events = [
    event(),
    event({
      id: "e2",
      source: "证券时报",
      sourceKind: "news",
      title: "某公司获10亿元重大合同",
      publishedAt: "2026-09-18T02:20:00.000Z",
    }),
  ];
  const clusters = buildEventClusters(events);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.evidenceCount, 2);
  assert.equal(clusters[0]!.independentSourceCount, 2);
  assert.ok(clusters[0]!.importance >= 60);
});

test("does not cluster unrelated titles", () => {
  assert.ok(eventTitleSimilarity("重大合同签署", "股东大会正常召开") < 0.5);
  const clusters = buildEventClusters([
    event(),
    event({ id: "e3", title: "股东大会正常召开", source: "新闻源" }),
  ]);
  assert.equal(clusters.length, 2);
});

test("new evidence gets high novelty while yesterday's same event is discounted", () => {
  const cluster = buildEventClusters([event()])[0]!;
  assert.equal(scoreEventNovelty(cluster, [], "2026-09-18"), 100);
  const repeated = scoreEventNovelty(
    cluster,
    [{
      title: "某公司签署10亿元重大合同",
      publishedAt: "2026-09-17T02:00:00.000Z",
      sourceKind: "announcement",
    }],
    "2026-09-18",
  );
  assert.ok(repeated <= 25);
});

test("treats compliance paperwork as routine instead of a new catalyst", () => {
  const routineTitles = [
    "绿地控股:北京金杜(杭州)律师事务所关于绿地控股集团股份有限公司2026年第三次临时股东大会的法律意见书",
    "某公司:关于召开2026年第三季度业绩说明会的公告",
    "国民技术:关于为子公司提供担保的进展公告",
    "赛意信息:关于开展融资租赁业务的进展公告",
  ];
  for (const title of routineTitles) {
    assert.equal(isRoutineFiling(title), true, `应识别为例行文件：${title.slice(0, 20)}`);
    assert.equal(classifyEventCategory(title), "other", `例行文件不进入政策/业绩等催化类别：${title.slice(0, 20)}`);
  }
  // 含明确催化词的标题不做例行降级。
  const catalystTitles = [
    "某公司:关于签署重大合同的公告",
    "某公司:股东大会审议通过重大资产重组议案",
    "某公司:关于回购公司股份方案的公告",
  ];
  for (const title of catalystTitles) {
    assert.equal(isRoutineFiling(title), false, `真实催化不应被降级：${title.slice(0, 20)}`);
  }
  assert.equal(classifyEventCategory("某公司:股东大会审议通过重大资产重组议案"), "ma");
});

test("caps routine filings below the event gate while genuine catalysts stay above it", () => {
  const legalOpinion = buildEventClusters([
    event({
      title: "某公司:北京金杜律师事务所关于某公司2026年第一次临时股东大会的法律意见书",
      tone: "neutral",
    }),
  ])[0]!;
  assert.ok(legalOpinion.importance <= 55, `例行文件重要度必须低于事件门槛 60，实际 ${legalOpinion.importance}`);
  assert.ok(legalOpinion.persistence <= 45, "例行文件不应被当成高持续性催化");

  const realOrder = buildEventClusters([
    event({ title: "某公司:关于签署12亿元重大合同的公告" }),
  ])[0]!;
  assert.ok(realOrder.importance >= 60, `真实订单事件必须能进入事件通道，实际 ${realOrder.importance}`);
  assert.ok(realOrder.persistence >= 80);
});

test("scores timeliness by real age instead of a constant", () => {
  const reference = Date.parse("2026-09-18T15:00:00+08:00");
  assert.equal(timelinessScore("2026-09-18T02:00:00.000Z", reference), 100, "24 小时内");
  assert.equal(timelinessScore("2026-09-16T02:00:00.000Z", reference), 60, "72 小时内");
  assert.equal(timelinessScore("2026-09-10T02:00:00.000Z", reference), 30, "更早");

  const fresh = buildEventClusters([event({ title: "某公司:关于签署12亿元重大合同的公告" })], "2026-09-18")[0]!;
  const stale = buildEventClusters([event({ title: "某公司:关于签署12亿元重大合同的公告", publishedAt: "2026-09-01T02:00:00.000Z" })], "2026-09-18")[0]!;
  assert.ok(fresh.importance > stale.importance, "同样的事件越旧重要度越低");
});

test("discounts yesterday's repeat using calendar days rather than 24-hour buckets", () => {
  const cluster = buildEventClusters([event()])[0]!;
  const yesterdayMorning = scoreEventNovelty(
    cluster,
    [{ title: "某公司签署10亿元重大合同", publishedAt: "2026-09-17T02:00:00.000Z", sourceKind: "announcement" }],
    "2026-09-18",
  );
  assert.equal(yesterdayMorning, 25, "昨日 10:00 已公告过的同类事件应为 25，而不是按 1.2 天算成 50");
  const lastWeek = scoreEventNovelty(
    cluster,
    [{ title: "某公司签署10亿元重大合同", publishedAt: "2026-09-11T02:00:00.000Z", sourceKind: "announcement" }],
    "2026-09-18",
  );
  assert.equal(lastWeek, 70);
  // 昨日只是新闻转载、今天出了正式公告：属于实质性更新，新鲜度抬到 75。
  const materialUpdate = scoreEventNovelty(
    cluster,
    [{ title: "某公司签署10亿元重大合同", publishedAt: "2026-09-17T02:00:00.000Z", sourceKind: "news" }],
    "2026-09-18",
  );
  assert.equal(materialUpdate, 75);
});

test("separates buyback programmes from share-cancellation paperwork", () => {
  assert.equal(isRoutineFiling("某公司:关于回购注销部分限制性股票减少注册资本暨通知债权人的公告"), true, "回购注销限制性股票属于资本事项流程");
  assert.equal(isRoutineFiling("某公司:2026年第一次临时股东会决议公告"), true, "股东会决议公告是例行文件");
  assert.equal(isRoutineFiling("某公司:关于回购公司股份方案的公告"), false, "股份回购方案仍是催化");
  assert.equal(isRoutineFiling("某公司:股东大会审议通过重大资产重组议案"), false, "重组决议不被例行降级");
  assert.equal(classifyEventCategory("某公司:2026年第一次临时股东会决议公告"), "other");
  assert.equal(classifyEventCategory("某公司:关于回购公司股份方案的公告"), "buyback");
});
