import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

type Database = typeof import("./database.ts");
const { DAILY_FOCUS_VERSION } = await import("./dailyCandidateStrategyV7.ts");

const at = (value: string) => new Date(value);
const cutoff = "2026-08-25T07:00:00.000Z"; // 15:00 Asia/Shanghai

async function withService(run: (service: any, database: Database, raw: DatabaseSync) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "tide-daily-candidate-service-"));
  const path = join(directory, "service.sqlite");
  const previous = process.env.TIDE_DATABASE_PATH;
  process.env.TIDE_DATABASE_PATH = path;
  let database: Database | null = null;
  let raw: DatabaseSync | null = null;
  try {
    database = await import(`./database.ts?daily-candidate-service=${Date.now()}`) as Database;
    raw = new DatabaseSync(path);
    // RED: this module deliberately does not exist until the production service is implemented.
    const service = await import("./dailyCandidateService.ts");
    const textSignals = (service as any).calculateCutoffTextSignals([
      { sourceKind: "announcement", tone: "positive", confidence: 100, publishedAt: "2026-08-24T13:00:00.000Z" },
      { sourceKind: "news", tone: "negative", confidence: 100, publishedAt: "2026-08-25T06:59:00.000Z" },
    ], cutoff);
    assert.ok(textSignals.textDirection < 50, "a fresh, high-quality contrary event outweighs an 18-hour-old event using the documented 12-hour half-life");
    const separatedConfidence = (service as any).calculateCutoffTextSignals([
      { sourceKind: "announcement", tone: "positive", confidence: 20, publishedAt: "2026-08-25T06:59:00.000Z" },
      { sourceKind: "forum", tone: "positive", confidence: 100, publishedAt: "2026-08-25T06:59:00.000Z" },
    ], cutoff);
    assert.equal(separatedConfidence.textConfidence, 79, "classification confidence is separately weighted for the strategy's text-confidence points");
    assert.equal(separatedConfidence.sourceQuality, 65, "source quality remains a distinct audit dimension");
    assert.deepEqual((service as any).calculateBoardLimitState({ code: "300001", name: "创业板示例", previousClose: 10, open: 12, high: 12, low: 11.2, price: 11.96 }), {
      limitPercent: null, reachedLimit: false, onePriceLimit: false, reopenedLimit: false,
    }, "an unknown board rule is not guessed from the code prefix and safely skips limit-state exclusions");
    assert.equal((service as any).calculateBoardLimitState({ code: "300001", name: "创业板示例", limitPercent: 20, previousClose: 10, open: 10, high: 12, low: 11.2, price: 11.7 }).reopenedLimit, false, "a limit hit that closes far from the limit is not a near-limit reopen");
    assert.equal((service as any).calculateBoardLimitState({ code: "600001", name: "显式限幅", limitPercent: 20, previousClose: 10, open: 10, high: 12, low: 11.2, price: 11.96 }).limitPercent, 20, "adapter board metadata overrides code-prefix fallback");
    assert.equal((service as any).calculateBoardLimitState({ code: "600001", name: "回封涨停", limitPercent: 10, previousClose: 10, open: 10.2, high: 11, low: 10.5, price: 11 }).reopenedLimit, true, "a reopened board that closes exactly at the limit still receives the overheat penalty");
    await run(service, database, raw);
  } finally {
    raw?.close();
    database?.closeDatabaseForTests();
    if (previous === undefined) delete process.env.TIDE_DATABASE_PATH;
    else process.env.TIDE_DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function insertQuote(raw: DatabaseSync, tradeDate: string, code: string, price: number, open = price, low = price * .98) {
  const id = `snapshot-${tradeDate}`;
  const historyIndex = Math.max(0, ["2026-08-19", "2026-08-20", "2026-08-21", "2026-08-24", "2026-08-25"].indexOf(tradeDate));
  raw.prepare(`INSERT OR IGNORE INTO market_quote_snapshots(id, provider, source_tier, endpoint, trade_date, quote_at, fetched_at, expected_count, row_count, status, error)
    VALUES (?, 'eastmoney', 'primary', 'fixture', ?, ?, ?, 4000, 4000, 'complete', NULL)`).run(id, tradeDate, `${tradeDate}T07:00:00.000Z`, `${tradeDate}T07:00:00.000Z`);
  raw.prepare(`INSERT INTO market_daily_quotes(code, trade_date, name, exchange, market, price, pct_change, open, high, low, previous_close, volume, amount, turnover, market_cap, listing_date, industry_name, quote_at, fetched_at, snapshot_id, provider, source_tier, quote_url)
    VALUES (?, ?, ?, 'SH', '沪市', ?, 5, ?, ?, ?, ?, 1, ?, 1, 1, '2020-01-01', '电子', ?, ?, ?, 'eastmoney', 'primary', '')
    ON CONFLICT(code, trade_date) DO UPDATE SET price=excluded.price, open=excluded.open, high=excluded.high, low=excluded.low, amount=excluded.amount`).run(code, tradeDate, `股票${code}`, price, open, price * 1.02, low, price * .95, 1000000000 * (1 + historyIndex * .06), `${tradeDate}T07:00:00.000Z`, `${tradeDate}T07:00:00.000Z`, id);
}

function prepareHistory(raw: DatabaseSync, codes = ["600001", "600002", "600003"]) {
  for (const date of ["2026-08-19", "2026-08-20", "2026-08-21", "2026-08-24", "2026-08-25"]) {
    const multiplier = ["2026-08-19", "2026-08-20", "2026-08-21", "2026-08-24", "2026-08-25"].indexOf(date);
    codes.forEach((code, index) => insertQuote(raw, date, code, 10 + index + multiplier * .2));
  }
}

function source(overrides: Record<string, unknown> = {}) {
  const recentTradeDates = Array.from({ length: 60 }, (_, index) => new Date(Date.UTC(2026, 6, 1 + index)).toISOString().slice(0, 10)).filter((date) => {
    const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    return day !== 0 && day !== 6;
  });
  const codes = ["600001", "600002", "600003"];
  const quotes = [...codes.map((code, index) => ({
    code, name: `股票${code}`, exchange: "SH", market: "沪市", price: 11 + index, pctChange: 5,
    open: 10 + index, high: 11.4 + index, low: 9.8 + index, previousClose: 10.5 + index,
    volume: 1, amount: 1500000000, turnover: 2, marketCap: 1, listingDate: "2020-01-01", industryName: "电子", limitPercent: 10,
    quoteAt: cutoff, tradeDate: "2026-08-25", quoteUrl: "", provider: "eastmoney", sourceTier: "primary",
  })), {
    code: "600004", name: "市场参考", exchange: "SH", market: "沪市", price: 10, pctChange: -5,
    open: 10, high: 10.2, low: 9.8, previousClose: 10.5, volume: 1, amount: 220000000, turnover: 2, marketCap: 1, listingDate: "2020-01-01", industryName: "电子", limitPercent: 10,
    quoteAt: cutoff, tradeDate: "2026-08-25", quoteUrl: "", provider: "eastmoney", sourceTier: "primary",
  }];
  const stocks = codes.map((code, index) => ({
    code, name: `股票${code}`, market: "沪市", price: 11 + index, pctChange: 5, amount: 220000000,
    radarScore: 90, textDirectionScore: 75, alertScore: 10, signal: "偏多共振", analysisStatus: "scored",
    factors: { sentiment: 60, attention: 90, velocity: 90, consensus: 90, sourceQuality: 90, priceConfirm: 90, freshness: 90 },
    mentionCount: 12, mentionDelta: 4, topics: ["芯片"], summary: "", sparkline: [], sentimentTrend: [], priceHistory: [],
    sourceMix: { 新闻: 50, 股吧: 50 }, asOf: cutoff, industry: { code: "industry-electronics", name: "电子", parent: "电子", level: "行业", taxonomy: "东方财富行业", asOf: cutoff },
  }));
  const events = codes.flatMap((code, index) => [
    { id: `news-${code}`, title: "利好", category: "新闻事件", eventType: "公司", publishedAt: "2026-08-25T06:50:00.000Z", source: "新闻", sourceKind: "news", url: `https://evidence.example.test/${code}`, adapterId: "eastmoney-announcements", tone: "positive", confidence: 90, heat: 90, summary: "", topics: ["芯片"], relatedStocks: [{ code, name: `股票${code}`, relevance: 90, reason: "", tone: "positive" }], corroboration: 2 },
    { id: `forum-${code}`, title: "讨论", category: "用户讨论", eventType: "公司", publishedAt: "2026-08-25T06:55:00.000Z", source: "股吧", sourceKind: "forum", adapterId: "authorized-forum", tone: "positive", confidence: 70, heat: 80, summary: "", topics: ["芯片"], relatedStocks: [{ code, name: `股票${code}`, relevance: 90, reason: "", tone: "positive" }], corroboration: 1 },
  ]);
  const historicalDates = recentTradeDates.filter((date) => date < "2026-08-25").slice(-5);
  const discussionWindowsByCode = Object.fromEntries([...codes, "600004"].map((code) => [code, historicalDates.map((tradeDate, index) => {
    const previous = recentTradeDates.filter((date) => date < tradeDate).at(-1)!;
    return {
      code, count: 2 + index, interactions: 10 + index, elapsedMinutes: 240, verified: true as const,
      sourceId: "authorized-forum", adapterId: "authorized-forum", state: "connected" as const, tradeDate, featureStart: `${previous}T07:00:00.000Z`, featureCutoff: `${tradeDate}T07:00:00.000Z`,
      queryFrom: `${previous}T07:00:00.000Z`, queryTo: `${tradeDate}T07:00:00.000Z`, coveredThrough: `${tradeDate}T07:00:00.000Z`, coveredCodes: [...codes, "600004"], cursorExhausted: true as const,
    };
  })]));
  return {
    quotes, stocks, events, tradeDate: "2026-08-25", marketAsOf: cutoff, clueAsOf: cutoff, marketStale: false,
    clueFailures: [], discussionSources: [{ id: "eastmoney-guba", name: "股吧", state: "connected", detail: "fixture", count: 3, coveredThrough: cutoff }],
    sourceStates: [
      { id: "authorized-forum", role: "discussion", state: "connected", coveredThrough: cutoff, observedAt: cutoff, queryFrom: "2026-08-24T07:00:00.000Z", queryTo: cutoff, coveredCodes: codes, eventIds: codes.map((code) => `forum-${code}`) },
      { id: "eastmoney-announcements", role: "authority", state: "connected", coveredThrough: cutoff, observedAt: cutoff, queryFrom: "2026-08-24T07:00:00.000Z", queryTo: cutoff, coveredCodes: [], eventIds: codes.map((code) => `news-${code}`) },
    ],
    previousTradeDate: "2026-08-24", recentTradeDates,
    discussionWindowsByCode,
    marketComplete: true, isTradingDay: true,
    ...overrides,
  };
}

test("daily candidate service previews, freezes once, and records unavailable deadlines deterministically", async () => {
  await withService(async (service, database, raw) => {
    const eastMoney = await import("./eastMoney.ts");
    const { buildLiveClueSourceState, parseEastMoneyTimestamp } = eastMoney;
    const { fetchAuthorizedForumClues } = await import("./forumFeed.ts");
    const radar = await import("./radarEngine.ts");
    assert.deepEqual((eastMoney as any).announcementQueryDates("2026-08-31", "2026-08-28"), { beginTime: "2026-08-28", endTime: "2026-08-31" }, "Monday authority coverage starts from the previous trading day, not Sunday");
    assert.equal(
      (radar as any).dailyDiscussionQueryFrom("2026-08-25", ["2026-08-25", "2026-08-24", "2026-08-21", "2026-08-20", "2026-08-19", "2026-08-18", "2026-08-17"]),
      "2026-08-17T07:00:00.000Z",
      "live discussion fetch starts at D-6 close so all five prior same-minute windows can be reconstructed",
    );
    assert.equal((radar as any).shouldUseFullMarketRefresh(at("2026-08-25T07:10:00.000Z")), true, "15:00-15:30 close-finalization window keeps fetching full market data");
    assert.equal((radar as any).shouldUseFullMarketRefresh(at("2026-08-25T07:31:00.000Z")), false, "ordinary post-close refreshes return to the stored-market path after the decision deadline");
    const previewWithoutLocalAmountHistory = service.buildDailyCandidatePreview(source(), at("2026-08-25T07:00:00.000Z"));
    assert.equal(previewWithoutLocalAmountHistory.items.length, 0, "a live preview with complete quotes and discussion evidence still has no candidates until five-day amount history is available");
    const fallbackSource = source();
    const lowAmountQuote = { ...fallbackSource.quotes[0], code: "001306", name: "低成交样本", exchange: "SZ", market: "深市", amount: 17_000_000, pctChange: 9 };
    const beijingQuote = { ...fallbackSource.quotes[0], code: "830001", name: "北交样本", exchange: "BJ", market: "北交所", amount: 5_000_000_000, pctChange: 15 };
    const highSignalStock = { ...fallbackSource.stocks[0], code: "001306", name: "低成交样本", textDirectionScore: 100, mentionCount: 999 };
    const beijingStock = { ...fallbackSource.stocks[0], code: "830001", name: "北交样本", textDirectionScore: 100, mentionCount: 999 };
    const liveFallback = (radar as any).buildLiveFocusFallback({
      quotes: [...fallbackSource.quotes, lowAmountQuote, beijingQuote],
      stocks: [...fallbackSource.stocks, highSignalStock, beijingStock],
      tradeDate: "2026-08-25",
    });
    assert.deepEqual(liveFallback.map((item: any) => item.code), ["600001", "600002", "600003", "600004"], "the current-day page retains a ranked live focus list while formal history is missing");
    assert.equal(liveFallback.every((item: any) => item.state === "awaiting-history"), true);
    assert.equal(liveFallback.every((item: any) => item.amount >= 100_000_000), true, "the provisional list uses the same minimum turnover gate as formal daily focus");
    assert.equal(liveFallback.some((item: any) => item.code === "830001"), false, "Beijing Stock Exchange instruments stay outside the all-A-share universe");
    assert.equal(liveFallback.every((item: any) => item.scores.turnover >= 0 && item.scores.turnover <= 30), true, "turnover contributes exactly a maximum of 30 points to provisional ranking");
    assert.equal(liveFallback.every((item: any) => Math.abs(Object.values(item.scores).reduce((sum: number, score: any) => sum + score, 0) - item.liveScore) < 0.001), true, "published provisional score components reproduce the ranking score");
    const requestedHistoryCodes: string[] = [];
    const dates = ["2026-08-19", "2026-08-20", "2026-08-21", "2026-08-24", "2026-08-25"];
    const previewWithRemoteAmountHistory = await (radar as any).buildDailyCandidatePreviewWithHistory(source(), at("2026-08-25T07:00:00.000Z"), async ({ code }: { code: string }) => {
      requestedHistoryCodes.push(code);
      return {
        provider: "eastmoney", endpoint: "fixture", code, name: `股票${code}`, exchange: "SH", adjustment: "none", fetchedAt: cutoff,
        items: dates.map((tradeDate, index) => ({ code, name: `股票${code}`, exchange: "SH", tradeDate, open: 10, high: 10.5, low: 9.8, close: 10.2, volume: 1, amount: 1_000_000_000 * (1 + index * .06), amplitude: null, pctChange: 2, change: .2, turnover: 1, adjustment: "none", provider: "eastmoney", fetchedAt: cutoff })),
      };
    });
    assert.deepEqual(requestedHistoryCodes.sort(), ["600001", "600002", "600003"], "only current high-quality candidate stocks request online history");
    assert.equal(previewWithRemoteAmountHistory.items.length, 3, "online daily-bar history supplies the five-day amount baseline needed for an intraday preview");
    prepareHistory(raw);
    assert.equal(parseEastMoneyTimestamp("not-a-timestamp"), null, "invalid source timestamps are discarded rather than rewritten to now");
    assert.equal(database.getRecentAmounts(["600001"], 5, "2026-08-25").get("600001")?.length, 5);
    for (let day = 1; day <= 31; day += 1) insertQuote(raw, `2026-01-${String(day).padStart(2, "0")}`, "600099", day, day, day * .95);
    const boundedAmounts = database.getRecentAmounts(["600099"], 5, "2026-01-31").get("600099")!;
    const boundedReturns = database.getRecentPctChanges(["600099"], 3, "2026-01-31").get("600099")!;
    assert.deepEqual(boundedAmounts.map((point) => point.tradeDate), ["2026-01-27", "2026-01-28", "2026-01-29", "2026-01-30", "2026-01-31"], "large history is bounded to each code's N most-recent rows in ascending order");
    assert.deepEqual(boundedReturns.map((point) => point.tradeDate), ["2026-01-29", "2026-01-30", "2026-01-31"]);
    for (const invalidDays of [-1, 0, Number.NaN, 2.5, 367]) {
      assert.throws(() => database.getRecentAmounts(["600099"], invalidDays), /days/i);
      assert.throws(() => database.getRecentPctChanges(["600099"], invalidDays), /days/i);
    }
    const preview = service.buildDailyCandidatePreview(source(), at("2026-08-25T07:00:00.000Z"));
    assert.equal(preview.status, "preview");
    assert.equal(preview.items.length, 3, JSON.stringify({ reason: preview.reason, exclusions: preview.exclusionCounts }));
    assert.equal(database.getDailyCandidateList("2026-08-25"), null, "preview must not persist");
    const shortLocalCalendar = source().recentTradeDates.filter((date: string) => date <= "2026-08-25").slice(-7);
    const shortHistoryPreview = service.buildDailyCandidatePreview(source({ recentTradeDates: shortLocalCalendar }), at("2026-08-25T07:00:00.000Z"));
    assert.equal(shortHistoryPreview.items.length, 3, "listing age is derived from the verified exchange calendar, not the number of locally stored market days");

    const intradayCutoff = "2026-08-25T02:00:00.000Z";
    const intradayWindows = Object.fromEntries(Object.entries(source().discussionWindowsByCode).map(([code, windows]: [string, any]) => [code, windows.map((window: any) => ({
      ...window,
      elapsedMinutes: 30,
      featureCutoff: `${window.tradeDate}T02:00:00.000Z`,
      count: 0,
      interactions: 0,
    }))]));
    const intradayEvents = source().events.map((event: any, index: number) => ({ ...event, publishedAt: `2026-08-25T01:${index % 2 ? "55" : "50"}:00.000Z` }));
    const intradayPreview = service.buildDailyCandidatePreview(source({
      marketAsOf: intradayCutoff,
      clueAsOf: intradayCutoff,
      quotes: source().quotes.map((quote: any) => ({ ...quote, quoteAt: intradayCutoff })),
      events: intradayEvents,
      discussionWindowsByCode: intradayWindows,
    }), at(intradayCutoff));
    assert.equal(intradayPreview.featureCutoff, intradayCutoff);
    assert.equal((intradayPreview.items[0]?.snapshot as any)?.discussionElapsedMinutes, 30, "10:00 preview compares thirty trading minutes rather than a full 240-minute session");
    const earliestComparableStart = `${source().recentTradeDates.filter((date: string) => date < "2026-08-25").slice(-6)[0]}T07:00:00.000Z`;
    const productionIntradayPreview = service.buildDailyCandidatePreview(source({
      marketAsOf: intradayCutoff,
      clueAsOf: intradayCutoff,
      quotes: source().quotes.map((quote: any) => ({ ...quote, quoteAt: intradayCutoff })),
      events: intradayEvents,
      discussionWindowsByCode: undefined,
      sourceStates: source().sourceStates.map((state: any) => ({
        ...state,
        queryFrom: earliestComparableStart,
        queryTo: intradayCutoff,
        coveredThrough: intradayCutoff,
      })),
    }), at(intradayCutoff));
    assert.equal(productionIntradayPreview.items.length, 3, "a range-proven live forum response rebuilds five same-minute baselines without test-only injected windows");
    assert.equal(
      (productionIntradayPreview.items[0]?.snapshot as any)?.discussionHistory?.every((window: any) => window.elapsedMinutes === 30),
      true,
      "derived production baselines preserve the intraday elapsed-minute audit",
    );
    assert.equal(service.maybeFreezeDailyCandidates(source(), at("2026-08-25T06:59:00.000Z")), null, "before close only previews");

    const verifiedRange = { queryFrom: "2026-08-24T07:00:00.000Z", queryTo: cutoff };
    const originalFetch = globalThis.fetch;
    const originalForumUrl = process.env.FORUM_FEED_URL;
    let requestedForumUrl = "";
    let forumRange: { kind: "server-window-paginated"; queryFrom: string; queryTo: string; cursorExhausted: boolean } | null = null;
    try {
      process.env.FORUM_FEED_URL = "https://forum.example.test/feed";
      globalThis.fetch = (async (input: string | URL | Request) => {
        requestedForumUrl = String(input);
        return new Response(JSON.stringify({
          schema_version: "1.0", source: { id: "licensed-forum", name: "授权讨论", license_id: "license", terms_url: "https://forum.example.test/terms" },
          coverage: { query_from: verifiedRange.queryFrom, query_to: verifiedRange.queryTo, cursor_exhausted: true, stock_codes: ["600001"] },
          items: [{ id: "at-cutoff", title: "截止讨论", published_at: cutoff, permalink: "https://forum.example.test/post/1" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      forumRange = (await fetchAuthorizedForumClues(["600001"], verifiedRange)).range;
    } finally {
      globalThis.fetch = originalFetch;
      if (originalForumUrl === undefined) delete process.env.FORUM_FEED_URL;
      else process.env.FORUM_FEED_URL = originalForumUrl;
    }
    assert.equal(new URL(requestedForumUrl).searchParams.get("published_from"), verifiedRange.queryFrom, "authorized forum receives the server-side lower bound");
    assert.equal(new URL(requestedForumUrl).searchParams.get("published_to"), verifiedRange.queryTo, "authorized forum receives the server-side upper bound");
    assert.deepEqual(forumRange, { kind: "server-window-paginated", ...verifiedRange, cursorExhausted: true, coveredCodes: ["600001"] }, "only an echoed exhausted cursor and per-code coverage prove the forum window");
    const serverRangeProof = forumRange!;
    const unprovedFirstPage = buildLiveClueSourceState({
      id: "user-discussions", role: "discussion", fulfilled: true, observedAt: "2026-08-25T07:05:00.000Z", ...verifiedRange,
      items: [{ id: "first-page-at-cutoff", source: "股吧", sourceKind: "forum", title: "首屏讨论", summary: "", publishedAt: cutoff, url: "", stockCodes: [], interactionCount: 0 }],
    });
    assert.equal(unprovedFirstPage.queryFrom, null, "a first page without server range/cursor proof cannot claim lower-bound coverage");
    assert.equal(unprovedFirstPage.coveredThrough, null);
    const postRange = buildLiveClueSourceState({
      id: "eastmoney-stock-news", role: "authority", fulfilled: true, observedAt: "2026-08-25T07:05:00.000Z", ...verifiedRange, rangeProof: serverRangeProof,
      items: [{ id: "post-range", source: "新闻", sourceKind: "news", title: "范围外", summary: "", publishedAt: "2026-08-25T07:05:00.000Z", url: "", stockCodes: [], interactionCount: 0 }],
    });
    assert.equal(postRange.coveredThrough, null, "a post-range response item cannot prove coverage");
    const provenOldContent = buildLiveClueSourceState({
      id: "authorized-forum", role: "discussion", fulfilled: true, observedAt: "2026-08-25T07:05:00.000Z", ...verifiedRange, rangeProof: serverRangeProof,
      items: [{ id: "old-discussion", source: "股吧", sourceKind: "forum", title: "陈旧讨论", summary: "", publishedAt: "2026-08-25T06:59:00.000Z", url: "", stockCodes: [], interactionCount: 0 }],
    });
    assert.equal(provenOldContent.coveredThrough, cutoff, "an exhausted server query proves its upper boundary even when its newest content is older");
    assert.equal((provenOldContent as any).latestContentAt, "2026-08-25T06:59:00.000Z", "content recency remains separately auditable from the proved query boundary");
    const adapterItems = (sourceKind: "news" | "forum") =>
      source().events.filter((event: any) => event.sourceKind === sourceKind).map((event: any) => ({ id: event.id, source: event.source, sourceKind, title: event.title, summary: event.summary, publishedAt: event.publishedAt, url: "", stockCodes: event.relatedStocks.map((stock: any) => stock.code), interactionCount: event.heat }));
    const fullRangeProof = { ...serverRangeProof, coveredCodes: ["600001", "600002", "600003"] };
    const staleResponseStates = [
      buildLiveClueSourceState({ id: "authorized-forum", role: "discussion", fulfilled: true, observedAt: "2026-08-25T07:05:00.000Z", ...verifiedRange, rangeProof: fullRangeProof, items: adapterItems("forum") }),
      buildLiveClueSourceState({ id: "eastmoney-announcements", role: "authority", fulfilled: true, observedAt: "2026-08-25T07:05:00.000Z", ...verifiedRange, rangeProof: serverRangeProof, items: adapterItems("news") }),
    ];
    assert.equal(staleResponseStates[0]!.coveredThrough, cutoff, "a 15:05 response with only older content still proves its exhausted query boundary");
    // The live radar collector writes only a source's own range-proofed window.
    // Historical rows below model prior daily raw snapshots / first-class aggregates;
    // they are deliberately not injected into the candidate source.
    const partialCoverageState = buildLiveClueSourceState({
      id: "authorized-forum", role: "discussion", fulfilled: true, observedAt: "2026-08-25T07:05:00.000Z", ...verifiedRange,
      rangeProof: { ...serverRangeProof, coveredCodes: ["600001"] } as any,
      items: adapterItems("forum"),
    });
    (radar as any).persistCurrentDiscussionWindows(
      { items: source().quotes, tradeDate: "2026-08-25" },
      { items: adapterItems("forum").map((item: any) => ({ ...item, adapterId: "authorized-forum" })), sourceStates: [partialCoverageState] },
    );
    assert.deepEqual(Object.keys(database.getDailyDiscussionWindows(["2026-08-25"])), ["600001"], "a partial source coverage proof never fabricates zero discussion rows for uncovered codes");
    const partialCoverageCandidateSource = (radar as any).buildDailyCandidateSourceFromRadar({
      market: { items: source().quotes, updatedAt: cutoff, tradeDate: "2026-08-25", stale: false },
      clues: { updatedAt: cutoff, failures: [], sourceStates: [partialCoverageState, staleResponseStates[1]], discussionSources: source().discussionSources },
      stocks: source().stocks, events: source().events, tradeDates: source().recentTradeDates,
    });
    const partialCoveragePreview = service.buildDailyCandidatePreview({ ...partialCoverageCandidateSource, marketComplete: true }, at("2026-08-25T07:10:00.000Z"));
    assert.equal(partialCoveragePreview.items.length, 3, "partial discussion coverage lowers evidence scores without erasing market-qualified stocks");
    assert.equal((partialCoveragePreview.dataQuality as any).discussionBaseline, "unavailable", "partial coverage never manufactures five historical zero windows");
    assert.equal(database.getDailyCandidateList("2026-08-25"), null, "a preview remains non-persistent until the explicit freeze call");
    (radar as any).persistCurrentDiscussionWindows(
      { items: source().quotes, tradeDate: "2026-08-25" },
      { items: adapterItems("forum").map((item: any) => ({ ...item, adapterId: "authorized-forum" })), sourceStates: staleResponseStates },
    );
    const liveWindow = database.getDailyDiscussionWindows(["2026-08-25"])["600001"]?.[0];
    assert.deepEqual(
      { tradeDate: liveWindow?.tradeDate, sourceId: liveWindow?.sourceId, count: liveWindow?.count, cursorExhausted: liveWindow?.cursorExhausted },
      { tradeDate: "2026-08-25", sourceId: "authorized-forum", count: 1, cursorExhausted: true },
      "radar collection persists the authenticated current discussion window with its source proof",
    );
    database.saveDailyDiscussionWindows(Object.values(source().discussionWindowsByCode).flat());
    const radarSource = (radar as any).buildDailyCandidateSourceFromRadar({
      market: { items: source().quotes, updatedAt: cutoff, tradeDate: "2026-08-25", stale: false },
      clues: { updatedAt: cutoff, failures: [], sourceStates: staleResponseStates, discussionSources: source().discussionSources },
      stocks: source().stocks,
      events: [...source().events, { ...source().events[0], id: "after-close", publishedAt: "2026-08-25T07:05:00.000Z" }],
      tradeDates: source().recentTradeDates,
    });
    assert.deepEqual(radarSource.sourceStates, staleResponseStates, "radar bridge preserves adapter watermarks exactly");
    assert.equal(radarSource.discussionWindowsByCode["600001"].length, 5, "radar rebuilds comparable discussion windows from persisted provenance rather than caller injection");
    const frozen = service.maybeFreezeDailyCandidates({ ...radarSource, marketComplete: true }, at("2026-08-25T07:10:00.000Z"));
    assert.equal(frozen.status, "frozen");
    assert.equal(frozen.items.some((item: any) => item.snapshot?.events?.some((event: any) => event.id === "after-close")), false, "post-15:00 clues cannot enter frozen features");
    assert.equal(frozen.items[0]?.snapshot?.events?.some((event: any) => event.url === "https://evidence.example.test/600001"), true, "frozen audit preserves original evidence permalink for the UI");
    const first = database.getDailyCandidateList("2026-08-25");
    assert.equal(first?.origin, "prospective");
    assert.deepEqual((first?.dataQuality as any).sourceStates, staleResponseStates, "frozen list audits immutable per-source watermarks");
    assert.ok((first?.methodology as any).referenceAudit.market.amount.sampleSize >= 3, "frozen methodology retains the percentile reference audit needed to reproduce scores");
    assert.ok((first?.methodology as any).selectionDiagnostics, "frozen methodology retains quota and fallback selection diagnostics");
    assert.deepEqual(
      Object.keys(((first?.items[0]?.snapshot as any).events[0] ?? {})).filter((key) => ["title", "tone", "confidence", "heat"].includes(key)).sort(),
      ["confidence", "heat", "title", "tone"],
      "frozen evidence retains the original classification inputs, not only ids and links",
    );
    assert.equal(service.maybeFreezeDailyCandidates(source({ marketAsOf: "2026-08-25T07:20:00.000Z" }), at("2026-08-25T07:20:00.000Z"))?.frozenAt, first?.frozenAt, "retries must not overwrite frozen payload");

    assert.equal(service.maybeFreezeDailyCandidates(source({ tradeDate: "2026-08-30", isTradingDay: false }), at("2026-08-30T07:10:00.000Z")), null, "holiday is skipped");

    const cleanPreview = service.buildDailyCandidatePreview(source(), at("2026-08-25T07:10:00.000Z"));
    const verifiedDiscussionGrowth = (cleanPreview.items.find((item: any) => item.code === "600001") as any)?.snapshot.discussionGrowth;
    assert.equal(verifiedDiscussionGrowth.isComparable, true, "a frozen candidate carries the real five-window comparable discussion baseline");
    assert.equal(verifiedDiscussionGrowth.mentionDelta, -3, "mention delta uses the verified five-window median rather than a synthetic zero baseline");
    const withBeijingOutlier = service.buildDailyCandidatePreview(source({
      quotes: [...source().quotes, { ...source().quotes[0], code: "830001", name: "北交所离群", exchange: "BJ", market: "北交所", pctChange: -80 }],
    }), at("2026-08-25T07:10:00.000Z"));
    assert.equal(
      (withBeijingOutlier.items.find((item: any) => item.code === "600001") as any)?.snapshot.marketExcess,
      (cleanPreview.items.find((item: any) => item.code === "600001") as any)?.snapshot.marketExcess,
      "market excess ignores non-SH/SZ benchmark rows",
    );
    const postPreviousCloseDiscussion = { ...source().events.find((event: any) => event.id === "forum-600001"), id: "forum-prev-close-600001", publishedAt: "2026-08-24T07:00:00.001Z" };
    const formalDiscussionPreview = service.buildDailyCandidatePreview(source({
      events: [...source().events, postPreviousCloseDiscussion],
      sourceStates: source().sourceStates.map((state: any) => state.id === "authorized-forum" ? { ...state, eventIds: [...state.eventIds, postPreviousCloseDiscussion.id] } : state),
    }), at("2026-08-25T07:10:00.000Z"));
    assert.equal(
      (formalDiscussionPreview.items.find((item: any) => item.code === "600001") as any)?.snapshot.discussionCount,
      (cleanPreview.items.find((item: any) => item.code === "600001") as any)?.snapshot.discussionCount + 1,
      "discussion uses the formal previous-close-to-close window, not only the same-day session",
    );
    assert.equal((cleanPreview.dataQuality as any).discussionBaseline, "verified", "five injected, provenance-verified comparable windows make the discussion baseline auditable");
    const partialCurrentCoverage = service.buildDailyCandidatePreview(source({
      sourceStates: source().sourceStates.map((state: any) => state.role === "discussion" ? { ...state, coveredCodes: ["600001"] } : state),
    }), at("2026-08-25T07:10:00.000Z"));
    assert.deepEqual(partialCurrentCoverage.items.map((item: any) => item.code), ["600001", "600002", "600003"], "discussion coverage changes evidence scores without shrinking the market-qualified pool");
    assert.equal((partialCurrentCoverage.items.find((item: any) => item.code === "600001") as any)?.snapshot.discussionCount, 1);
    assert.equal((partialCurrentCoverage.items.find((item: any) => item.code === "600002") as any)?.snapshot.discussionCount, 0, "uncovered discussion is retained as missing evidence, not fabricated activity");
    const unstableNews = { ...source().events.find((event: any) => event.id === "news-600001"), id: "", url: "" };
    const duplicateUnstableNews = { ...unstableNews };
    const independentUnstableNews = { ...unstableNews, source: "转载新闻" };
    const dedupedPreview = service.buildDailyCandidatePreview(source({
      events: [...source().events.filter((event: any) => event.id !== "news-600001"), unstableNews, duplicateUnstableNews, independentUnstableNews],
      sourceStates: source().sourceStates.map((state: any) => state.id === "eastmoney-announcements" ? { ...state, eventIds: state.eventIds.map((id: string) => id === "news-600001" ? "" : id) } : state),
    }), at("2026-08-25T07:10:00.000Z"));
    const dedupedAudit = (dedupedPreview.items.find((item: any) => item.code === "600001") as any)?.snapshot;
    assert.equal(dedupedAudit.independentEvents, 3, "fallback dedupe retains different-source no-ID evidence as independent events");
    assert.equal(dedupedAudit.sourceCount, 3, "fallback dedupe retains different-source provenance");
    assert.equal(dedupedAudit.duplicateRatio, .25, "duplicate ratio is derived from authorized evidence before and after stable fallback dedupe");
    const pollutedPreview = service.buildDailyCandidatePreview(source({
      stocks: source().stocks.map((stock: any) => ({ ...stock, analysisStatus: "no_clues", textDirectionScore: 0, mentionCount: 999, factors: { ...stock.factors, freshness: 0 } })),
      events: [
        ...source().events,
        { ...source().events[0], id: "previous-window", publishedAt: "2026-08-24T06:59:59.999Z" },
        { ...source().events[0], id: "post-close-pollution", publishedAt: "2026-08-25T07:05:00.000Z" },
      ],
    }), at("2026-08-25T07:10:00.000Z"));
    assert.deepEqual(pollutedPreview.items, cleanPreview.items, "cutoff rebuild ignores post-close stock aggregates and out-of-window clues");
    for (const [date, price] of [["2026-08-26", 10], ["2026-08-27", 10.5], ["2026-08-28", 11]] as const) {
      ["600001", "600002", "600003", "600004"].forEach((code, index) => insertQuote(raw, date, code, price + index, price + index, price * .95));
    }
    assert.deepEqual(database.getTradeDatesAfter("2026-08-25", 3), ["2026-08-26", "2026-08-27", "2026-08-28"]);
    const verifiedTrend = service.withNextTradingDayTrends("2026-08-25", database.getDailyCandidateList("2026-08-25")!.items)[0]?.nextDayTrend;
    assert.deepEqual(
      { label: verifiedTrend?.label, target: verifiedTrend?.targetTradeDate, status: verifiedTrend?.actual?.status, phase: verifiedTrend?.actual?.phase },
      { label: "强看涨", target: "2026-08-26", status: "matched", phase: "closed" },
      "the frozen bullish signal is joined to the next session only after that session's quote exists",
    );
    raw.prepare("UPDATE market_daily_quotes SET quote_at = '2026-08-28T06:59:00.000Z' WHERE trade_date = '2026-08-28'").run();
    assert.equal(service.settleDailyCandidateOutcomes("2026-08-28"), 0, "T+3 intraday quotes must never become an immutable close outcome");
    assert.equal(database.getObservingDailyCandidateOutcomes().length, 3, "T+3 remains observing until the close watermark is proven");
    raw.prepare("UPDATE market_daily_quotes SET quote_at = '2026-08-28T07:00:00.000Z' WHERE trade_date = '2026-08-28'").run();
    const settled = service.settleDailyCandidateOutcomes("2026-08-28");
    assert.equal(settled, 3, JSON.stringify(raw.prepare("SELECT code, status, reason, coverage FROM daily_candidate_outcomes").all()));
    assert.equal((raw.prepare("SELECT COUNT(*) AS count FROM daily_candidate_outcomes WHERE data_as_of IS NOT NULL").get() as { count: number }).count, 3, "terminal outcomes retain their market data watermark");
    assert.deepEqual(service.getDailyCandidatePerformance(20).sampleDays, 1, "rolling performance counts only completed prospective frozen days");
    const completed = database.getObservingDailyCandidateOutcomes();
    assert.equal(completed.length, 0);

    database.saveDailyCandidateList({
      tradeDate: "2026-08-20", methodologyVersion: "daily-focus-v1", status: "frozen", origin: "prospective", featureCutoff: "2026-08-20T07:00:00.000Z",
      marketAsOf: cutoff, clueAsOf: cutoff, frozenAt: cutoff, universeCount: 10, eligibleCount: 3, selectedCount: 3, methodology: {}, dataQuality: {}, exclusionCounts: {}, reason: null,
      benchmarkMembers: Array.from({ length: 10 }, (_, index) => ({ code: `6010${String(index).padStart(2, "0")}`, industryCode: "i", industryName: "电子" })),
      items: ["601000", "601001", "601002"].map((code, index) => ({ code, rank: index + 1, grade: "A" as const, isHotIndustry: true, baseScore: 80, overheatPenalty: 0, finalScore: 80, scores: {}, snapshot: {}, reasons: [] })),
    });
    ["2026-08-21", "2026-08-24", "2026-08-25"].forEach((date, index) => ["601000", "601001", "601002", "601003", "601004", "601005", "601006", "601007"].forEach((code) => insertQuote(raw, date, code, 10 + index)));
    assert.equal(service.settleDailyCandidateOutcomes("2026-08-25"), 3);
    const coverageUnavailable = database.getObservingDailyCandidateOutcomes();
    assert.equal(coverageUnavailable.length, 0, "coverage failures are finalized unavailable, not left observing");

    const tradeDate = "2026-09-02";
    for (const [date, amount] of [["2026-08-31", 1_100_000_000], ["2026-09-01", 1_200_000_000], [tradeDate, 1_300_000_000]] as const) {
      ["600001", "600002", "600003"].forEach((code, index) => insertQuote(raw, date, code, 12 + index));
      raw.prepare("UPDATE market_daily_quotes SET amount = ? WHERE trade_date = ? AND code IN ('600001', '600002', '600003')").run(amount, date);
    }
    const degradedMarketSource = source({
      tradeDate,
      marketAsOf: `${tradeDate}T07:25:00.000Z`,
      clueAsOf: `${tradeDate}T07:25:00.000Z`,
      marketStale: true,
      quotes: source().quotes.map((quote: any) => ({
        ...quote,
        tradeDate,
        quoteAt: `${tradeDate}T06:59:00.000Z`,
        limitPercent: null,
      })),
      events: [],
      sourceStates: [],
      discussionSources: [],
      discussionWindowsByCode: undefined,
    });
    database.saveDailyCandidateList({
      tradeDate,
      methodologyVersion: "daily-focus-v2",
      status: "unavailable",
      origin: "prospective",
      featureCutoff: `${tradeDate}T07:00:00.000Z`,
      marketAsOf: `${tradeDate}T07:25:00.000Z`,
      clueAsOf: `${tradeDate}T07:25:00.000Z`,
      frozenAt: `${tradeDate}T07:30:00.000Z`,
      universeCount: degradedMarketSource.quotes.length,
      eligibleCount: 0,
      selectedCount: 0,
      methodology: { version: "daily-focus-v2" },
      dataQuality: { boardLimitMetadata: "incomplete" },
      exclusionCounts: {},
      reason: "候选市场缺少可审计的涨跌停规则元数据",
      benchmarkMembers: [],
      items: [],
    });
    const recoveredFrozen = service.maybeFreezeDailyCandidates(degradedMarketSource, at(`${tradeDate}T07:31:00.000Z`));
    assert.equal(recoveredFrozen?.methodologyVersion, DAILY_FOCUS_VERSION, "the current methodology can recover a prior empty unavailable record");
    assert.equal(recoveredFrozen?.status, "frozen", "a complete post-close all-market batch freezes even when its wall-clock cache, text sources, and board metadata are degraded");
    assert.equal(recoveredFrozen?.items.length, 3, "market-qualified stocks freeze without requiring text or discussion coverage");
    assert.equal((recoveredFrozen?.dataQuality as any).market, "close-complete-stored");
    assert.equal((recoveredFrozen?.dataQuality as any).boardLimitMetadata, "unavailable");
    assert.equal((recoveredFrozen?.dataQuality as any).discussion, "degraded");
    assert.equal((recoveredFrozen?.dataQuality as any).authority, "degraded");
    assert.equal((recoveredFrozen?.items[0]?.snapshot as any).industry?.name, "电子", "market-source industry remains available when text and discussion sources are degraded");
    const repeated = service.maybeFreezeDailyCandidates(degradedMarketSource, at(`${tradeDate}T08:00:00.000Z`));
    assert.equal(repeated?.frozenAt, recoveredFrozen?.frozenAt, "retries never rewrite an existing frozen list");

    const delayedTradeDate = "2026-09-03";
    ["600001", "600002", "600003"].forEach((code, index) => insertQuote(raw, delayedTradeDate, code, 12.5 + index));
    raw.prepare("UPDATE market_daily_quotes SET amount = 1400000000 WHERE trade_date = ? AND code IN ('600001', '600002', '600003')").run(delayedTradeDate);
    const delayedSource = source({
      ...degradedMarketSource,
      tradeDate: delayedTradeDate,
      previousTradeDate: tradeDate,
      marketAsOf: `${delayedTradeDate}T07:25:00.000Z`,
      clueAsOf: `${delayedTradeDate}T07:25:00.000Z`,
      quotes: degradedMarketSource.quotes.map((quote: any) => ({ ...quote, tradeDate: delayedTradeDate, quoteAt: `${delayedTradeDate}T06:59:00.000Z` })),
    });
    database.saveDailyCandidateList({
      tradeDate: delayedTradeDate,
      methodologyVersion: "daily-focus-v3",
      status: "unavailable",
      origin: "prospective",
      featureCutoff: `${delayedTradeDate}T07:00:00.000Z`,
      marketAsOf: `${delayedTradeDate}T06:50:00.000Z`,
      clueAsOf: `${delayedTradeDate}T06:50:00.000Z`,
      frozenAt: `${delayedTradeDate}T07:30:00.000Z`,
      universeCount: 0,
      eligibleCount: 0,
      selectedCount: 0,
      methodology: { version: "daily-focus-v3" },
      dataQuality: { market: "before-close" },
      exclusionCounts: {},
      reason: "行情数据未覆盖收盘",
      benchmarkMembers: [],
      items: [],
    });
    const delayedRecovery = service.maybeFreezeDailyCandidates(delayedSource, at(`${delayedTradeDate}T07:40:00.000Z`));
    assert.equal(delayedRecovery?.status, "frozen", "a same-day unavailable attempt recovers when the complete close batch arrives after the deadline");
    assert.equal((database.getDailyCandidateList(delayedTradeDate)?.methodology as any).recoveredFrom.reason, "行情数据未覆盖收盘", "the superseded failed attempt remains in the replacement audit");
  });
});

test("4000-quote market freezes from three verified candidate windows while uncovered clean stock stays benchmark-only", async () => {
  await withService(async (service, _database, raw) => {
    prepareHistory(raw, ["600001", "600002", "600003", "600004"]);
    const base = source();
    const coveredCodes = ["600001", "600002", "600003", ...Array.from({ length: 297 }, (_, index) => String(100000 + index))];
    const template = base.discussionWindowsByCode["600001"]!;
    const discussionWindowsByCode = Object.fromEntries(coveredCodes.map((code) => [code, template.map((window: any) => ({ ...window, code, coveredCodes }))]));
    const uncovered = { ...base.quotes.find((quote: any) => quote.code === "600004"), pctChange: 20, price: 12, open: 10, high: 12, low: 9.8, previousClose: 10, amount: 1_500_000_000 };
    const dummies = Array.from({ length: 3996 }, (_, index) => ({ ...uncovered, code: String(100000 + index), name: `覆盖外${index}`, pctChange: 0, amount: 1_000_000_000 }));
    const forum = { ...base.events.find((event: any) => event.id === "forum-600001"), id: "forum-600004", relatedStocks: [{ code: "600004", name: "市场参考", relevance: 90, reason: "", tone: "positive" }] };
    const news = { ...base.events.find((event: any) => event.id === "news-600001"), id: "news-600004", relatedStocks: [{ code: "600004", name: "市场参考", relevance: 90, reason: "", tone: "positive" }] };
    const input = source({ quotes: [base.quotes[0], base.quotes[1], base.quotes[2], uncovered, ...dummies], events: [...base.events, forum, news], discussionWindowsByCode,
      sourceStates: base.sourceStates.map((state: any) => ({ ...state, eventIds: state.id === "authorized-forum" ? [...state.eventIds, forum.id] : state.id === "eastmoney-announcements" ? [...state.eventIds, news.id] : state.eventIds })),
    });
    const preview = service.buildDailyCandidatePreview(input, at("2026-08-25T07:10:00.000Z"));
    assert.equal(preview.items.length, 3);
    assert.equal(preview.items.some((item: any) => item.code === "600004"), false, "clean but uncovered stock is excluded from selection");
    assert.ok((preview.items[0]!.snapshot as any).marketExcess < 5, "uncovered clean stock still participates in the market reference");
    assert.equal(service.maybeFreezeDailyCandidates(input, at("2026-08-25T07:10:00.000Z"))?.status, "frozen");
  });
});

test("daily focus excludes verified share reductions and treats hot-industry news as its own angle", async () => {
  await withService(async (service, _database, raw) => {
    prepareHistory(raw);
    const base = source();
    const reduction = {
      id: "announcement-reduction-600001", title: "股票600001:关于控股股东、实际控制人减持股份的预披露公告", category: "公司公告", eventType: "公司",
      publishedAt: "2026-08-25T06:40:00.000Z", source: "上市公司公告", sourceKind: "announcement", url: "https://evidence.example.test/reduction",
      adapterId: "eastmoney-announcements", tone: "negative", confidence: 95, heat: 70, summary: "", topics: [],
      relatedStocks: [{ code: "600001", name: "股票600001", relevance: 96, reason: "线索源直接标注该股票", tone: "negative" }], corroboration: 1,
    };
    const industryNews = {
      id: "fast-news-electronics", title: "电子板块午后走强 多只半导体个股拉升", category: "新闻事件", eventType: "未分类",
      publishedAt: "2026-08-25T06:20:00.000Z", source: "东方财富财经快讯", sourceKind: "news", url: "https://evidence.example.test/industry",
      adapterId: "eastmoney-fast-news", tone: "positive", confidence: 80, heat: 70, summary: "", topics: [],
      relatedStocks: [], corroboration: 1,
    };
    const withClues = (events: unknown[]) => source({
      events,
      sourceStates: [
        ...base.sourceStates.map((state: any) => state.id === "eastmoney-announcements" ? { ...state, eventIds: [...state.eventIds, reduction.id] } : state),
        { id: "eastmoney-fast-news", role: "authority", state: "connected", coveredThrough: cutoff, observedAt: cutoff, queryFrom: "2026-08-24T07:00:00.000Z", queryTo: cutoff, coveredCodes: [], eventIds: [industryNews.id] },
      ],
    });

    const plain = service.buildDailyCandidatePreview(withClues([...base.events, industryNews]), at("2026-08-25T07:00:00.000Z"));
    const excluded = service.buildDailyCandidatePreview(withClues([...base.events, industryNews, reduction]), at("2026-08-25T07:00:00.000Z"));

    assert.equal(excluded.exclusionCounts.majorShareReduction, 1, "a controlling-shareholder reduction is counted as a major reduction exclusion");
    assert.equal(excluded.exclusionCounts.shareReduction, undefined, "the same stock is not double-counted under the ordinary reduction gate");
    assert.equal(excluded.items.some((item: any) => item.code === "600001"), false, "a stock with a verified reduction announcement never enters the candidate list");
    assert.equal(plain.items.some((item: any) => item.code === "600001"), true, "the same stock is a normal candidate without the reduction announcement");
    assert.ok(
      (excluded.dataQuality.shareReductionExclusions as string[]).some((line: string) => line.includes("600001") && line.includes("大幅减持")),
      "the frozen audit lists who was removed and why instead of silently dropping them",
    );

    const industryItem = plain.items.find((item: any) => item.code === "600002")!;
    const angle = industryItem.snapshot.industryNewsEvidence as Array<{ id: string; scope: string; url?: string }>;
    assert.ok(industryItem.snapshot.industryNews.count >= 1, "hot-industry news becomes an explicit sentiment angle on the candidate");
    assert.equal(angle[0]!.id, "fast-news-electronics", "market-wide industry headlines are listed before constituent news");
    assert.equal(angle[0]!.scope, "industry", "a market-wide headline naming the industry is attributed to the industry, not to a single stock");
    assert.equal(angle[0]!.url, "https://evidence.example.test/industry", "the angle keeps the original source link for review");
    assert.ok(angle.some((item) => item.scope === "constituent" && item.id.startsWith("news-")), "constituent stock news stays visible but is marked as such");
    assert.ok((industryItem.reasons as string[]).some((reason) => reason.includes("行业：电子")), "selection reasons name the concrete industry");
    assert.ok(industryItem.scores.industry <= 12, "the industry-news angle stays inside the twelve industry points");

    const withoutIndustryNews = service.buildDailyCandidatePreview(withClues(base.events), at("2026-08-25T07:00:00.000Z"));
    const scored = (payload: any) => payload.items.find((item: any) => item.code === "600002")!.scores.industry;
    assert.ok(scored(plain) > scored(withoutIndustryNews), "industry-news confirmation contributes to the industry score instead of being decorative");
  });
});

test("wires certified limit-up and dragon-tiger facts into candidate scoring, reasons, and audit", async () => {
  await withService(async (service) => {
    const base = source();
    const leadershipRow = (code: string, boardCount: number, firstSealTime: string, industryName: string, dragonTiger = false) => ({
      code, name: `股票${code}`, tradeDate: "2026-08-25", industryName, boardCount, firstSealTime, lastSealTime: firstSealTime,
      breakCount: 0, sealAmount: 80_000_000, amount: 1_500_000_000,
      dragonTiger: dragonTiger ? { netAmount: 60_000_000, buyAmount: 90_000_000, sellAmount: 30_000_000, reasons: ["日涨幅偏离值达到7%的前5只证券"], listCount: 1 } : null,
    });
    const withLeadership = service.buildDailyCandidatePreview(source({
      leadership: {
        tradeDate: "2026-08-25",
        rows: [
          leadershipRow("600001", 4, "09:25:00", "电子", true),
          leadershipRow("600002", 2, "10:05:00", "电子"),
          leadershipRow("600003", 1, "13:40:00", "电子"),
        ],
      },
    }), at("2026-08-25T07:00:00.000Z"));
    const withoutLeadership = service.buildDailyCandidatePreview(base, at("2026-08-25T07:00:00.000Z"));

    const leader = withLeadership.items.find((item: any) => item.code === "600001")!;
    assert.equal(leader.snapshot.leadership.tier, "market");
    assert.equal(leader.snapshot.leadership.label, "4 连板 · 市场龙头");
    assert.equal(leader.snapshot.leadership.bonus, 3, "V7 龙头加分收敛为层级分：市场龙头 3 分");
    assert.equal(leader.snapshot.leadership.industryLimitUps, 3, "行业涨停家数按候选集合统计");
    assert.ok((leader.reasons as string[]).some((reason) => reason.includes("龙头：4 连板 · 市场龙头")), "入选理由必须写出龙头判定");

    const industry = withLeadership.items.find((item: any) => item.code === "600002")!;
    assert.equal(industry.snapshot.leadership.tier, "industry");
    assert.equal(industry.snapshot.leadership.label, "2 连板 · 行业龙头");
    assert.equal(industry.snapshot.leadership.bonus, 2, "行业龙头 2 分");

    const first = withLeadership.items.find((item: any) => item.code === "600003")!;
    assert.equal(first.snapshot.leadership.tier, "none");
    assert.equal(first.snapshot.leadership.label, "1 连板");
    assert.equal(first.snapshot.leadership.bonus, 0, "V7 不再给首板板块合力加分，龙头加分只按层级");

    const plain = withoutLeadership.items.find((item: any) => item.code === "600001")!;
    assert.equal(plain.snapshot.leadership, null, "未取证时快照保持 null 而不是伪造");
    assert.ok((plain.reasons as string[]).some((reason) => reason === "涨停池/龙虎榜未取证"));
    assert.ok(leader.finalScore > plain.finalScore, "取证到的龙头事实提高最终分");

    assert.equal(withLeadership.dataQuality.leadership, "available");
    assert.equal(withLeadership.dataQuality.leadershipRows, 3);
    assert.deepEqual((withLeadership.dataQuality.leadershipDiagnostics as any).marketLeaders, ["600001"]);
    assert.equal(withoutLeadership.dataQuality.leadership, "unavailable");
  });
});
