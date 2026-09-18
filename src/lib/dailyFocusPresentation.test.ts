import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DAILY_FOCUS_REFRESH_MS, dailyFocusBoardCounts, dailyFocusBoardLabel, dailyFocusBoardMixText, dailyFocusCandidateStrength, dailyFocusDateOptions, dailyFocusExclusionLabel, dailyFocusIndustryLabel, dailyFocusLeadership, dailyFocusPhase, dailyFocusScoreBreakdown, dailyFocusSourceKind, dailyFocusStatus, discussionBaselineMedian, industryNewsScore, keepDailyFocusPayload, qualityEntries, scoreRows, shouldPollDailyFocus } from "./dailyFocusPresentation";

test("polls only the current daily-focus view every minute and retains stale payloads on refresh failure", () => {
  assert.equal(DAILY_FOCUS_REFRESH_MS, 60_000);
  assert.equal(shouldPollDailyFocus(""), true);
  assert.equal(shouldPollDailyFocus("2026-08-25"), false);
  assert.equal(shouldPollDailyFocus("2026-08-25", "2026-08-25"), true);
  assert.deepEqual(dailyFocusDateOptions(["2026-08-24", "2026-08-23"], "2026-08-25"), ["2026-08-25", "2026-08-24", "2026-08-23"]);
  assert.deepEqual(keepDailyFocusPayload({ tradeDate: "2026-08-25" }, null), { tradeDate: "2026-08-25" });
});

test("renders performance phases in Chinese for the daily-focus audit", () => {
  assert.equal(dailyFocusPhase("accumulating"), "样本积累中");
  assert.equal(dailyFocusPhase("exploratory"), "探索阶段");
  assert.equal(dailyFocusPhase("mature"), "样本成熟");
  assert.equal(dailyFocusSourceKind("news"), "新闻");
  assert.equal(dailyFocusSourceKind("announcement"), "公告");
  assert.equal(dailyFocusSourceKind("forum"), "论坛");
  assert.equal(dailyFocusCandidateStrength("A"), "核心聚焦");
  assert.equal(dailyFocusCandidateStrength("B"), "观察聚焦");
});

test("daily focus status keeps preview, frozen, reconstructed and unavailable audit meanings distinct", () => {
  assert.deepEqual(dailyFocusStatus("preview", "prospective"), { label: "预览", tone: "warning", detail: "尚未冻结，不计入历史表现" });
  assert.deepEqual(dailyFocusStatus("frozen", "prospective"), { label: "已冻结", tone: "up", detail: "前视候选，可进入 T+3 跟踪" });
  assert.deepEqual(dailyFocusStatus("reconstructed", "reconstructed"), { label: "历史重建", tone: "neutral", detail: "仅供审计，不计入前视表现" });
  assert.deepEqual(dailyFocusStatus("unavailable", "prospective"), { label: "不可用", tone: "down", detail: "数据质量未达到冻结条件" });
});

test("quality entries retain failures and per-source states instead of collapsing audit evidence", () => {
  assert.deepEqual(
    qualityEntries({ market: "complete", clueFailures: ["forum"], sourceStates: [{ id: "news", state: "connected" }] }),
    [["行情", "完整"], ["线索失败", "论坛"], ["来源状态", "新闻：已连接"]],
  );
  assert.deepEqual(qualityEntries({ history: "hydrating" }), [["历史行情", "补充中"]]);
  assert.deepEqual(
    qualityEntries({ market: "close-complete-stored", marketRows: 5548, boardLimitCovered: 0, boardLimitUniverse: 4997 }),
    [["行情", "收盘批次完整（已存库）"], ["行情股票数", "5548"], ["涨跌停元数据覆盖", "0"], ["涨跌停检测范围", "4997"]],
  );
});

test("score rows expose the six selection dimensions in a stable audit order", () => {
  assert.deepEqual(
    scoreRows({ turnover: 23, direction: 11, discussion: 13, price: 12, industry: 7, reliability: 2 }),
    [
      ["成交趋势", 23],
      ["情绪方向", 11],
      ["讨论升温", 13],
      ["价格确认", 12],
      ["行业共振", 7],
      ["证据可靠", 2],
    ],
  );
});

test("candidate rows always name the industry behind a hot-industry tag", () => {
  assert.equal(dailyFocusIndustryLabel("航海装备Ⅱ", true), "热门行业：航海装备Ⅱ");
  assert.equal(dailyFocusIndustryLabel("航运港口", false), "行业：航运港口");
  assert.equal(dailyFocusIndustryLabel(null, true), "热门行业（行业待确认）");
  assert.equal(dailyFocusIndustryLabel(null, false), "行业待确认");
});

test("exclusion counts are explained in Chinese, including the new reduction gates", () => {
  assert.equal(dailyFocusExclusionLabel("majorShareReduction"), "大幅减持");
  assert.equal(dailyFocusExclusionLabel("shareReduction"), "股东减持");
  assert.equal(dailyFocusExclusionLabel("amount"), "成交额不足 1 亿");
  assert.equal(dailyFocusExclusionLabel("unknownKey"), "unknownKey", "未知键保持原样而不是被静默丢弃");
});

test("industry news scoring matches the strategy: up to one point for count and one for direction", () => {
  assert.equal(industryNewsScore(null), 0);
  assert.equal(industryNewsScore(undefined), 0);
  assert.equal(industryNewsScore({ count: 0, textDirection: 50 }), 0);
  assert.equal(industryNewsScore({ count: 1, textDirection: 50 }), 1 / 3, "一条新闻只占条数分的三分之一");
  assert.equal(industryNewsScore({ count: 3, textDirection: 80 }), 2);
  assert.equal(industryNewsScore({ count: 99, textDirection: 100 }), 2, "行业新闻确认最多 2 分");
  assert.equal(industryNewsScore({ count: 3, textDirection: 30 }), 1, "低于中性方向的行业新闻不计方向分");
});

test("discussion audit displays the same five-window median used by the strategy", () => {
  const history = [1, 2, 2, 3, 9].map((count) => ({ count, verified: true }));
  assert.equal(discussionBaselineMedian({ countMedian: 2, isComparable: true }, history), 2);
  assert.equal(discussionBaselineMedian({}, history), 2, "legacy frozen payloads fall back to the verified-history median, never the mean");
});

test("daily-focus page omits redundant English and post-close kicker rows", async () => {
  const page = await readFile(new URL("../pages/ScreenerPage.tsx", import.meta.url), "utf8");
  assert.equal(page.includes("盘后冻结候选"), false);
  assert.equal(page.includes("前视证据"), false);
  assert.equal(page.includes("候选构成"), false);
  assert.equal(page.includes("盘中关注"), true);
  assert.equal(page.includes("待历史确认"), true);
});

test("separates certified leaders from unverified leadership snapshots", () => {
  assert.equal(dailyFocusLeadership({}), null, "没有字段时必须区分「未取证」与「不是龙头」");
  assert.equal(dailyFocusLeadership({ leadership: null }), null);
  assert.equal(dailyFocusLeadership({ leadership: { tier: "none", boardCount: 2 } }), null, "未达龙头标准不显示徽标");
  const market = dailyFocusLeadership({
    leadership: { tier: "market", label: "4 连板 · 市场龙头", bonus: 9.5, reasons: ["当日 4 连板，为全市场最高梯队（最高 4 板）"] },
  });
  assert.equal(market?.tier, "market");
  assert.equal(market?.label, "4 连板 · 市场龙头");
  assert.equal(market?.bonus, 9.5);
  assert.deepEqual(market?.reasons, ["当日 4 连板，为全市场最高梯队（最高 4 板）"]);
  assert.equal(dailyFocusLeadership({ leadership: { tier: "industry", boardCount: 2 } })?.label, "行业龙头", "缺少 label 时回落到层级名称");
});

test("explains the legacy final score without hiding a negative adjustment", () => {
  assert.equal(dailyFocusScoreBreakdown({ baseScore: 62, finalScore: 62, overheatPenalty: 0 }), "基础 62.0 − 风险 0.0 = 62.0");
  assert.equal(dailyFocusScoreBreakdown({ baseScore: 62, finalScore: 70, overheatPenalty: 2 }), "基础 62.0 + 调整 10.0 − 风险 2.0 = 70.0");
  assert.equal(dailyFocusScoreBreakdown({ baseScore: 62, finalScore: 53, overheatPenalty: 9 }), "基础 62.0 − 风险 9.0 = 53.0", "旧记录不会凭空出现调整加分");
  assert.equal(
    dailyFocusScoreBreakdown({ baseScore: 62, finalScore: 57, overheatPenalty: 2 }),
    "基础 62.0 − 调整 3.0 − 风险 2.0 = 57.0",
    "重复扣分大于持续加分时必须显示负调整，而不是被 Math.max(0, …) 吞掉",
  );
});

test("counts the frozen board mix and keeps unknown prefixes apart", () => {
  const counts = dailyFocusBoardCounts(["600519", "601138", "603318", "002594", "002415", "003816", "300308", "301029", "688256", "689009"]);
  assert.deepEqual(counts, { counts: { 主板: 3, 中小板: 3, 创业板: 2, 科创板: 2 }, unknown: 0 });
  assert.equal(
    dailyFocusBoardMixText(["600519", "600519", "600519", "002594", "002594", "002594", "300308", "300308", "688256", "688256"]),
    "主板 3 · 中小板 3 · 创业板 2 · 科创板 2",
  );
  assert.equal(dailyFocusBoardMixText(["600519", "430001"]), "主板 1 · 中小板 0 · 创业板 0 · 科创板 0 · 其他 1", "北交所等未知前缀单独计数");
  assert.equal(dailyFocusBoardMixText([]), "主板 0 · 中小板 0 · 创业板 0 · 科创板 0");
});

test("labels a candidate board without guessing unknown prefixes", () => {
  assert.equal(dailyFocusBoardLabel("002594"), "中小板");
  assert.equal(dailyFocusBoardLabel("300308"), "创业板");
  assert.equal(dailyFocusBoardLabel("688256"), "科创板");
  assert.equal(dailyFocusBoardLabel("830001"), null);
  assert.equal(dailyFocusBoardLabel(""), null);
});
