# 每日聚焦候选 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 在异动候选中交付可审计的每日 3–10 只正向研究候选、收盘冻结、T+3 结算与简洁的历史验证界面。

**Architecture:** 纯策略模块以无副作用输入执行门槛、评分、行业配额和稳定排序；服务层从雷达快照、历史成交额、线索和行业分析装配特征并处理预览/冻结/结算；SQLite 层保存不可变榜单、基准成员与 outcome。现有全市场异动 API 保持不变，前端通过独立 API 渲染每日聚焦。

**Tech Stack:** TypeScript 7、Node node:test + tsx --test、Node 内置 SQLite、React 19、Vite、Tailwind/shadcn。

---

## 文件结构

- 创建：server/dailyCandidateStrategy.ts — 无副作用评分、A/B 分级、过热扣分、行业约束和稳定排序。
- 创建：server/dailyCandidateStrategy.test.ts — 策略边界、权重、确定性排序、数量和行业约束测试。
- 创建：server/dailyCandidateService.ts — 预览、收盘冻结、T+3 结算及滚动表现聚合。
- 创建：server/dailyCandidateService.test.ts — 收盘截点、来源完整性、冻结与 T+3 测试。
- 创建：server/dailyCandidatePersistence.test.ts — 独立临时 SQLite 的迁移、幂等、不可变与 outcome 测试。
- 修改：server/eastMoneyMarket.ts、server/marketSync.ts、server/database.ts、server/radarEngine.ts、server/index.ts。
- 修改：src/domain/types.ts、src/lib/api.ts、src/pages/ScreenerPage.tsx、src/index.css、README.md、package.json。

## 任务 1：建立测试命令与上市日期数据通道

**Files:**
- Modify: package.json
- Modify: server/eastMoneyMarket.ts
- Modify: server/marketSync.ts
- Modify: server/database.ts
- Test: server/dailyCandidatePersistence.test.ts

- [ ] **Step 1: 写出上市日期解析和持久化的失败测试**

~~~
test("market quote preserves EastMoney listing date", async () => {
  process.env.TIDE_DATABASE_PATH = join(tmpdir(), "daily-focus-listing.sqlite");
  const { saveCompleteMarketSnapshot, getMarketQuotesByTradeDate } = await import("./database.ts");
  saveCompleteMarketSnapshot(snapshotWith({ code: "600001", listingDate: "2026-07-13" }));
  assert.equal(getMarketQuotesByTradeDate("2026-08-25")[0]?.listingDate, "2026-07-13");
});
~~~

- [ ] **Step 2: 运行失败测试**

Run: pnpm exec tsx --test server/dailyCandidatePersistence.test.ts

Expected: FAIL，因为 listingDate 尚未在行情类型和数据库中存在。

- [ ] **Step 3: 增加 f26、类型与 v8 增量迁移**

~~~
const MARKET_FIELDS = "f2,f3,f5,f6,f8,f12,f13,f14,f15,f16,f17,f18,f20,f26,f100,f124";

export interface EastMoneyMarketQuote {
  listingDate: string | null;
}

function parseListingDate(value: unknown): string | null {
  const date = String(value ?? "").trim();
  return /^\d{8}$/.test(date) ? date.slice(0, 4) + "-" + date.slice(4, 6) + "-" + date.slice(6) : null;
}
~~~

在 database.ts 中把 listing_date TEXT 加入 market_daily_quotes，加入 upsert 与 marketQuoteFromRow，并把 PRAGMA user_version = 8 放在事务中。历史行允许 NULL；没有可验证上市日期的股票由正式候选服务排除。

- [ ] **Step 4: 增加测试脚本并验证通过**

~~~
"test": "tsx --test server/*.test.ts"
~~~

Run: pnpm exec tsx --test server/dailyCandidatePersistence.test.ts && pnpm check

Expected: PASS，且现有行情同步类型检查无错误。

- [ ] **Step 5: Commit**

~~~
git add package.json server/eastMoneyMarket.ts server/marketSync.ts server/database.ts server/dailyCandidatePersistence.test.ts
git commit -m "feat: persist market listing dates"
~~~

## 任务 2：实现纯每日聚焦策略并测试所有门槛

**Files:**
- Create: server/dailyCandidateStrategy.ts
- Test: server/dailyCandidateStrategy.test.ts

- [ ] **Step 1: 写出策略失败测试与统一夹具**

~~~
const base = (overrides: Partial<DailyCandidateInput> = {}): DailyCandidateInput => ({
  code: "600001", name: "示例科技", exchange: "SH", listingTradingDays: 120,
  tradeDate: "2026-08-25", open: 10, high: 11, low: 9.8, close: 10.9,
  previousClose: 10, pctChange: 9, amount: 500_000_000,
  amountHistory: [100_000_000, 120_000_000, 145_000_000, 180_000_000, 500_000_000],
  marketExcess: 4, textDirection: 68, directionConsensus: 80, textConfidence: 85,
  freshness: 90, discussionCount: 30, discussionInteractions: 200, discussionGrowth: 1.2,
  independentEvents: 5, sourceCount: 3, hasNonForumCorroboration: true,
  industry: { name: "半导体", textHeat: 82, textDirection: 58, marketStrength: 72, breadth: 76, relation: "舆情交易双热" },
  onePriceLimit: false, reopenedLimit: false, threeDayReturnPercentile: 70,
  amountToMedianRatio: 2.4, discussionGrowthPercentile: 70, duplicateRatio: 0,
  ...overrides,
});

test("selects A candidates with 30-point turnover confirmation", () => {
  const result = selectDailyCandidates([base()], { marketPctChanges: [1, 2, 3] });
  assert.equal(result.items[0]?.grade, "A");
  assert.equal(result.items[0]?.scores.turnover <= 30, true);
});
~~~

补齐独立测试：BJ/ST/不足 30 日/停牌/一字涨停排除；B 级五日规则；P5/P95 缩尾；六项权重合计 100；弱文本、弱讨论、弱价格不能被成交额覆盖；三类过热扣分且上限 10；行业 70% 优先/单行业三只上限；少于三只时 B 补位；相同输入稳定排序。

- [ ] **Step 2: 运行失败测试**

Run: pnpm exec tsx --test server/dailyCandidateStrategy.test.ts

Expected: FAIL，因为模块不存在。

- [ ] **Step 3: 写入无副作用的策略实现**

~~~
export const DAILY_FOCUS_VERSION = "daily-focus-v1";
export const DAILY_FOCUS_WEIGHTS = { turnover: 30, direction: 18, discussion: 18, price: 18, industry: 12, reliability: 4 } as const;

export function selectDailyCandidates(inputs: DailyCandidateInput[], context: DailyCandidateContext): DailyCandidateResult {
  const eligible = inputs.filter((input) => baseEligibility(input, context));
  const scored = eligible.map((input) => scoreCandidate(input, eligible, context));
  return selectWithIndustryConstraints(scored);
}
~~~

实现 baseEligibility、amountTrend、winsorizedPercentile、scoreCandidate、overheatPenalty、gradeCandidate、selectWithIndustryConstraints。所有 helper 接收显式输入；不读取数据库、Date.now() 或环境变量。

- [ ] **Step 4: 运行策略测试与全量类型检查**

Run: pnpm exec tsx --test server/dailyCandidateStrategy.test.ts && pnpm check

Expected: PASS；测试断言 30+18+18+18+12+4 恰为 100。

- [ ] **Step 5: Commit**

~~~
git add server/dailyCandidateStrategy.ts server/dailyCandidateStrategy.test.ts
git commit -m "feat: add daily focus candidate strategy"
~~~

## 任务 3：实现榜单、基准成员和 outcome 的 SQLite 持久化

**Files:**
- Modify: server/database.ts
- Modify: server/dailyCandidatePersistence.test.ts

- [ ] **Step 1: 写出数据库契约失败测试**

~~~
test("frozen list is idempotent and entries cannot be rewritten", async () => {
  const db = await loadFreshDatabase();
  db.saveDailyCandidateList(frozenList({ tradeDate: "2026-08-25", items: [entry("600001", 1)] }));
  assert.throws(() => db.saveDailyCandidateList(frozenList({ tradeDate: "2026-08-25", items: [entry("600002", 1)] })));
  assert.equal(db.getDailyCandidateList("2026-08-25")?.items[0]?.code, "600001");
});
~~~

再添加 unavailable 保存、基准成员冻结、reconstructed 不进入默认表现查询、outcome 仅能从 observing 变为终态、交易日列表辅助函数和六窗口线索查询。

- [ ] **Step 2: 运行失败测试**

Run: pnpm exec tsx --test server/dailyCandidatePersistence.test.ts

Expected: FAIL，因为榜单表与函数不存在。

- [ ] **Step 3: 新增 v9 迁移及类型化读写函数**

~~~
CREATE TABLE daily_candidate_lists (
  trade_date TEXT PRIMARY KEY,
  methodology_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('frozen','unavailable','reconstructed')),
  origin TEXT NOT NULL CHECK(origin IN ('prospective','reconstructed')),
  feature_cutoff TEXT NOT NULL, market_as_of TEXT, clue_as_of TEXT, frozen_at TEXT,
  universe_count INTEGER NOT NULL, eligible_count INTEGER NOT NULL, selected_count INTEGER NOT NULL,
  methodology_json TEXT NOT NULL, data_quality_json TEXT NOT NULL,
  exclusion_counts_json TEXT NOT NULL, reason TEXT
);
CREATE TABLE daily_candidate_benchmark_members (
  trade_date TEXT NOT NULL REFERENCES daily_candidate_lists(trade_date) ON DELETE CASCADE,
  code TEXT NOT NULL, industry_code TEXT, industry_name TEXT,
  PRIMARY KEY(trade_date, code)
);
CREATE TABLE daily_candidate_entries (
  trade_date TEXT NOT NULL REFERENCES daily_candidate_lists(trade_date) ON DELETE CASCADE,
  code TEXT NOT NULL, rank INTEGER NOT NULL, grade TEXT NOT NULL CHECK(grade IN ('A','B')),
  is_hot_industry INTEGER NOT NULL, base_score REAL NOT NULL, overheat_penalty REAL NOT NULL,
  final_score REAL NOT NULL, scores_json TEXT NOT NULL, snapshot_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL, PRIMARY KEY(trade_date, code), UNIQUE(trade_date, rank)
);
CREATE TABLE daily_candidate_outcomes (
  signal_trade_date TEXT NOT NULL, code TEXT NOT NULL, horizon INTEGER NOT NULL CHECK(horizon = 3),
  status TEXT NOT NULL CHECK(status IN ('observing','completed','unavailable')),
  entry_trade_date TEXT, entry_open REAL, exit_trade_date TEXT, exit_close REAL,
  stock_return REAL, market_return REAL, market_excess REAL, industry_return REAL,
  industry_excess REAL, max_adverse REAL, coverage REAL, completed_at TEXT, reason TEXT,
  PRIMARY KEY(signal_trade_date, code, horizon)
);
~~~

导出 saveDailyCandidateList、getDailyCandidateList、listDailyCandidateLists、saveDailyCandidateOutcomes、getObservingDailyCandidateOutcomes、getCluesInWindow、getTradeDatesAfter。重复同日冻结仅当规范化 payload 完全相等时才视为幂等成功。

- [ ] **Step 4: 运行数据库测试**

Run: pnpm exec tsx --test server/dailyCandidatePersistence.test.ts && pnpm check

Expected: PASS；测试数据库由 TIDE_DATABASE_PATH 指向临时路径，不能写入 data/tide-live.sqlite。

- [ ] **Step 5: Commit**

~~~
git add server/database.ts server/dailyCandidatePersistence.test.ts
git commit -m "feat: persist daily focus candidate lists"
~~~

## 任务 4：实现预览、收盘冻结与 T+3 结算服务

**Files:**
- Create: server/dailyCandidateService.ts
- Test: server/dailyCandidateService.test.ts
- Modify: server/radarEngine.ts

- [ ] **Step 1: 写出服务失败测试**

~~~
test("does not freeze when a required source is stale", () => {
  const result = evaluateFreeze(source({ marketStale: false, discussionReady: false, authorityReady: true }), at("2026-08-25T07:10:00.000Z"));
  assert.deepEqual(result, { status: "pending", reason: "用户讨论数据未覆盖收盘" });
});

test("settles a prospective list from T+1 open to T+3 close", () => {
  const outcome = settleOutcome(entry("600001", 10), bars([open("2026-08-26", 10), close("2026-08-28", 11)]), benchmark(0.04));
  assert.equal(outcome.marketExcess, 0.06);
});
~~~

覆盖：15:00 前只预览、15:00–15:30 首个完整批次冻结、15:30 后保存 unavailable、15:00 后线索不进入正式特征、重复调用不改写、休市日跳过、市场覆盖不足 90% outcome unavailable、重建不进入表现。

- [ ] **Step 2: 运行失败测试**

Run: pnpm exec tsx --test server/dailyCandidateService.test.ts

Expected: FAIL，因为服务不存在。

- [ ] **Step 3: 实现服务并接入雷达生命周期**

~~~
export function buildDailyCandidatePreview(source: DailyCandidateSource, now = new Date()): DailyCandidateListResponse;
export function maybeFreezeDailyCandidates(source: DailyCandidateSource, now = new Date()): DailyCandidateListResponse | null;
export function settleDailyCandidateOutcomes(tradeDate: string): number;
~~~

DailyCandidateSource 必须显式含 quotes、stocks、events、tradeDate、marketAsOf、clueAsOf、marketStale、discussionSources 与 clueFailures。服务层以 buildIndustryAnalytics 为唯一行业计算入口，用 getRecentAmounts、getRecentPctChanges、getCluesInWindow 构造输入。radarEngine.ts 在持久化行情/舆情/行业快照后调用 maybeFreezeDailyCandidates 与 settleDailyCandidateOutcomes；预览只在 API 请求中生成，不持久化。

- [ ] **Step 4: 运行服务、策略与持久化测试**

Run: pnpm exec tsx --test server/dailyCandidateStrategy.test.ts server/dailyCandidatePersistence.test.ts server/dailyCandidateService.test.ts && pnpm check

Expected: PASS；无网络访问；所有时间由夹具注入。

- [ ] **Step 5: Commit**

~~~
git add server/dailyCandidateService.ts server/dailyCandidateService.test.ts server/radarEngine.ts
git commit -m "feat: freeze and settle daily focus candidates"
~~~

## 任务 5：发布独立 API 与前端数据契约

**Files:**
- Modify: src/domain/types.ts
- Modify: src/lib/api.ts
- Modify: server/index.ts
- Test: server/dailyCandidateService.test.ts

- [ ] **Step 1: 写出 API 契约失败测试**

~~~
test("daily candidates API keeps reconstructed records out of performance", async () => {
  const response = await request("/api/daily-candidates/performance?window=20");
  assert.equal(response.items.some((item) => item.origin === "reconstructed"), false);
});
~~~

- [ ] **Step 2: 运行失败测试**

Run: pnpm exec tsx --test server/dailyCandidateService.test.ts

Expected: FAIL，因为路由和响应类型不存在。

- [ ] **Step 3: 定义契约并实现三个路由**

~~~
export interface DailyCandidateListResponse {
  status: "preview" | "frozen" | "unavailable" | "reconstructed";
  tradeDate: string;
  items: DailyCandidateItem[];
  dataQuality: DailyCandidateDataQuality;
}
~~~

在 server/index.ts 添加 GET /api/daily-candidates、GET /api/daily-candidates?date=YYYY-MM-DD、GET /api/daily-candidates/performance?window=20|60。在 api.ts 增加 dailyCandidates 与 dailyCandidatePerformance。保留 /api/stocks 行为不变。

- [ ] **Step 4: 运行 API 与类型检查**

Run: pnpm exec tsx --test server/dailyCandidateService.test.ts && pnpm check

Expected: PASS；非法日期和非法窗口返回明确 400，空历史日期返回 NO_CANDIDATE_LIST_FOR_DATE。

- [ ] **Step 5: Commit**

~~~
git add server/index.ts src/domain/types.ts src/lib/api.ts server/dailyCandidateService.test.ts
git commit -m "feat: expose daily focus candidate APIs"
~~~

## 任务 6：实现简洁的每日聚焦界面

**Files:**
- Modify: src/pages/ScreenerPage.tsx
- Modify: src/index.css
- Modify: src/components/Visuals.tsx

- [ ] **Step 1: 写出 UI 验收清单**

默认标签为每日聚焦；预览/正式/不可用状态互斥；桌面和移动端均显示等级、总分、成交确认、行业状态和三条主要理由；单击行展示六项分数、五日成交柱、讨论基线、过热扣分和原始线索链接；20/60 表现可切换；不挤压全市场异动筛选状态。

- [ ] **Step 2: 在浏览器中确认当前页面没有每日聚焦标签**

Run: pnpm dev

Expected: /screener 当前仅有异动候选与我的自选，确认新增入口而非替换现有能力。

- [ ] **Step 3: 以独立组件渲染每日聚焦状态与候选列表**

~~~
<Tabs value={view} onValueChange={setView}>
  <TabsList>
    <TabsTrigger value="daily">每日聚焦</TabsTrigger>
    <TabsTrigger value="movers">全市场异动</TabsTrigger>
    <TabsTrigger value="watchlist">我的自选</TabsTrigger>
  </TabsList>
</Tabs>
{view === "daily" ? <DailyFocusPanel payload={dailyPayload} /> : <MarketScreenerPanel />}
~~~

将 DailyFocusPanel、DailyFocusRow、DailyFocusDetail 保持在 ScreenerPage.tsx 末尾的本地组件，复用现有 Card、Table、Badge、Tooltip、AmountCell 和移动端断点。视觉层级以总分和持续放量作为首要信息，使用少量状态色；不得增加大面积渐变、装饰性卡片堆叠或与现有 A 股红涨绿跌语义冲突的颜色。

- [ ] **Step 4: 构建并进行桌面/移动视觉检查**

Run: pnpm build

Expected: PASS。然后在 1440px、1024px、390px 宽度查看 /screener，检查长股票名、10 条候选、不可用日和展开详情没有横向溢出或遮挡。

- [ ] **Step 5: Commit**

~~~
git add src/pages/ScreenerPage.tsx src/index.css src/components/Visuals.tsx
git commit -m "feat: add daily focus candidate view"
~~~

## 任务 7：补充产品说明、全量验证与质量审查

**Files:**
- Modify: README.md
- Modify: docs/superpowers/specs/2026-08-25-daily-focus-candidates-design.md（仅在实现与已确认设计不一致时更新）

- [ ] **Step 1: 更新 README 的功能、API 和统计边界**

~~~
- 每日聚焦：沪深正向研究候选 3–10 只；盘中预览、收盘冻结，T+3 从下一交易日开盘开始结算；样本不足或数据不完整时明确显示不可用。
~~~

列出三个新 API，并说明回溯重建不参与正式成绩，结果不构成投资建议。

- [ ] **Step 2: 运行全套自动验证**

Run: pnpm test && pnpm check && pnpm build && pnpm sentiment:check

Expected: 全部 PASS。

- [ ] **Step 3: 运行运行时 API 冒烟测试**

Run: pnpm start

另开终端运行：

~~~
curl -sS http://127.0.0.1:8787/api/daily-candidates
curl -sS 'http://127.0.0.1:8787/api/daily-candidates/performance?window=20'
~~~

Expected: 返回结构化 preview/frozen/unavailable 数据；历史样本不足不返回 500。

- [ ] **Step 4: 执行两轮独立质量审查并修复发现项**

第一轮审查策略、数据库、时间泄漏与 API；第二轮审查 UI 视觉层级、响应式、可访问性和商业软件级信息密度。每轮先记录具体问题，再以测试或渲染证据修复；没有 P0/P1 问题、且审查者明确认可后才进入完成验证。

- [ ] **Step 5: Commit**

~~~
git add README.md docs/superpowers/specs/2026-08-25-daily-focus-candidates-design.md
git commit -m "docs: describe daily focus candidate methodology"
~~~

## 设计覆盖自检

| 设计要求 | 实现任务 |
| --- | --- |
| 沪深、30 日、ST/停牌/一字涨停、正向与五日趋势门槛 | 1、2、4 |
| 30% 成交确认、六维评分、过热与 A/B | 2 |
| 热门行业软偏好、行业上限、3–10 数量 | 2 |
| 预览、15:00 截点、15:30 决策、不可用状态 | 3、4 |
| 不可变榜单、基准成员、T+3 outcome | 3、4 |
| API、默认每日聚焦 UI、细节解释与历史表现 | 5、6 |
| 样本阶段、版本隔离、README、运行时验证 | 3、4、7 |

自检结果：每条已确认设计要求均有实现与至少一项自动或运行时验证任务；文件路径、函数名、数据表、测试命令和通过条件均已明确。
