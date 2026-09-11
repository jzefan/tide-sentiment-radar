import type { DailyCandidateEntryResponse, DailyCandidateOrigin, DailyCandidateStatus } from "./api";

export type DailyFocusStatusTone = "up" | "down" | "warning" | "neutral";
export const DAILY_FOCUS_REFRESH_MS = 60_000;

/** Convert internal strategy grades into plain-language labels for the page. */
export function dailyFocusCandidateStrength(grade: "A" | "B"): "强信号" | "达标信号" {
  return grade === "A" ? "强信号" : "达标信号";
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

/** 最终分的构成文案：基础六维 + 龙头加分 − 过热扣分。 */
export function dailyFocusScoreBreakdown(entry: { baseScore: number; finalScore: number; overheatPenalty: number }): string {
  const bonus = Math.max(0, entry.finalScore - entry.baseScore + entry.overheatPenalty);
  return bonus > 0
    ? `基础 ${entry.baseScore.toFixed(1)} + 龙头 ${bonus.toFixed(1)} − 过热 ${entry.overheatPenalty.toFixed(1)}`
    : `基础 ${entry.baseScore.toFixed(1)} − 过热 ${entry.overheatPenalty.toFixed(1)}`;
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
