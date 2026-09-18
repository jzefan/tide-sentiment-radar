import type { SentimentEvent, SourceKind } from "../src/domain/types.ts";

export type EventCategory =
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

export interface EventCluster {
  id: string;
  signature: string;
  category: EventCategory;
  primaryTitle: string;
  stockCodes: string[];
  eventIds: string[];
  sources: string[];
  sourceKinds: SourceKind[];
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

export interface HistoricalEventEvidence {
  title: string;
  publishedAt: string;
  sourceKind?: SourceKind | null;
}

const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value));

export function normalizeEventTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[【】\[\]（）()《》“”"'·•：:，,。.!！?？、\-_/\\|]/g, " ")
    .replace(/(?:最新|快讯|公告|关于|股份有限公司|有限责任公司)/g, " ")
    .replace(/\s+/g, "")
    .trim();
}

function bigrams(value: string): Set<string> {
  const text = normalizeEventTitle(value);
  if (!text) return new Set();
  if (text.length === 1) return new Set([text]);
  const result = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) {
    result.add(text.slice(index, index + 2));
  }
  return result;
}

export function eventTitleSimilarity(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
}

export function classifyEventCategory(title: string): EventCategory {
  // 例行文件先归入 other：法律意见书、股东大会、业绩说明会、担保/募集资金进展等
  // 不是「新变化」，不能让它们靠来源权威混进事件通道。
  if (isRoutineFiling(title)) return "other";
  const text = normalizeEventTitle(title);
  if (/(重组|并购|收购|资产置换|借壳|控制权变更)/.test(text)) return "ma";
  if (/(业绩预告|业绩快报|净利润|营收|预增|预减|扭亏|亏损|盈利|年报|季报|中报)/.test(text)) return "earnings";
  if (/(中标|订单|合同|签约|框架协议|采购协议|销售协议)/.test(text)) return "order";
  // 只用真正的政策词：裸「意见」会把「法律意见书」误判成政策事件。
  if (/(政策|规划|条例|补贴|监管|发改委|国务院|工信部|证监会|财政部|央行)/.test(text)) return "policy";
  if (/(回购|增持|员工持股|股权激励)/.test(text)) return "buyback";
  if (/(新品|新产品|量产|商业化|获批|认证|技术突破|研发进展|发布会)/.test(text)) return "product";
  if (/(定增|融资|募资|发行|配股|可转债|债券)/.test(text)) return "capital";
  if (/(行业|产业链|涨价|供给|需求|景气|产能|库存|价格周期)/.test(text)) return "industry";
  if (/(减持|处罚|调查|立案|风险|终止|诉讼|违约)/.test(text)) return "risk";
  return "other";
}

/** 明确的交易性事件用词：出现这些词一律不降级（重组决议公告、重大合同签署都算真催化）。 */
const DEAL_CATALYST = /(重组|并购|收购|借壳|控制权变更|中标|订单|重大合同|签署|签订|框架协议|增持|业绩预告|业绩快报|预增|预减|扭亏|净利润|获批|量产|商业化|技术突破|涨价)/;
/** 宽泛催化词：单独出现不足以豁免「例行文件」判定（回购有「回购公司股份」与「回购注销」之分）。 */
const BROAD_CATALYST = /(回购|政策|规划|补贴)/;
/** 例行文件的强特征：即使命中宽泛催化词也按例行处理。 */
const ROUTINE_OVERRIDE = /(股东会|决议公告|回购注销|限制性股票)/;

/**
 * 例行文件识别：这些公告只是合规流程或日常经营动作，不是「今天出现的新变化」。
 * 命中后按「普通公司新闻」处理并封顶重要度，使它无法单独进入事件通道（门槛 60）。
 */
const ROUTINE_FILING_PATTERNS = [
  "法律意见书", "股东大会", "董事会决议", "监事会", "会议通知", "业绩说明会",
  "投资者关系", "网上说明会", "异常波动", "风险提示", "股权登记", "停复牌",
  "独立董事", "持续督导", "保荐", "会计师事务所", "审计机构", "更正公告",
  "限售股上市流通", "募集资金", "现金管理", "对外担保", "为子公司提供担保",
  "担保的进展", "担保额度", "延期回复", "问询函", "融资租赁", "进展公告",
];

export function isRoutineFiling(title: string): boolean {
  const text = normalizeEventTitle(title);
  if (!text) return false;
  // 1) 明确的交易性事件优先：重组/重大合同/签署/增持等一律不降级。
  if (DEAL_CATALYST.test(text)) return false;
  // 2) 例行强特征优先于「回购 / 政策」这类宽泛词：
  //    「回购注销限制性股票」「临时股东会决议公告」不是催化。
  if (ROUTINE_OVERRIDE.test(text)) return true;
  // 3) 其余宽泛催化词仍按非例行处理。
  if (BROAD_CATALYST.test(text)) return false;
  // 4) 常规例行清单。
  return ROUTINE_FILING_PATTERNS.some((pattern) => text.includes(pattern));
}

export function eventCategoryImportance(category: EventCategory): number {
  return {
    ma: 90,
    earnings: 85,
    order: 80,
    policy: 80,
    buyback: 75,
    product: 70,
    industry: 65,
    capital: 60,
    risk: 35,
    other: 50,
  }[category];
}

export function eventCategoryPersistence(category: EventCategory): number {
  return {
    ma: 90,
    policy: 85,
    earnings: 80,
    order: 80,
    buyback: 70,
    product: 70,
    industry: 65,
    capital: 60,
    risk: 40,
    other: 45,
  }[category];
}

function sourceAuthority(kind: SourceKind): number {
  return kind === "announcement" ? 100
    : kind === "news" ? 78
      : kind === "market" ? 50
        : 35;
}

function toneValue(tone: SentimentEvent["tone"]): number {
  return tone === "positive" ? 100 : tone === "negative" ? 0 : 50;
}

function hash32(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function relatedCodes(event: SentimentEvent): string[] {
  return [...new Set(event.relatedStocks.map((stock) => stock.code).filter(Boolean))].sort();
}

function sharesStock(left: SentimentEvent, right: SentimentEvent): boolean {
  const leftCodes = new Set(relatedCodes(left));
  return relatedCodes(right).some((code) => leftCodes.has(code));
}

function closeInTime(left: SentimentEvent, right: SentimentEvent): boolean {
  const a = Date.parse(left.publishedAt);
  const b = Date.parse(right.publishedAt);
  return Number.isFinite(a) && Number.isFinite(b)
    ? Math.abs(a - b) <= 48 * 3_600_000
    : false;
}

function canCluster(left: SentimentEvent, right: SentimentEvent): boolean {
  if (!sharesStock(left, right) || !closeInTime(left, right)) return false;
  if (
    left.sourceKind === "announcement"
    && right.sourceKind === "announcement"
    && left.id
    && left.id === right.id
  ) return true;
  return eventTitleSimilarity(left.title, right.title) >= 0.5;
}

/**
 * 时效分：相对参考时刻（默认取当日 15:00）越新越高。
 * 早期版本这里写死 100，等于给所有事件白送 10 分，把例行公告也推过了重要度门槛。
 */
export function timelinessScore(publishedAt: string, referenceAt: number): number {
  const at = Date.parse(publishedAt);
  if (!Number.isFinite(at) || !Number.isFinite(referenceAt)) return 0;
  const hours = (referenceAt - at) / 3_600_000;
  if (hours <= 24) return 100;
  if (hours <= 72) return 60;
  return 30;
}

/** 例行文件的重要度上限：低于事件通道门槛 60，无法单独成事件。 */
export const ROUTINE_IMPORTANCE_CAP = 55;
/** 例行文件的持续性上限。 */
export const ROUTINE_PERSISTENCE_CAP = 45;

export function buildEventClusters(events: SentimentEvent[], referenceDate?: string | null): EventCluster[] {
  const ordered = [...events].sort(
    (left, right) =>
      left.publishedAt.localeCompare(right.publishedAt)
      || left.id.localeCompare(right.id),
  );
  // 参考时刻：优先用调用方给的交易日（当日 15:00 北京时间），否则退回本批最新一条的时间，
  // 这样单测与离线重建不依赖系统时钟，仍然是确定性的。
  const referenceAt = (() => {
    if (referenceDate && /^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) {
      const at = Date.parse(`${referenceDate}T15:00:00+08:00`);
      if (Number.isFinite(at)) return at;
    }
    const times = ordered.flatMap((event) => {
      const at = Date.parse(event.publishedAt);
      return Number.isFinite(at) ? [at] : [];
    });
    return times.length ? Math.max(...times) : Number.NaN;
  })();
  const groups: SentimentEvent[][] = [];

  for (const event of ordered) {
    const group = groups.find((candidate) =>
      candidate.some((existing) => canCluster(existing, event)));
    if (group) group.push(event);
    else groups.push([event]);
  }

  return groups
    .map((group): EventCluster => {
      const primary = [...group].sort((left, right) => {
        const authority = sourceAuthority(right.sourceKind) - sourceAuthority(left.sourceKind);
        if (authority) return authority;
        const confidence = right.confidence - left.confidence;
        return confidence || left.publishedAt.localeCompare(right.publishedAt);
      })[0]!;
      const category = classifyEventCategory(primary.title);
      const stockCodes = [...new Set(group.flatMap(relatedCodes))].sort();
      const sources = [...new Set(group.map((event) => event.source).filter(Boolean))].sort();
      const sourceKinds = [...new Set(group.map((event) => event.sourceKind))];
      const weights = group.map(
        (event) => Math.max(1, event.confidence) * sourceAuthority(event.sourceKind),
      );
      const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
      const direction = group.reduce(
        (sum, event, index) => sum + toneValue(event.tone) * weights[index]!,
        0,
      ) / totalWeight;
      const confidence = group.reduce(
        (sum, event, index) => sum + event.confidence * weights[index]!,
        0,
      ) / totalWeight;
      const authority = group.reduce(
        (sum, event, index) => sum + sourceAuthority(event.sourceKind) * weights[index]!,
        0,
      ) / totalWeight;
      const corroboration = clamp((sources.length - 1) * 22);
      const directness = stockCodes.length === 1 ? 100 : stockCodes.length <= 3 ? 80 : 60;
      const published = group.map((event) => event.publishedAt).sort();
      // 时效按「本簇最新一条证据」计算：老公告被今天的新报道再次确认时，簇本身是新鲜的。
      const timeliness = timelinessScore(published.at(-1) ?? "", referenceAt);
      const routine = isRoutineFiling(primary.title);
      const rawImportance = clamp(
        eventCategoryImportance(category) * 0.35
        + authority * 0.25
        + corroboration * 0.20
        + timeliness * 0.10
        + directness * 0.10,
      );
      // 例行文件按「普通公司新闻」封顶：来源权威与个股相关度不再把它抬进事件通道。
      const importance = routine
        ? Math.min(rawImportance, ROUTINE_IMPORTANCE_CAP)
        : rawImportance;
      const persistence = routine
        ? Math.min(eventCategoryPersistence(category), ROUTINE_PERSISTENCE_CAP)
        : eventCategoryPersistence(category);
      const signatureSource =
        `${category}|${stockCodes.join(",")}|${normalizeEventTitle(primary.title)}`;

      return {
        id: `evt-${hash32(signatureSource)}`,
        signature: hash32(signatureSource),
        category,
        primaryTitle: primary.title,
        stockCodes,
        eventIds: [...new Set(group.map((event) => event.id).filter(Boolean))].sort(),
        sources,
        sourceKinds,
        firstPublishedAt: published[0] ?? "",
        lastPublishedAt: published.at(-1) ?? "",
        evidenceCount: group.length,
        independentSourceCount: sources.length,
        authorityCount: group.filter(
          (event) => event.sourceKind === "announcement" || event.sourceKind === "news",
        ).length,
        direction: Math.round(direction),
        confidence: Math.round(confidence),
        importance: Math.round(importance),
        persistence,
      };
    })
    .sort(
      (left, right) =>
        right.importance - left.importance
        || right.independentSourceCount - left.independentSourceCount
        || left.id.localeCompare(right.id),
    );
}

/** 北京时间自然日的零点，用于「几天前」的口径：按日历日比较，不按 24 小时切分。 */
function shanghaiDayStart(epochMs: number): number {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epochMs));
  return Date.parse(`${date}T00:00:00+08:00`);
}

/**
 * 事件新鲜度（设计 §8）：
 * 今天重复转载 20 / 昨日已出现 25 / 2–3 日前 50 / 4 日以上 70 / 从未出现 100。
 *
 * 「几天前」按北京时间自然日差计算。早期版本用 24 小时制，
 * 会把「昨天 10:00」到「今天 15:00」的 1.2 天算成 2–3 日前，昨日事件被高估。
 */
export function scoreEventNovelty(
  cluster: Pick<EventCluster, "primaryTitle" | "sourceKinds">,
  historical: HistoricalEventEvidence[],
  currentTradeDate: string,
): number {
  const matches = historical
    .map((item) => ({
      item,
      similarity: eventTitleSimilarity(cluster.primaryTitle, item.title),
    }))
    .filter((value) => value.similarity >= 0.5)
    .sort((left, right) => right.item.publishedAt.localeCompare(left.item.publishedAt));

  if (!matches.length) return 100;

  const latest = matches[0]!.item;
  const currentAt = Date.parse(`${currentTradeDate}T15:00:00+08:00`);
  const previousAt = Date.parse(latest.publishedAt);
  const dayDiff = Number.isFinite(currentAt) && Number.isFinite(previousAt)
    ? Math.max(0, Math.round((shanghaiDayStart(currentAt) - shanghaiDayStart(previousAt)) / 86_400_000))
    : 0;
  let novelty = dayDiff <= 0 ? 20 : dayDiff <= 1 ? 25 : dayDiff <= 3 ? 50 : 70;

  // 传闻 → 正式公告属于实质性更新（设计 §8 materialUpdate）：即使昨天出现过，也按新信息处理。
  const currentAnnouncement = cluster.sourceKinds.includes("announcement");
  const previousAnnouncement = matches.some(
    (match) => match.item.sourceKind === "announcement",
  );
  if (currentAnnouncement && !previousAnnouncement) novelty = Math.max(novelty, 75);
  return novelty;
}
