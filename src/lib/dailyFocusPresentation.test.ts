import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DAILY_FOCUS_REFRESH_MS, dailyFocusCandidateStrength, dailyFocusDateOptions, dailyFocusPhase, dailyFocusSourceKind, dailyFocusStatus, discussionBaselineMedian, keepDailyFocusPayload, qualityEntries, scoreRows, shouldPollDailyFocus } from "./dailyFocusPresentation";

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
  assert.equal(dailyFocusCandidateStrength("A"), "强信号");
  assert.equal(dailyFocusCandidateStrength("B"), "达标信号");
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
      ["文本方向", 11],
      ["讨论升温", 13],
      ["价格确认", 12],
      ["行业共振", 7],
      ["证据可靠", 2],
    ],
  );
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
