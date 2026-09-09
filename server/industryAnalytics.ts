import type { SentimentEvent, SentimentTone, StockSnapshot } from "../src/domain/types.ts";
import { industryCodeForName, normalizeIndustryName } from "./industry.ts";
import { getIndustryHistoricalRelationship } from "./database.ts";

/**
 * 行业分析的输入只依赖当前快照。文本指标与行情指标在此处保持两条独立链路：
 * - textHeat、textDirection 只读取事件文本分析结果和来源元数据；
 * - marketStrength、industryReturn 只读取行情字段。
 * 这使接口可以明确说明“当前状态”，也不会把当天涨跌幅写回舆情方向。
 */
export interface IndustrySource {
  stocks: StockSnapshot[];
  events: SentimentEvent[];
  asOf: string;
  clueAsOf?: string;
  tradeDate: string;
}

export type IndustryRelation = "舆情交易双热" | "舆情升温、价格未确认" | "交易驱动" | "常态行业";
export type IndustryStage = "新晋热点" | "当前活跃" | "常态" | "观察中";
export type IndustryDriver = "政策驱动" | "供需价格驱动" | "景气业绩驱动" | "技术产品驱动" | "风险事件驱动" | "用户讨论驱动" | "复合驱动" | "证据不足";

export interface IndustryProfile {
  code: string;
  name: string;
  parent: string;
  /** 东方财富实时字段通常只提供平级名称，不在此处伪造行业树层级。 */
  level: "行业" | "细分行业";
  taxonomy: "东方财富行业" | "内置行业规则" | "环境变量映射";
}

export interface IndustryHistoryState {
  status: "尚无行业快照" | "尚无热点快照" | "等待T+1结果" | "观察中" | "探索性" | "正向关联" | "负向关联" | "未见稳定关系";
  horizon: "T+1" | "T+3" | "T+5" | "T+10";
  sampleCount: number;
  incrementalExcess: number | null;
  interval: { low: number; high: number } | null;
  note: string;
  observingCount?: number;
  latestSignalTradeDate?: string | null;
}

export interface IndustryPulse {
  profile: IndustryProfile;
  textHeat: number;
  textDirection: number;
  textConfidence: number;
  marketStrength: number;
  industryReturn: number;
  marketExcess: number;
  breadth: number;
  amountShare: number;
  relation: IndustryRelation;
  stage: IndustryStage;
  driver: IndustryDriver;
  informationCategories: string[];
  independentEvents: number;
  mentionCount: number;
  discussionCount: number;
  sourceCount: number;
  stockCoverage: number;
  eligibleStockCount: number;
  historicalRelationship: IndustryHistoryState;
  evidence: Array<{ id: string; title: string; source: string; publishedAt: string; tone: SentimentTone; confidence: number }>;
}

export interface IndustryStockContribution {
  code: string;
  name: string;
  industry: IndustryProfile;
  pctChange: number;
  marketReturn: number;
  industryReturn: number;
  marketExcess: number;
  industryPart: number;
  stockSpecificPart: number;
  state: "行业与个股共同上涨" | "行业支撑、个股落后" | "个股独立走强" | "行业拖累" | "行业与个股共同走弱" | "待观察";
}

export interface IndustryAnalyticsResult {
  asOf: string;
  clueAsOf: string | null;
  tradeDate: string;
  benchmark: "全市场等权";
  textMetricsExcludePrice: true;
  items: IndustryPulse[];
  stocks: IndustryStockContribution[];
}

interface InternalGroup {
  profile: IndustryProfile;
  stocks: StockSnapshot[];
  events: SentimentEvent[];
}

interface Rule {
  profile: Omit<IndustryProfile, "taxonomy">;
  aliases: string[];
}

/** 内置规则用于没有行业接口时的可解释兜底；部署环境可以用 TIDE_INDUSTRY_MAP 覆盖个股归属。 */
const RULES: Rule[] = [
  { profile: { code: "industry-electronics", name: "电子", parent: "电子", level: "行业" }, aliases: ["电子", "半导体", "芯片", "晶圆", "封测", "光模块", "元器件", "消费电子"] },
  { profile: { code: "industry-computer", name: "计算机", parent: "计算机", level: "行业" }, aliases: ["计算机", "软件", "服务器", "数据中心", "人工智能", "算力", "信创", "应用软件"] },
  { profile: { code: "industry-machinery", name: "机械设备", parent: "机械设备", level: "行业" }, aliases: ["机械", "机器人", "自动化", "减速器", "机床", "专用设备", "通用设备"] },
  { profile: { code: "industry-pharma", name: "医药生物", parent: "医药生物", level: "行业" }, aliases: ["医药", "创新药", "医疗", "药业", "生物", "医疗器械", "疫苗"] },
  { profile: { code: "industry-new-energy", name: "电力设备", parent: "电力设备", level: "行业" }, aliases: ["新能源", "电池", "光伏", "风电", "储能", "锂电", "电力设备"] },
  { profile: { code: "industry-auto", name: "汽车", parent: "汽车", level: "行业" }, aliases: ["汽车", "零部件", "新能源汽车", "智能驾驶", "汽车电子"] },
  { profile: { code: "industry-consumer", name: "食品饮料", parent: "食品饮料", level: "行业" }, aliases: ["白酒", "食品", "饮料", "消费", "零售", "乳业", "免税"] },
  { profile: { code: "industry-finance", name: "金融", parent: "金融", level: "行业" }, aliases: ["银行", "券商", "证券", "保险", "金融", "信托"] },
  { profile: { code: "industry-resources", name: "有色金属", parent: "有色金属", level: "行业" }, aliases: ["有色", "黄金", "铜", "铝", "稀土", "锂矿", "资源"] },
  { profile: { code: "industry-chemical", name: "基础化工", parent: "基础化工", level: "行业" }, aliases: ["化工", "材料", "化纤", "农化", "氟化工"] },
];

const SOURCE_QUALITY: Record<string, number> = { announcement: 0.95, news: 0.82, forum: 0.55 };
const EVENT_DIRECTION: Record<SentimentTone, number> = { positive: 72, negative: -72, mixed: 0, neutral: 0 };

export function classifyStockIndustry(stock: Pick<StockSnapshot, "code" | "name"> & { industry?: StockSnapshot["industry"] }): IndustryProfile | null {
  const mapped = loadIndustryMap()[stock.code];
  if (mapped) return { ...mapped, taxonomy: "环境变量映射" };
  // 股票快照里的行业字段位于 `industry.name`。不能把整个对象传给
  // normalizeIndustryName，否则 String(object) 会变成 `[object Object]`，
  // 进而让所有股票落入同一个伪行业，破坏热点聚合与收益归因。
  const sourceIndustry = normalizeIndustryName(stock.industry?.name);
  if (sourceIndustry) {
    return {
      code: industryCodeForName(sourceIndustry),
      name: sourceIndustry,
      parent: sourceIndustry,
      level: "行业",
      taxonomy: "东方财富行业",
    };
  }
  const text = stock.name.replace(/[（(].*?[）)]/g, "");
  const matched = RULES.find((rule) => rule.aliases.some((alias) => text.includes(alias)));
  return matched ? { ...matched.profile, code: industryCodeForName(matched.profile.name), taxonomy: "内置行业规则" } : null;
}

export function buildIndustryAnalytics(source: IndustrySource): IndustryAnalyticsResult {
  const marketReturn = average(source.stocks.map((stock) => stock.pctChange));
  const groups = new Map<string, InternalGroup>();
  for (const stock of source.stocks) {
    const profile = classifyStockIndustry(stock);
    if (!profile) continue;
    const group = groups.get(profile.code) ?? { profile, stocks: [], events: [] };
    group.stocks.push(stock);
    groups.set(profile.code, group);
  }

  const eventsByCode = new Map<string, SentimentEvent[]>();
  for (const event of source.events) {
    for (const related of event.relatedStocks) {
      const list = eventsByCode.get(related.code) ?? [];
      list.push(event);
      eventsByCode.set(related.code, list);
    }
  }
  for (const group of groups.values()) {
    const seen = new Set<string>();
    for (const stock of group.stocks) {
      for (const event of eventsByCode.get(stock.code) ?? []) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        group.events.push(event);
      }
    }
    // 行业级新闻可能没有明确股票代码；只有明确标记为“行业”且文本命中
    // 当前行业名称/别名时才补入，避免把单家公司新闻扩散到整个行业。
    const aliases = industryAliases(group.profile);
    for (const event of source.events) {
      if (seen.has(event.id) || event.category === "公司公告" || event.eventType !== "行业") continue;
      const text = `${event.title} ${event.summary} ${event.topics.join(" ")}`;
      if (aliases.some((alias) => alias && text.includes(alias))) {
        seen.add(event.id);
        group.events.push(event);
      }
    }
  }
  const groupsWithEvents = [...groups.values()].filter((group) => group.events.length > 0);
  const heatBase = groupsWithEvents.map((group) => rawTextHeat(group.events, group.stocks.length));
  // 采用固定可解释口径，不在当前截面内按最大值归一化；否则只出现一个行业时，
  // 一条线索也会被错误抬成100分热点。
  const pulses = groupsWithEvents.map((group, index) => buildPulse(group, source, marketReturn, Math.round(heatBase[index])));
  pulses.sort((a, b) => b.textHeat - a.textHeat || b.marketStrength - a.marketStrength);

  const profileToPulse = new Map(pulses.map((pulse) => [pulse.profile.code, pulse]));
  const stocks = source.stocks.flatMap((stock): IndustryStockContribution[] => {
    const profile = classifyStockIndustry(stock);
    const pulse = profile ? profileToPulse.get(profile.code) : undefined;
    if (!profile || !pulse) return [];
    return [{
      code: stock.code,
      name: stock.name,
      industry: profile,
      pctChange: round(stock.pctChange),
      marketReturn: round(marketReturn),
      industryReturn: pulse.industryReturn,
      marketExcess: pulse.marketExcess,
      industryPart: round(pulse.industryReturn - marketReturn),
      stockSpecificPart: round(stock.pctChange - pulse.industryReturn),
      state: contributionState(stock.pctChange, pulse.industryReturn, marketReturn),
    }];
  });

  return {
    asOf: source.asOf,
    clueAsOf: source.clueAsOf ?? null,
    tradeDate: source.tradeDate,
    benchmark: "全市场等权",
    textMetricsExcludePrice: true,
    items: pulses,
    stocks,
  };
}

export function filterIndustryAnalytics(result: IndustryAnalyticsResult, params: { query?: string; hotOnly?: boolean; code?: string; relation?: string } = {}) {
  const query = params.query?.trim().toLowerCase() ?? "";
  const items = result.items.filter((item) => {
    const matchesQuery = !query || `${item.profile.name}${item.profile.parent}${item.driver}${item.stage}`.toLowerCase().includes(query);
    const matchesHot = !params.hotOnly || (item.textHeat >= 70 && (item.relation === "舆情交易双热" || item.relation === "舆情升温、价格未确认"));
    const matchesCode = !params.code || item.profile.code === params.code;
    const matchesRelation = !params.relation || item.relation === params.relation;
    return matchesQuery && matchesHot && matchesCode && matchesRelation;
  });
  return { ...result, items };
}

function buildPulse(group: InternalGroup, source: IndustrySource, marketReturn: number, normalizedHeat: number): IndustryPulse {
  const events = group.events;
  const independentEvents = dedupeEvents(events).length;
  const textDirection = direction(events);
  const discussionCount = events.filter((event) => event.sourceKind === "forum").length;
  const sourceCount = new Set(events.map((event) => event.source)).size;
  const stockCoverage = new Set(events.flatMap((event) => event.relatedStocks.filter((stock) => group.stocks.some((item) => item.code === stock.code)).map((stock) => stock.code))).size;
  const industryReturn = average(group.stocks.map((stock) => stock.pctChange));
  const marketExcess = industryReturn - marketReturn;
  const breadth = group.stocks.length ? group.stocks.filter((stock) => stock.pctChange > 0).length / group.stocks.length : 0;
  const amountTotal = source.stocks.reduce((sum, stock) => sum + Math.max(0, stock.amount), 0);
  const amountShare = amountTotal ? group.stocks.reduce((sum, stock) => sum + Math.max(0, stock.amount), 0) / amountTotal : 0;
  // 行情强度只描述已发生的价格/流动性：成交额占比作为小权重确认项，
  // 不进入文本热度或情绪方向，避免循环论证。
  const marketStrength = clamp(Math.round(50 + marketExcess * 9 + (breadth - 0.5) * 45 + Math.min(8, amountShare * 0.2)));
  const textHeat = Math.max(0, Math.min(100, normalizedHeat));
  const textHot = textHeat >= 70 && independentEvents >= 3 && sourceCount >= 2 && stockCoverage >= 3;
  const relation = textHot && marketStrength >= 65 ? "舆情交易双热" : textHot ? "舆情升温、价格未确认" : marketStrength >= 65 ? "交易驱动" : "常态行业";
  // 生命周期也遵守热点成立门槛；覆盖股票不足时，即使文本声量很高，
  // 也只能称为观察中，避免出现“常态行业 · 新晋热点”的相互矛盾标签。
  const stage: IndustryStage = textHot
    ? textHeat >= 80
      ? "新晋热点"
      : "当前活跃"
    : textHeat >= 35
      ? "观察中"
      : "常态";
  const evidence = [...events].sort((a, b) => new Date(b.publishedAt).valueOf() - new Date(a.publishedAt).valueOf()).slice(0, 5).map((event) => ({ id: event.id, title: event.title, source: event.source, publishedAt: event.publishedAt, tone: event.tone, confidence: event.confidence }));
  return {
    profile: group.profile,
    textHeat,
    textDirection,
    textConfidence: Math.round(Math.min(96, 38 + independentEvents * 7 + Math.min(20, sourceCount * 5) + Math.min(16, stockCoverage * 3))),
    marketStrength,
    industryReturn: round(industryReturn),
    marketExcess: round(marketExcess),
    breadth: round(breadth * 100),
    amountShare: round(amountShare * 100),
    relation,
    stage,
    driver: inferDriver(events),
    informationCategories: informationCategories(events),
    independentEvents,
    mentionCount: events.length,
    discussionCount,
    sourceCount,
    stockCoverage,
    eligibleStockCount: group.stocks.length,
    historicalRelationship: { ...getIndustryHistoricalRelationship(group.profile.code, 5), horizon: "T+5" },
    evidence,
  };
}

function rawTextHeat(events: SentimentEvent[], stockCount: number) {
  const unique = dedupeEvents(events).length;
  const discussion = events.filter((event) => event.sourceKind === "forum").length;
  const sourceCount = new Set(events.map((event) => event.source)).size;
  const covered = new Set(events.flatMap((event) => event.relatedStocks.map((stock) => stock.code))).size;
  const interaction = average(events.map((event) => Math.min(100, event.heat)));
  // 使用饱和函数保持“事件越多热度越高”，但避免线索量稍大就全部显示100，
  // 否则热点排序失去区分度，也会把普通高声量行业误判成并列头部热点。
  const uniqueScore = 35 * (1 - Math.exp(-unique / 8));
  const discussionScore = 15 * (1 - Math.exp(-discussion / 10));
  const sourceScore = 15 * (1 - Math.exp(-sourceCount / 3));
  const coverageScore = 15 * Math.min(1, covered / Math.max(1, stockCount));
  const interactionScore = 20 * (interaction / 100);
  return uniqueScore + discussionScore + sourceScore + coverageScore + interactionScore;
}

function industryAliases(profile: IndustryProfile): string[] {
  const rule = RULES.find((candidate) => candidate.profile.name === profile.name);
  return [...new Set([profile.name, ...(rule?.aliases ?? [])])];
}

function dedupeEvents(events: SentimentEvent[]) {
  const seen = new Set<string>();
  return events.filter((event) => {
    const fingerprint = event.title.replace(/[\s，。！？,.!?]/g, "").slice(0, 48);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

function direction(events: SentimentEvent[]) {
  let numerator = 0;
  let denominator = 0;
  for (const event of events) {
    const freshness = Math.max(0.2, Math.min(1, event.heat / 100));
    const weight = Math.max(0.1, event.confidence / 100) * (SOURCE_QUALITY[event.sourceKind] ?? 0.5) * freshness;
    numerator += EVENT_DIRECTION[event.tone] * weight;
    denominator += weight;
  }
  return round(clamp(50 + (denominator ? numerator / denominator / 2 : 0)));
}

function informationCategories(events: SentimentEvent[]) {
  const categories = new Set<string>();
  for (const event of events) {
    if (event.category === "用户讨论") categories.add("用户讨论");
    if (event.eventType === "政策") categories.add("政策监管");
    if (event.eventType === "公司") categories.add("景气业绩");
    const text = `${event.title}${event.summary}${event.topics.join("")}`;
    if (/供需|价格|涨价|库存|产能|出口/.test(text)) categories.add("供需价格");
    if (/技术|产品|芯片|模型|设备|发布|研发/.test(text)) categories.add("技术产品");
    if (/风险|事故|处罚|调查|召回|暴雷/.test(text)) categories.add("风险事件");
  }
  return [...categories].slice(0, 4);
}

function inferDriver(events: SentimentEvent[]): IndustryDriver {
  const categories = informationCategories(events);
  if (!events.length) return "证据不足";
  if (events.filter((event) => event.sourceKind === "forum").length >= Math.ceil(events.length * 0.6)) return "用户讨论驱动";
  if (categories.includes("政策监管")) return "政策驱动";
  if (categories.includes("供需价格")) return "供需价格驱动";
  if (categories.includes("景气业绩")) return "景气业绩驱动";
  if (categories.includes("技术产品")) return "技术产品驱动";
  if (categories.includes("风险事件")) return "风险事件驱动";
  return categories.length > 1 ? "复合驱动" : "证据不足";
}

function contributionState(stockReturn: number, industryReturn: number, marketReturn: number): IndustryStockContribution["state"] {
  const industryPart = industryReturn - marketReturn;
  const stockPart = stockReturn - industryReturn;
  if (Math.abs(stockReturn) < 0.1) return "待观察";
  if (stockReturn > 0 && industryPart > 0 && stockPart >= 0) return "行业与个股共同上涨";
  if (stockReturn > 0 && industryPart > 0 && stockPart < 0) return "行业支撑、个股落后";
  if (stockPart > 0 && industryPart <= 0) return "个股独立走强";
  if (stockReturn < 0 && industryPart < 0) return "行业与个股共同走弱";
  if (industryPart < 0) return "行业拖累";
  return "待观察";
}

function loadIndustryMap(): Record<string, Omit<IndustryProfile, "taxonomy">> {
  const raw = process.env.TIDE_INDUSTRY_MAP?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, { code?: string; name?: string; parent?: string; level?: string }>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([stockCode, value]) => value.code && value.name && value.parent ? [[stockCode, { code: value.code, name: value.name, parent: value.parent, level: normalizeIndustryLevel(value.level) }]] : []));
  } catch {
    return {};
  }
}

function normalizeIndustryLevel(value: string | undefined): IndustryProfile["level"] {
  return value === "细分行业" || value === "subindustry" ? "细分行业" : "行业";
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, value));
}

function round(value: number) {
  return Number(value.toFixed(2));
}
