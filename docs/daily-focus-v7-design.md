# 每日聚焦 V7 技术设计方案

**项目：** `jzefan/tide-sentiment-radar`  
**模块：** 每日聚焦（Daily Focus）  
**版本：** `daily-focus-v7`  
**核心目标：** 以“未来约两周仍值得持续研究的新变化”为主，同时保留少量“当前市场最热股票”。

---

## 1. 设计背景

当前 `daily-focus-v6` 已具备较完整的工程基础：沪深全市场行情过滤、5 日成交趋势、舆情方向、讨论热度、行业共振、股东减持排除、涨停池 / 龙虎榜 / 龙头识别、每日冻结、T+1 / T+3 前视验证、版本隔离、数据质量审计和历史聚焦股票池。

V7 不推翻这些能力，而是重点修正候选生成和最终选取逻辑：

- 避免 Daily Focus 退化为“强势股 + 板块配额榜”。
- 不再为了凑满 10 只而加入弱 B 级候选。
- 取消主板:中小板:创业板:科创板 = `3:3:2:2` 的选股配额。
- 降低涨停、龙头、价格、成交、行业强度之间的重复计分。
- 把同一真实事件的多媒体转载合并为一个 Event Cluster。
- 增加事件新鲜度、催化持续性、舆情变化、关注度加速和重复理由识别。
- 保留“最热股票”的市场观察价值，但降低其在最终排序中的权重。

V7 的总体原则是：

> **未来约两周研究价值优先，当前市场热度作为重要辅助信号。**

---

## 2. 产品定义

“每日聚焦”同时回答两个问题：

> **A. 当前市场正在重点交易什么？**

> **B. 哪些今天出现的变化，在未来约两周内仍值得持续研究？**

因此 V7 不再是单纯的“最热股票榜”，也不是脱离市场的“事件新闻榜”。

最终产品定义：

> **每日聚焦用于发现当日出现的重要新变化，或已经得到量价、行业和关注度确认且仍具有延续性的少量股票；同时保留少量真正处于市场核心热度中的股票。**

---

## 3. 总体架构

```text
                        全市场
                           │
                     基础风险过滤
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
          当前热度                   两周研究价值
          HotScore                 ResearchScore2W
              │                         │
       今天市场炒什么              今天发生了什么
       哪些股票最热                为什么重要
       龙头在哪里                  是否是新变化
       热度是否加速                是否可能持续约两周
              │                         │
              └────────────┬────────────┘
                           ▼
                       FocusScore
                  80% Research
                  20% Hot
                           │
              ┌────────────┼────────────┐
              │            │            │
           两周研究      当前热点     研究+热点
              │            │            │
              └────────────┴────────────┘
                           │
               重复 / 过热 / 多样性调整
                           │
                           ▼
                    每日聚焦 1～8只
```

---

## 4. 基础硬门槛

两条信号路径都先经过统一基础门槛：

```text
沪深股票
上市 >= 30 个交易日
非 ST / *ST / 退市风险
非停牌
行情数据有效
非一字涨停
不存在已核验股东减持
当日成交额 >= 1 亿元
```

V7 不再把以下条件作为全局硬门槛：

```text
5 日成交额趋势必须向上
当日必须上涨
必须跑赢市场
```

这些条件属于 Trend Continuation，不应该阻止刚出现重大事件、但市场尚未完全反应的股票进入研究视野。

---

## 5. 两条底层信号路径

V7 底层采用：

```text
Event Breakout      事件突破
Trend Continuation  趋势延续
```

允许两者同时成立：

```ts
type DailyFocusLane =
  | "event"
  | "trend"
  | "dual"
  | null;
```

### 5.1 Event Breakout

定义：当天出现相对于过去明显的新事件、新催化、新舆情方向变化或新关注度变化，且市场没有给出明显反向确认。

典型场景：

- 重大订单 / 合同
- 重大业绩变化
- 并购重组
- 回购 / 增持
- 新产品 / 新技术
- 产能投产
- 大客户导入
- 行业政策 / 产业政策
- 行业供需变化
- 价格周期变化

建议最低资格：

```text
primaryEventImportance >= 60
eventNovelty >= 55
eventDirection >= 55

并且：

authorityCount >= 1
或
independentSourceCount >= 2
```

市场不能明显反向：

```text
pctChange >= -2%
```

或者：

```text
closePosition >= 0.50
且 marketExcess >= -1%
```

Event 通道不要求 5 日成交趋势已经形成，也不要求已经涨停或已经成为龙头。

### 5.2 Trend Continuation

定义：股票已经获得量价、行业或龙头结构确认，当前趋势仍有效。

基本条件：

```text
amountTrend.base = true
pctChange > 0
marketExcess > 0
turnoverHeat >= 最低线
priceHeat >= 最低线
```

主要输入：5 日成交趋势、成交额放大、价格横截面强度、市场超额、收盘位置、行业强度、行业广度、讨论热度、讨论增速、连板、龙虎榜与龙头地位。

---

## 6. Event Cluster：事件聚类

新增：

```text
server/eventCluster.ts
```

目的：

> 同一真实事件被多家媒体转载，只算一个事件，避免把“媒体数量”误认为“独立事件数量”。

流程：

```text
Raw Events
   ↓
现有 fingerprint 去重
   ↓
标题标准化
   ↓
事件相似度
   ↓
事件聚类
   ↓
EventCluster[]
```

第一版不依赖 LLM 或 Embedding，保持 deterministic / auditable / reproducible。

### 6.1 数据结构

```ts
export interface EventCluster {
  id: string;
  signature: string;
  category:
    | "earnings"
    | "order"
    | "policy"
    | "ma"
    | "product"
    | "buyback"
    | "capital"
    | "industry"
    | "risk"
    | "other";
  primaryTitle: string;
  stockCodes: string[];
  eventIds: string[];
  sources: string[];
  sourceKinds: Array<"announcement" | "news" | "forum" | "market">;
  firstPublishedAt: string;
  lastPublishedAt: string;
  evidenceCount: number;
  independentSourceCount: number;
  authorityCount: number;
  direction: number;
  confidence: number;
  importance: number;
  persistence: number;
}
```

### 6.2 聚类规则

标题先标准化：去 HTML、统一标点和空格、去“最新 / 快讯 / 公告 / 关于”等低价值词、去公司名称中的冗余后缀。

两条线索满足：

```text
股票集合存在交集
AND
发布时间差 <= 48 小时
AND
标题相似度 >= 0.50
```

则归入同一 Event Cluster。

---

## 7. Event Importance

定义：

```text
EventImportance: 0～100
```

建议：

```text
35% 事件类别重要性
25% 来源权威性
20% 多源确认
10% 时效
10% 个股直接相关度
```

初始类别重要度：

| 类型 | 基础重要度 |
|---|---:|
| 并购 / 重组 / 控制权变化 | 90 |
| 重大业绩变化 | 85 |
| 重大订单 / 合同 | 80 |
| 政策直接影响 | 80 |
| 回购 / 实控人增持 | 75 |
| 新产品 / 商业化 / 技术突破 | 70 |
| 行业事件 | 65 |
| 融资 / 定增 / 资本事项 | 60 |
| 普通公司新闻 | 50 |
| 风险事件 | 35 |

Event Importance 表示“研究重要程度”，不是上涨概率。

---

## 8. Event Novelty：事件新鲜度

定义：当前事件相对于过去若干交易日是否是真正的新信息。

建议：

```text
完全没有类似事件      100
4～5 日前类似事件      70
2～3 日前类似事件      50
昨日已出现             25
今天重复转载           10～30
```

如果之前只是传闻，今天新增正式公告、监管确认、合同正式签署或业绩正式披露，则允许：

```text
materialUpdate = true
novelty >= 70
```

核心原则：

> **惩罚重复理由，而不是重复股票。**

---

## 9. Catalyst Persistence：催化持续性

用于回答：

> 这个变化是否可能在未来约两周继续产生新的信息、验证或产业影响？

### 高持续性：70～100

- 并购重组
- 重大订单 / 合同
- 行业政策 / 产业政策
- 业绩趋势变化
- 产品正式商业化
- 产能投产
- 大客户导入
- 价格周期变化

### 中等持续性：50～80

- 机构调研
- 行业涨价
- 新品发布
- 技术突破
- 重要行业会议
- 龙虎榜资金关注

### 低持续性：20～50

- 传闻
- 概念炒作
- 单日资金异动
- 普通涨停
- 论坛突然爆火
- 一次性新闻曝光

---

## 10. Sentiment Delta：舆情变化量

V6 更偏向绝对方向：

```text
textDirection = 78
```

V7 增加：

```text
sentimentDelta = currentTextDirection - historicalTextDirectionMedian
```

例如：过去中位数 52，今天 78，则 `sentimentDelta = +26`。

字段：

```ts
historicalTextDirectionMedian: number | null;
sentimentDelta: number | null;
```

历史不足时设为 `null`，不能伪造基线。

---

## 11. Attention Acceleration：关注度加速

不只看当前讨论数，还看今天相对自身历史是否突然升温。

组成：

```text
DiscussionGrowth
+
EventGrowth
```

已有 `calculateDiscussionGrowth()` 继续保留。

新增：

```text
currentEventClusterCount
historicalEventCountMedian
eventAcceleration
```

建议：

```text
eventGrowth =
ln(1 + todayClusters)
-
ln(1 + medianHistoricalClusters)
```

如果讨论基线可用：

```text
AttentionAcceleration =
60% DiscussionGrowth
+
40% EventGrowth
```

论坛数据不可用时可退化为 EventGrowth，但 Reliability 要相应降低。

---

## 12. HotScore：当前市场热度

HotScore 回答：

> 当前市场正在重点交易什么？

建议结构：

```text
25% 当日价格强度
20% 成交额异常
15% 绝对讨论热度
15% 关注度加速
10% 行业热度
10% 龙头 / 连板 / 龙虎榜
 5% 新闻曝光
```

HotScore 范围：`0～100`。

热点候选不能简单等于涨幅榜前几名。至少应满足：

```text
HotScore >= 80
成交额 >= 1 亿
非一字板
无明确减持风险
```

并且至少满足一种可解释证据：新闻 / 公告、有效用户讨论、强行业、龙头事实、连板或龙虎榜。

---

## 13. ResearchScore2W：未来约两周研究价值

这是 V7 的主分。

建议结构：

| 因子 | 权重 |
|---|---:|
| 事件重要度 | 20 |
| 事件新鲜度 | 15 |
| 催化持续性 | 15 |
| 舆情变化 | 10 |
| 行业 / 主题持续性 | 10 |
| 市场初步确认 | 10 |
| 资金持续确认 | 10 |
| 证据可靠性 | 10 |
| **合计** | **100** |

ResearchScore2W 不是“未来两周涨幅预测”，而是“未来约 10 个交易日是否值得持续研究”的综合指标。

---

## 14. Event Score 与 Trend Score

### Event Score

```text
事件重要性           20
事件新鲜度           15
催化持续性           15
舆情变化             10
行业 / 主题           10
市场初步确认         10
资金初步确认         10
证据可靠性           10
-------------------------
合计                100
```

### Trend Score

```text
成交趋势             25
价格强度             25
行业 / 主题确认      15
趋势持续性           10
关注度               10
当前舆情方向         10
证据可靠性            5
-------------------------
合计                100
```

最终：

```text
ResearchScore2W = max(EventScore, TrendScore)
```

若 Event 与 Trend 同时成立：

```text
lane = dual
```

代表“新变化已经得到市场确认”。

---

## 15. FocusScore

主公式：

```text
BaseFocusScore =
0.80 × ResearchScore2W
+
0.20 × HotScore
```

最终：

```text
FinalScore =
BaseFocusScore
+ ContinuationBonus
+ LeadershipBonus
- OverheatPenalty
- RepeatPenalty
```

建议范围：

```text
ContinuationBonus   0～4
LeadershipBonus     0～3
OverheatPenalty     0～10
RepeatPenalty       0～6
```

最后 clamp 到 `0～100`。

---

## 16. 为什么 HotScore 只占 20%

HotScore 必须保留，因为“当前最热”本身就是重要市场信息。

但如果热度权重过高，Daily Focus 会再次退化成涨幅榜、成交额榜或涨停榜。

因此 V7 第一版建议：

```text
Research 80%
Hot      20%
```

至少积累 60 个正式交易日后，再评估是否调整到 `75:25`。不建议 Hot 超过 30%。

---

## 17. LeadershipBonus 降低

V6：

```text
LeadershipBonus <= 12
```

V7 建议：

```text
LeadershipBonus <= 3
```

例如：

```text
市场龙头      +3
行业龙头      +2
普通连板      +1
```

原因是龙头、连板、龙虎榜等信息已经大量体现在 HotScore、Price、Trend 和 Industry 中，不能重复大额计分。

---

## 18. ContinuationBonus

用于奖励“事件后继续得到确认”。

建议：

```text
Trend Eligible             +1
5 日趋势达到 Grade A       +1
行业强度 >= 70             +1
讨论 / 关注仍在继续升温    +1
```

最多 4 分。

---

## 19. RepeatPenalty

基础惩罚建议：

```text
过去5日出现0次       0
出现1次              1
出现2次              3
出现3次              5
出现4次以上          6
```

连续 3 日以上可额外增加，但 ContinuationBonus 可以抵消部分惩罚。

如果今天出现：

```text
eventNovelty >= 80
AND
eventImportance >= 75
```

则：

```text
RepeatPenalty = 0
```

---

## 20. OverheatPenalty

保留现有过热逻辑，最大 10 分：

- 炸板
- 极端 3 日涨幅
- 成交额极端放大
- 讨论异常但来源单一
- 高重复内容

V7 第一版不建议继续叠加过多复杂因子，避免过拟合。

---

## 21. FocusType：产品展示类型

除了底层 Lane，再增加产品层类型：

```ts
type FocusType =
  | "research"
  | "hot"
  | "research-hot";
```

页面对应：

```text
两周研究
当前热点
研究+热点
```

这样用户一眼就能看出“为什么今天在榜”。

---

## 22. A / B 重新定义

### A：核心聚焦

建议：

```text
ResearchScore2W >= 72
FinalScore >= 70
Reliability 达到最低线
```

### B：观察聚焦

建议：

```text
ResearchScore2W >= 58
```

或者：

```text
HotScore >= 80
且存在至少一种可解释证据
```

不再允许纯市场强势、无事件、无文本的普通强势股票仅凭较低总分大量进入榜单。

---

## 23. 候选数量规则

取消“尽量凑满 10 只”。

V7：

```text
最多 8 只
```

优先结构：

```text
研究位：最多 5
热点位：最多 2
弹性位：最多 1
```

这不是强制配额。

如果只有 4 只满足条件，就发布 4 只；如果只有 1 只，就发布 1 只；如果 0 只，则展示“今日暂无满足条件的聚焦标的”。

---

## 24. 删除 3:3:2:2 板块配额

删除选股阶段的：

```ts
DAILY_FOCUS_BOARD_QUOTAS
```

不再强制：

```text
主板 3
中小板 3
创业板 2
科创板 2
```

`marketBoardOf()` 继续保留，只用于展示、统计和回测分析。

---

## 25. 行业与事件多样性

真正要控制的是行业集中和事件集中。

建议：

```text
同一行业默认最多 2 只
同一 Event Cluster 最多 2 只
```

若候选不足，可把行业上限放宽到 3；Event Cluster 上限原则上不放宽。

---

## 26. 最终 Re-ranking

不要简单：

```ts
sort(finalScore).slice(0, 8)
```

而采用确定性贪心选择：

```text
先研究型
再保留少量热点型
再按综合分补位
```

同时限制同行业和同事件集中度。

策略函数继续保持 pure / deterministic / auditable。

---

## 27. DailyCandidateInput 新增字段

```ts
export interface DailyCandidateInput {
  // existing...

  eventClusters?: DailyCandidateEventFeature[];

  historicalTextDirectionMedian?: number | null;

  sentimentDelta?: number | null;

  historicalEventCountMedian?: number | null;

  focusDaysLast5?: number;

  consecutiveFocusDays?: number;

  lastFocusDate?: string | null;

  lastPrimaryEventClusterId?: string | null;
}
```

---

## 28. DailyCandidateEventFeature

```ts
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
```

---

## 29. DailyCandidateScored 新增字段

```ts
export interface DailyCandidateScored {
  code: string;

  lane: "event" | "trend" | "dual" | null;

  focusType: "research" | "hot" | "research-hot";

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

  continuationBonus: number;
  leadershipBonus: number;
  repeatPenalty: number;
  overheatPenalty: number;

  finalScore: number;

  grade: "A" | "B" | null;
}
```

---

## 30. dailyCandidateService.ts 改造

当前：

```text
authorizedEvents
↓
dedupeCandidateEvents
↓
buildInputs
↓
selectDailyCandidates
```

V7：

```text
authorizedEvents
        ↓
dedupeCandidateEvents
        ↓
buildEventClusters
        ↓
读取最近冻结记录
        ↓
历史事件基线
        ↓
历史舆情方向中位数
        ↓
最近 5 日聚焦历史
        ↓
calculateEventNovelty
        ↓
buildInputsV7
        ↓
selectDailyCandidatesV7
```

---

## 31. 历史数据第一版复用现有冻结记录

V7 第一版不强制新增数据库迁移。

优先使用：

```text
daily_candidate_lists
daily_candidate_entries
snapshot.events
```

从冻结快照中推导：

- 最近聚焦次数
- 连续聚焦次数
- 上一次聚焦日期
- 历史事件标题
- 历史事件数量
- 历史 textDirection

这样可以降低升级风险，并保持 V6 历史数据兼容。

---

## 32. 后续事件持久化

V7 稳定后可再新增：

```text
daily_event_clusters
daily_event_cluster_stocks
```

用于跨日事件查询、Event Novelty、事件持续性研究、事件回测，以及事件到行业 / 个股的影响分析。

---

## 33. Quality Gate

建议区分：

```text
marketReady
authorityReady
discussionReady
```

数据质量模式：

```text
full
market+authority
market-only
```

`market-only` 不能生成 Event Lane；可以生成 Trend / Hot，但页面必须明确说明“文本证据不足，榜单主要由市场趋势与热度信号构成”。

---

## 34. 页面展示建议

候选行：

```text
股票名称
代码 · 板块 · 行业

研究+热点
事件+趋势

综合 86
研究 91
热度 88
```

事件型：

```text
核心事件：公司签署重大订单
事件重要度 82
事件新鲜度 100
催化持续性 80
```

趋势型：

```text
趋势依据：
5日成交趋势增强
行业强度 78
当日跑赢市场 3.2%
```

调整项：

```text
持续确认 +2
龙头 +1
重复 -1
过热 -3
```

---

## 35. 去掉“强看涨 / 偏多”表达

当前：

```text
A → 强看涨
B → 偏多
```

V7 建议改为：

```text
A → 核心聚焦
B → 观察聚焦
```

因为 FinalScore 不是上涨概率。

T+1 / T+3 继续作为“后续验证”，而不是“次日预测”。

---

## 36. 聚焦股票池升级

`dailyFocusPool.ts` 保留，并建议增加：

```text
lane
focusType
primaryEvent
focusReasonChanged
```

例如：

```text
09-16 事件突破
09-17 研究+热点
09-18 趋势延续
```

这样可以看到“为什么这只股票连续几天仍值得研究”。

---

## 37. 两周跟踪的含义

“两周研究价值”不是预测未来两周收益，而是判断：

> 今天出现的变化，是否值得在未来约 10 个交易日持续跟踪和验证。

聚焦股票池可以承担“两周研究跟踪器”的角色，持续观察：

- 新事件是否出现
- 市场是否继续确认
- 成交是否维持
- 行业是否继续强化
- 舆情是否继续升温
- 原始理由是否失效

---

## 38. T+3 验证继续保留

现有：

```text
T+1 open
→
T+3 close
```

继续保持。

V7 增加分组统计：

```text
Event / Trend / Dual
Research / Hot / Research-Hot
首次聚焦 / 重复聚焦
High Novelty / Low Novelty
龙头 / 非龙头
```

---

## 39. 建议新增效果指标

除现有平均市场超额、Hit Rate、Median Excess、Max Adverse 外，增加：

- Top3 平均市场超额
- 首次聚焦市场超额
- 重复聚焦市场超额
- Event vs Trend vs Dual
- Research vs Hot vs Research-Hot
- 高 Novelty vs 低 Novelty
- 聚焦后 3 日最大上涨
- 聚焦后成交活跃度
- Daily Focus Repeat Ratio

Repeat Ratio 示例：

```text
今日 8 只
其中 6 只过去 3 日已经出现
Repeat Ratio = 75%
```

如果长期过高，说明雷达失去了“发现新变化”的能力。

---

## 40. 策略纯函数原则继续保持

`dailyCandidateStrategyV7.ts` 应继续：

```text
不访问 DB
不访问网络
不读取系统时间
无 global mutable state
```

核心：

```ts
selectDailyCandidates(inputs)
```

相同输入必须得到完全相同结果。

---

## 41. 推荐代码结构

新增：

```text
server/eventCluster.ts
server/dailyCandidateStrategyV7.ts
```

修改：

```text
server/dailyCandidateService.ts
src/lib/api.ts
src/lib/dailyFocusPresentation.ts
src/pages/ScreenerPage.tsx
```

测试新增：

```text
server/eventCluster.test.ts
server/dailyCandidateStrategyV7.test.ts
```

V7 稳定后再考虑合并或废弃旧 V6 Strategy。

---

## 42. 推荐单元测试

至少覆盖：

1. 新重大事件可绕过 5 日成交趋势门槛。
2. 没有事件不能进入 Event Lane。
3. 纯市场强势股票可进入 Trend Lane。
4. 高 HotScore 股票可作为热点观察进入。
5. HotScore 不得主导 ResearchScore2W。
6. 不再使用 3:3:2:2 板块配额。
7. 最大候选数不超过 8。
8. 同行业默认最多 2 只。
9. 同事件最多 2 只。
10. 多媒体转载同一事件只生成一个 Event Cluster。
11. 全新事件 Novelty = 100。
12. 昨日重复事件 Novelty 明显下降。
13. 正式公告可提升已有传闻的新鲜度。
14. sentimentDelta 历史不足时为 null。
15. 重复聚焦产生 RepeatPenalty。
16. 新重大事件可以清除 RepeatPenalty。
17. 持续确认可以抵消部分重复惩罚。
18. 龙头额外加分不超过 3。
19. 过热扣分可以超过龙头奖励。
20. 相同输入永远产生相同结果。

---

## 43. 实施顺序

### V7.0：核心选取行为

先完成：

```text
daily-focus-v7
ResearchScore2W
HotScore
80:20
取消 3:3:2:2
最多 8 只
动态数量
LeadershipBonus 降到 3
RepeatPenalty
```

目标：先纠正“榜单为什么选这些股票”。

### V7.1：事件能力

加入：

```text
Event Cluster
Event Importance
Event Novelty
Catalyst Persistence
Event Lane
```

目标：真正发现“新的、重要的变化”。

### V7.2：历史变化与效果分析

加入：

```text
Sentiment Delta
Attention Acceleration
Repeat Ratio
Event / Trend / Hot 分组表现
```

目标：用真实前视结果验证 V7 是否优于 V6。

---

## 44. 参数初始建议

| 参数 | 初始值 |
|---|---:|
| 最大聚焦数量 | 8 |
| Research 权重 | 80% |
| Hot 权重 | 20% |
| A 级 ResearchScore2W | 72 |
| B 级 ResearchScore2W | 58 |
| Hot Candidate Gate | 80 |
| Event Importance Gate | 60 |
| Event Novelty Gate | 55 |
| 龙头最大加分 | 3 |
| 持续确认最大加分 | 4 |
| 过热最大扣分 | 10 |
| 重复最大扣分 | 6 |
| 同行业默认上限 | 2 |
| 同事件上限 | 2 |
| 历史重复窗口 | 最近 5 个交易日 |
| 主验证周期 | T+3 |
| 两周研究窗口 | 约 10 个交易日 |

至少积累 60 个正式交易日后，再考虑调整主要权重。

---

## 45. 最终决策伪代码

```ts
const globalEligible =
  passesMarketRiskGate(input);

const eventEligible =
  globalEligible
  && hasImportantNewEvent(input)
  && hasMinimumEvidence(input)
  && !hasStrongNegativeMarketReaction(input);

const trendEligible =
  globalEligible
  && hasPositiveAmountTrend(input)
  && input.pctChange > 0
  && input.marketExcess > 0
  && hasMinimumMarketStrength(input);

const eventScore =
  eventEligible
    ? calculateEventScore(input)
    : 0;

const trendScore =
  trendEligible
    ? calculateTrendScore(input)
    : 0;

const researchScore2W =
  Math.max(eventScore, trendScore);

const hotScore =
  calculateHotScore(input);

const baseFocusScore =
  0.80 * researchScore2W
  + 0.20 * hotScore;

const finalScore =
  clamp(
    baseFocusScore
    + continuationBonus
    + leadershipBonus
    - overheatPenalty
    - repeatPenalty,
    0,
    100
  );
```

最终选取：

```text
研究型优先
     ↓
保留少量高 HotScore 股票
     ↓
同事件限制
     ↓
同行业限制
     ↓
最多 8 只
```

---

## 46. V6 与 V7 的核心区别

V6：

```text
强势股
+ 舆情
+ 龙头
+ 板块平衡
→ 尽量凑满 10 只
```

V7：

```text
新事件
或
有效趋势
       +
当前热度
       ↓
两周研究价值为主
       ↓
新鲜度
       ↓
持续性
       ↓
证据可靠性
       ↓
重复 / 过热 / 多样性
       ↓
少量真正值得持续研究的股票
```

---

## 47. V7 成功标准

不再是：

```text
每天有没有 10 只
```

而是：

```text
每天选出的股票是否真的有理由在“今天”进入研究视野
```

进一步验证：

```text
这个理由在未来约两周内是否具有持续研究价值
```

同时保留：

```text
今天市场真正最热的是什么
```

---

## 48. 最终产品原则

> **每日聚焦既不是简单的“最热股票榜”，也不是脱离市场的“事件新闻榜”；它应当优先发现今天出现的、未来约两周仍值得持续研究的新变化，同时保留少量真正处于市场核心热度中的股票。**

这应成为后续 V7.x 参数调整、因子新增和页面改版的统一判断标准。
