import type { DailyCandidateEntryResponse, DailyCandidateOrigin, DailyCandidateStatus } from "./api";
import { MARKET_BOARDS, marketBoardOf, type MarketBoard } from "../domain/board";

export type DailyFocusStatusTone = "up" | "down" | "warning" | "neutral";
export const DAILY_FOCUS_REFRESH_MS = 60_000;

/** Convert internal strategy grades into plain-language labels for the page. */
export function dailyFocusCandidateStrength(grade: "A" | "B"): "核心聚焦" | "观察聚焦" {
  return grade === "A" ? "核心聚焦" : "观察聚焦";
}

/** Historical dates are immutable; only the current trading-day view needs polling. */
export function shouldPollDailyFocus(date: string, currentDate = ""): boolean { return date === "" || (Boolean(currentDate) && date === currentDate); }

/** Keep the current trading day visible even before its formal list is frozen. */
export function dailyFocusDateOptions(tradeDates: string[], currentDate: string): string[] {
  return [...new Set([currentDate, ...tradeDates].filter(Boolean))];
}

export function dailyFocusSourceKind(value: unknown): string {
  return ({ news: "新闻", announcement: "公告", forum: "论坛" } as Record<string, string>)[String(value)] ?? "来源";
}

/**
 * 候选行上的行业标签：热门行业必须带出具体行业名，
 * 否则用户只看到“热门行业”四个字，无法判断属于哪个板块。
 */
export function dailyFocusIndustryLabel(industryName: string | null, isHot: boolean): string {
  if (!industryName) return isHot ? "热门行业（行业待确认）" : "行业待确认";
  return isHot ? `热门行业：${industryName}` : `行业：${industryName}`;
}

/**
 * 候选行上的龙头标签。涨停池/龙虎榜未取证的记录返回 null：
 * 「未取证」与「不是龙头」在界面上必须区分。
 */
export function dailyFocusLeadership(
  snapshot: Record<string, unknown>,
): { tier: "market" | "industry"; label: string; bonus: number; reasons: string[] } | null {
  const leadership = asRecord(snapshot.leadership);
  const tier = leadership.tier;
  if (tier !== "market" && tier !== "industry") return null;
  const label = asString(leadership.label) ?? (tier === "market" ? "市场龙头" : "行业龙头");
  const reasons = Array.isArray(leadership.reasons)
    ? leadership.reasons.flatMap((reason) => asString(reason) ?? [])
    : [];
  return { tier, label, bonus: asNumber(leadership.bonus) ?? 0, reasons };
}

/**
 * 旧冻结记录的最终分构成文案（V7 记录改用研究/热度展示）。
 * 调整项可能为负（重复扣分大于持续加分），所以不能只取 Math.max(0, …)，否则等式对不上。
 */
export function dailyFocusScoreBreakdown(entry: { baseScore: number; finalScore: number; overheatPenalty: number }): string {
  const adjustment = entry.finalScore - entry.baseScore + entry.overheatPenalty;
  const parts = [`基础 ${entry.baseScore.toFixed(1)}`];
  if (adjustment > 0) parts.push(`+ 调整 ${adjustment.toFixed(1)}`);
  else if (adjustment < 0) parts.push(`− 调整 ${Math.abs(adjustment).toFixed(1)}`);
  parts.push(`− 风险 ${entry.overheatPenalty.toFixed(1)}`);
  parts.push(`= ${entry.finalScore.toFixed(1)}`);
  return parts.join(" ");
}

/**
 * 每日聚焦的板块分布：主板 / 中小板 / 创业板 / 科创板 各入选多少只。
 * 未知前缀（B 股、未来新增代码段）单独计数，不混进四个板块。
 */
export function dailyFocusBoardCounts(codes: string[]): { counts: Record<MarketBoard, number>; unknown: number } {
  const counts: Record<MarketBoard, number> = { 主板: 0, 中小板: 0, 创业板: 0, 科创板: 0 };
  let unknown = 0;
  for (const code of codes) {
    const board = marketBoardOf(code);
    if (board) counts[board] += 1;
    else unknown += 1;
  }
  return { counts, unknown };
}

/** 板块分布文案，例如「主板 3 · 中小板 3 · 创业板 2 · 科创板 2」。 */
export function dailyFocusBoardMixText(codes: string[]): string {
  const { counts, unknown } = dailyFocusBoardCounts(codes);
  const parts = MARKET_BOARDS.map((board) => `${board} ${counts[board]}`);
  if (unknown) parts.push(`其他 ${unknown}`);
  return parts.join(" · ");
}

/** 候选板块标签；未知前缀不猜板块。 */
export function dailyFocusBoardLabel(code: string): string | null {
  return marketBoardOf(code);
}

/**
 * 证据模式（设计 §33）：
 * - full：行情 + 公告权威源 + 讨论基线都可用；
 * - market+authority：有公告，但讨论源覆盖不足；
 * - market-only：连公告权威源都不可用，此时不可能产生事件通道。
 */
export type DailyFocusDataMode = "full" | "market+authority" | "market-only";

export function dailyFocusDataMode(quality: Record<string, unknown>): DailyFocusDataMode {
  const authority = asString(quality.authority);
  const discussion = asString(quality.discussion);
  if (authority !== "available") return "market-only";
  return discussion === "covered" || discussion === "available" ? "full" : "market+authority";
}

export function dailyFocusDataModeLabel(mode: DailyFocusDataMode): string {
  return mode === "full" ? "完整证据" : mode === "market+authority" ? "市场 + 公告" : "仅市场";
}

/** 页面必须写清楚当前榜单是什么构成的；完整证据时不需要提示。 */
export function dailyFocusDataModeNotice(mode: DailyFocusDataMode): string | null {
  if (mode === "full") return null;
  return mode === "market+authority"
    ? "讨论源覆盖不足：关注度加速信号缺失，榜单以公告事件与量价趋势为主。"
    : "文本证据不足：当日无法产生事件通道，榜单主要由市场趋势与热度信号构成。";
}

/** 榜单实测构成：选出的股票里有没有真正走事件通道的。 */
export function dailyFocusLaneNotice(lanes: Array<unknown>): string | null {
  const values = lanes.map((value) => asString(value));
  if (!values.length) return null;
  return values.some((lane) => lane === "event" || lane === "dual")
    ? null
    : "本日没有股票达到事件通道门槛，榜单全部来自量价趋势与当前热度。";
}

export function dailyFocusLaneLabel(lane: unknown): string | null {
  const value = asString(lane);
  return value === "dual" ? "事件+趋势" : value === "event" ? "事件突破" : value === "trend" ? "趋势延续" : null;
}

export function dailyFocusFocusTypeLabel(focusType: unknown): string | null {
  const value = asString(focusType);
  return value === "research-hot" ? "研究+热点" : value === "research" ? "两周研究" : value === "hot" ? "当前热点" : null;
}

/**
 * V7 双目标分项；旧冻结记录没有这些字段时返回 null，界面回落到旧的六维展示。
 * 未达门槛的通道标成「未达门槛」，避免把没有计入研究分的分数当成已计入。
 */
export function dailyFocusV7ScoreRows(
  snapshot: Record<string, unknown>,
): Array<{ label: string; value: string; detail: string }> | null {
  const researchScore2W = asNumber(snapshot.researchScore2W);
  const hotScore = asNumber(snapshot.hotScore);
  if (researchScore2W === null || hotScore === null) return null;
  const eventScore = asNumber(snapshot.eventScore) ?? 0;
  const trendScore = asNumber(snapshot.trendScore) ?? 0;
  const lane = asString(snapshot.lane);
  const eventCounted = lane === "event" || lane === "dual";
  const trendCounted = lane === "trend" || lane === "dual";
  return [
    { label: "研究价值（约两周）", value: researchScore2W.toFixed(1), detail: lane ? `通道：${dailyFocusLaneLabel(lane) ?? lane}` : "未进入事件/趋势通道" },
    { label: "当前热度", value: hotScore.toFixed(1), detail: "研究 80% + 热度 20% 中的热度项" },
    {
      label: "事件得分",
      value: eventCounted ? eventScore.toFixed(1) : "未达门槛",
      detail: eventCounted ? "已计入研究分" : "事件重要度或新鲜度不足，未计入研究分",
    },
    {
      label: "趋势得分",
      value: trendCounted ? trendScore.toFixed(1) : "未达门槛",
      detail: trendCounted ? "已计入研究分" : "成交趋势或价格强度不足，未计入研究分",
    },
  ];
}

/** 排除计数使用中文口径，避免页面上直接出现英文键名。 */
export const DAILY_FOCUS_EXCLUSION_LABELS: Record<string, string> = {
  invalidInput: "输入无效",
  exchange: "非沪深交易所",
  risk: "ST/退市风险",
  listing: "上市不足 30 个交易日",
  invalidQuote: "停牌或无有效行情",
  onePriceLimit: "一字涨停",
  majorShareReduction: "大幅减持",
  shareReduction: "股东减持",
  amount: "成交额不足 1 亿",
  amountTrend: "成交额趋势未确认",
  positiveReturn: "当日未上涨或未跑赢市场",
};

export function dailyFocusExclusionLabel(key: string): string {
  return DAILY_FOCUS_EXCLUSION_LABELS[key] ?? key;
}

/**
 * 与策略一致的行业新闻加分：条数与方向各 1 分，合计最多 2 分。
 * 明细里用它解释“行业共振”这 12 分里有多少来自行业新闻确认。
 */
export function industryNewsScore(signal: { count?: number; textDirection?: number } | null | undefined): number {
  const count = asNumber(signal?.count) ?? 0;
  const direction = asNumber(signal?.textDirection);
  const bounded = (value: number, min: number, max: number, weight: number) =>
    max === min ? weight : Math.min(weight, Math.max(0, (Math.min(max, Math.max(min, value)) - min) / (max - min)) * weight);
  return bounded(count, 0, 3, 1) + (direction === null ? 0 : bounded(direction, 50, 80, 1));
}

/** Preserve the last known-good audit payload while a refresh is unavailable. */
export function keepDailyFocusPayload<T>(previous: T | null, next: T | null): T | null { return next ?? previous; }

export function dailyFocusPhase(phase: "accumulating" | "exploratory" | "mature"): string {
  return phase === "accumulating" ? "样本积累中" : phase === "exploratory" ? "探索阶段" : "样本成熟";
}

export function dailyFocusStatus(
  status: DailyCandidateStatus,
  origin: DailyCandidateOrigin,
): { label: string; tone: DailyFocusStatusTone; detail: string } {
  if (status === "preview") return { label: "预览", tone: "warning", detail: "尚未冻结，不计入历史表现" };
  if (status === "unavailable") return { label: "不可用", tone: "down", detail: "数据质量未达到冻结条件" };
  if (status === "reconstructed" || origin === "reconstructed") return { label: "历史重建", tone: "neutral", detail: "仅供审计，不计入前视表现" };
  return { label: "已冻结", tone: "up", detail: "前视候选，可进入 T+3 跟踪" };
}

const DIMENSIONS = [
  ["成交趋势", "turnover"],
  ["情绪方向", "direction"],
  ["讨论升温", "discussion"],
  ["价格确认", "price"],
  ["行业共振", "industry"],
  ["证据可靠", "reliability"],
] as const;

export function scoreRows(scores: DailyCandidateEntryResponse["scores"]): Array<[string, number]> {
  return DIMENSIONS.map(([label, key]) => [label, scores[key] ?? 0]);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Use the exact frozen median used by the strategy; verified history is a legacy fallback. */
export function discussionBaselineMedian(growth: Record<string, unknown>, history: Array<Record<string, unknown>>): number | null {
  const frozenMedian = asNumber(growth.countMedian);
  if (frozenMedian !== null) return frozenMedian;
  const counts = history.filter((item) => item.verified === true).flatMap((item) => asNumber(item.count) ?? []).sort((left, right) => left - right);
  if (counts.length !== 5) return null;
  return counts[2] ?? null;
}

/** Flatten the retained quality audit without discarding nested source-state provenance. */
export function qualityEntries(value: Record<string, unknown>): Array<[string, string]> {
  const keyLabels: Record<string, string> = {
    previewAt: "预览时间", history: "历史行情", historyRequested: "历史请求数", historyHydrated: "历史补齐数", historyFailed: "历史失败数", market: "行情", discussion: "讨论", authority: "权威来源", clueFailures: "线索失败",
    sourceStates: "来源状态", discussionBaseline: "讨论基线", verifiedDiscussionCandidates: "已验证讨论候选",
    boardLimitMetadata: "涨跌停规则元数据", boardLimitCovered: "涨跌停元数据覆盖", boardLimitUniverse: "涨跌停检测范围", marketRows: "行情股票数", referenceAudit: "参考集审计", selectionDiagnostics: "选取诊断",
    leadership: "龙头数据", leadershipRows: "龙头事实条数", leadershipDiagnostics: "龙头诊断",
  };
  const valueLabels: Record<string, string> = {
    complete: "完整", stale: "已过期", incomplete: "不完整", "before-close": "未覆盖收盘", "close-complete-stored": "收盘批次完整（已存库）", covered: "已覆盖", available: "可用",
    unavailable: "不可用", hydrating: "补充中", cached: "已缓存", online: "在线补齐", partial: "部分补齐", "not-covered": "未覆盖", connected: "已连接", degraded: "已降级", disabled: "已停用",
    forum: "论坛", news: "新闻", announcement: "公告", "eastmoney-announcements": "公司公告", "eastmoney-stock-news": "个股新闻",
    "eastmoney-fast-news": "财经快讯", "authorized-forum": "授权论坛", "eastmoney-guba": "东方财富股吧", "eastmoney-guba-replies": "东方财富股吧评论",
  };
  const label = (raw: string) => valueLabels[raw] ?? raw;
  const keyLabel = (raw: string) => keyLabels[raw] ?? raw;
  const formatValue = (raw: string) => {
    const separator = raw.indexOf(":");
    if (separator > 0) return `${label(raw.slice(0, separator).trim())}：${label(raw.slice(separator + 1).trim())}`;
    return label(raw);
  };
  return Object.entries(value).flatMap(([key, item]) => {
    if (Array.isArray(item)) {
      const values = item.map((entry) => {
        const record = asRecord(entry);
        const id = asString(record.id);
        const state = asString(record.state);
        return id && state ? `${label(id)}：${label(state)}` : asString(entry) ? formatValue(asString(entry)!) : "";
      }).filter(Boolean);
      return values.length ? [[keyLabel(key), values.join(" · ")]] : [];
    }
    if (typeof item === "string") return [[keyLabel(key), formatValue(item)]];
    if (typeof item === "number" || typeof item === "boolean") return [[keyLabel(key), String(item)]];
    return [];
  });
}
