import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SentimentEvent, StockSnapshot } from "../src/domain/types.ts";

const at = "2026-08-25T07:00:00.000Z";

async function withAnalytics(run: (analytics: typeof import("./industryAnalytics.ts")) => void) {
  const directory = await mkdtemp(join(tmpdir(), "tide-industry-analytics-"));
  const previous = process.env.TIDE_DATABASE_PATH;
  process.env.TIDE_DATABASE_PATH = join(directory, "industry.sqlite");
  try {
    run(await import("./industryAnalytics.ts"));
  } finally {
    if (previous === undefined) delete process.env.TIDE_DATABASE_PATH;
    else process.env.TIDE_DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

const stock = (code: string, name: string): StockSnapshot => ({
  code, name, market: "沪市", price: 10, pctChange: 3, amount: 500_000_000,
  radarScore: null, textDirectionScore: null, alertScore: null, signal: "证据不足", analysisStatus: "scored",
  factors: { sentiment: 0, attention: 0, velocity: 0, consensus: 0, sourceQuality: 0, priceConfirm: 0, freshness: 0 },
  mentionCount: 0, mentionDelta: 0, topics: [], summary: "", sparkline: [], sentimentTrend: [], priceHistory: [], sourceMix: {}, asOf: at,
  industry: { code: "industry-electronics", name: "电子", parent: "电子", level: "行业", taxonomy: "东方财富行业", asOf: at },
});

const event = (overrides: Partial<SentimentEvent>): SentimentEvent => ({
  id: "event", title: "标题", category: "新闻事件", eventType: "未分类", publishedAt: "2026-08-25T06:00:00.000Z",
  source: "东方财富财经快讯", sourceKind: "news", tone: "positive", confidence: 80, heat: 60, summary: "", topics: [],
  relatedStocks: [], corroboration: 1, ...overrides,
});

test("attributes market-wide headlines that name the industry to that industry as industry-level news", async () => {
  await withAnalytics(({ buildIndustryAnalytics }) => {
    const result = buildIndustryAnalytics({
      stocks: [stock("600001", "示例一"), stock("600002", "示例二"), stock("600003", "示例三")],
      events: [event({ id: "sector", title: "电子板块午后走强 多只半导体个股拉升" })],
      asOf: at, tradeDate: "2026-08-25",
    });
    const pulse = result.items.find((item) => item.profile.name === "电子")!;
    assert.equal(pulse.newsEvidence.length, 1);
    assert.equal(pulse.newsEvidence[0]!.id, "sector");
    assert.equal(pulse.newsEvidence[0]!.scope, "industry", "标题直接点名行业的快讯属于行业级新闻");
    assert.ok(pulse.textHeat > 0, "行业级新闻进入行业舆情热度，而不是只挂在个股上");
  });
});

test("keeps company news as constituent evidence and never spreads it by body text alone", async () => {
  await withAnalytics(({ buildIndustryAnalytics }) => {
    const result = buildIndustryAnalytics({
      stocks: [stock("600001", "示例一"), stock("600002", "示例二"), stock("600003", "示例三")],
      events: [
        // 标题只说公司，行业只出现在摘要里：不得扩散成行业级新闻。
        event({
          id: "company", title: "示例一发布半年报", summary: "公司披露电子业务进展", relatedStocks: [{ code: "600001", name: "示例一", relevance: 96, reason: "线索源直接标注该股票", tone: "positive" }],
        }),
        // 公司公告即使标题提到行业，也不能按关键词扩散。
        event({
          id: "announcement", title: "示例二:关于电子业务进展的公告", category: "公司公告", sourceKind: "announcement", source: "上市公司公告",
          relatedStocks: [{ code: "600002", name: "示例二", relevance: 96, reason: "线索源直接标注该股票", tone: "neutral" }],
        }),
      ],
      asOf: at, tradeDate: "2026-08-25",
    });
    const pulse = result.items.find((item) => item.profile.name === "电子")!;
    assert.deepEqual(pulse.newsEvidence.map((item) => item.id).sort(), ["announcement", "company"], "成分股新闻与公告仍然属于行业舆情证据");
    assert.equal(pulse.newsEvidence.every((item) => item.scope === "constituent"), true, "只在正文提到行业、或本身就是公司公告的事件不得按关键词升级成行业级新闻");
  });
});

test("excludes forum posts from the industry news angle", async () => {
  await withAnalytics(({ buildIndustryAnalytics }) => {
    const result = buildIndustryAnalytics({
      stocks: [stock("600001", "示例一"), stock("600002", "示例二"), stock("600003", "示例三")],
      events: [event({
        id: "post", title: "电子这波怎么看", category: "用户讨论", sourceKind: "forum", source: "股吧",
        relatedStocks: [{ code: "600001", name: "示例一", relevance: 96, reason: "线索源直接标注该股票", tone: "positive" }],
      })],
      asOf: at, tradeDate: "2026-08-25",
    });
    const pulse = result.items.find((item) => item.profile.name === "电子")!;
    assert.deepEqual(pulse.newsEvidence, [], "行业舆情角度只读取新闻与公告，论坛讨论不计入");
    assert.equal(pulse.discussionCount, 1, "论坛讨论仍然计入行业讨论热度");
  });
});
