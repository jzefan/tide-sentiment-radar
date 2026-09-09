export type SentimentTone = "positive" | "negative" | "mixed" | "neutral";
export type SignalLabel = "偏多共振" | "热度观察" | "高分歧" | "风险升温" | "证据不足";
export type SourceKind = "news" | "forum" | "announcement" | "market";
export type ClueCategory = "新闻事件" | "公司公告" | "用户讨论";
export type EventType = "宏观" | "政策" | "行业" | "公司" | "海外" | "未分类";
export type DataComposition = "live" | "partial" | "unavailable";
export type AnalysisStatus = "scored" | "no_clues" | "pending" | "stale";

export interface ScoreFactors {
  sentiment: number;
  attention: number;
  velocity: number;
  consensus: number;
  sourceQuality: number;
  priceConfirm: number;
  freshness: number;
}

export interface PricePoint {
  date: string;
  close: number;
  volume?: number;
}

export type KlinePeriod = "minute" | "daily" | "weekly" | "monthly";

export interface KlinePoint {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  avgPrice?: number | null;
}

export interface KlineResponse {
  period: KlinePeriod;
  source: "eastmoney" | "tencent-mirror" | "cache";
  state: "fresh" | "stale" | "unavailable";
  previousClose?: number | null;
  items: KlinePoint[];
}

export type MoverTag = "涨幅大" | "跌幅大" | "成交额大";

export type IndustryRelationLabel = "舆情交易双热" | "舆情升温、价格未确认" | "交易驱动" | "常态行业";
export type IndustryStageLabel = "新晋热点" | "当前活跃" | "观察中" | "常态";
export type IndustryHistoricalState = "尚无行业快照" | "尚无热点快照" | "等待T+1结果" | "观察中" | "探索性" | "正向关联" | "负向关联" | "未见稳定关系";

/** 股票在行情快照时点的行业归属；行业名称来自行情供应商，历史分类不可静默覆盖。 */
export interface IndustryReference {
  code: string;
  name: string;
  parent: string;
  /** 当前快照只保证行业名称；只有明确提供层级时才标记为细分行业。 */
  level: "行业" | "细分行业";
  taxonomy: "东方财富行业" | "内置行业规则" | "环境变量映射";
  asOf: string;
}

export interface IndustryPulseSummary {
  profile: IndustryReference;
  textHeat: number;
  textDirection: number;
  textConfidence: number;
  marketStrength: number;
  industryReturn: number;
  marketExcess: number;
  breadth: number;
  relation: IndustryRelationLabel;
  stage: IndustryStageLabel;
  driver: string;
  informationCategories: string[];
  independentEvents: number;
  mentionCount: number;
  discussionCount: number;
  sourceCount: number;
  stockCoverage: number;
  eligibleStockCount: number;
  historicalRelationship: {
    status: IndustryHistoricalState;
    horizon: "T+1" | "T+3" | "T+5" | "T+10";
    sampleCount: number;
    incrementalExcess: number | null;
    interval: { low: number; high: number } | null;
    note: string;
  };
}

export interface IndustryAttributionSummary {
  industryReturn: number;
  marketReturn: number;
  marketExcess: number;
  industryPart: number;
  stockSpecificPart: number;
  state: string;
}

/** 每日舆情快照：某交易日某只股票的线索聚合结果（用于历史异动回看，不含行情字段）。 */
export interface DailySentimentSnapshot {
  /** 纯情绪方向，不读取当日行情；用于检验舆情与未来收益的关系。 */
  textDirectionScore?: number | null;
  radarScore: number | null;
  alertScore: number | null;
  signal: SignalLabel;
  analysisStatus: AnalysisStatus;
  factors: ScoreFactors;
  mentionCount: number;
  mentionDelta: number;
  topics: string[];
  summary: string;
  sparkline: number[];
  sentimentTrend: number[];
  sourceMix: Record<string, number>;
}

export interface StockSnapshot {
  code: string;
  name: string;
  market: string;
  quoteUrl?: string;
  price: number;
  pctChange: number;
  /** 当日成交额（元）。 */
  amount: number;
  /** 最近若干交易日的成交额（升序，含当日），用于成交额变化柱状图。 */
  amountHistory?: Array<{ date: string; amount: number }>;
  /** 最近约一个月的日涨跌幅（升序，含当日），用于列表中的历史涨幅曲线。 */
  returnHistory?: Array<{ date: string; pctChange: number }>;
  radarScore: number | null;
  textDirectionScore?: number | null;
  alertScore: number | null;
  signal: SignalLabel;
  analysisStatus: AnalysisStatus;
  factors: ScoreFactors;
  mentionCount: number;
  mentionDelta: number;
  topics: string[];
  summary: string;
  sparkline: number[];
  sentimentTrend: number[];
  priceHistory: PricePoint[];
  sourceMix: Record<string, number>;
  asOf: string;
  isWatchlisted?: boolean;
  /** 异动标签：涨幅大（涨幅前100）/ 跌幅大（跌幅前50）与 成交额大（成交额前150）。 */
  moverTags?: MoverTag[];
  /** 涨跌幅榜名次（1-based）：pctChange>0 为涨幅榜名次，pctChange<0 为跌幅榜名次，未入选为 null。 */
  changeRank?: number | null;
  /** 行情快照时点的主行业；缺失时明确为空，不使用今天的分类回填历史。 */
  industry?: IndustryReference;
  /** 行业舆情、行情和当前关系，文本热度与行情强度独立计算。 */
  industryPulse?: IndustryPulseSummary;
  /** 已实现的行业同行部分与个股相对行业部分，不代表因果贡献。 */
  industryAttribution?: IndustryAttributionSummary;
}

export interface RelatedStock {
  code: string;
  name: string;
  relevance: number;
  reason: string;
  tone: SentimentTone;
}

export interface SentimentEvent {
  id: string;
  title: string;
  category: ClueCategory;
  eventType: EventType;
  publishedAt: string;
  source: string;
  sourceKind: SourceKind;
  tone: SentimentTone;
  confidence: number;
  heat: number;
  summary: string;
  topics: string[];
  relatedStocks: RelatedStock[];
  corroboration: number;
  url?: string;
  /** Adapter provenance; absent events cannot be used for prospective daily freezing. */
  adapterId?: string;
}

export interface MoodPoint {
  time: string;
  positive: number;
  negative: number;
  volume: number;
}

export interface ThemePulse {
  name: string;
  heat: number;
  change: number;
  tone: SentimentTone;
  mentions: number;
}

export interface DashboardData {
  asOf: string;
  dataMode: DataComposition;
  dataMessage: string;
  moodIndex: number;
  moodChange: number;
  breadth: number;
  divergence: number;
  totalMentions: number;
  universeTotal: number;
  analyzedStocks: number;
  sourceCount: number;
  moodSeries: MoodPoint[];
  themes: ThemePulse[];
  hotIndustries?: IndustryPulseSummary[];
  events: SentimentEvent[];
  watchlist: StockSnapshot[];
}

export interface DataSourceStatus {
  id: string;
  name: string;
  description: string;
  kind: SourceKind;
  state: "connected" | "degraded" | "disabled";
  lastSync: string;
  records: string;
  latency?: number;
  repository?: string;
  licenseId?: string;
  termsUrl?: string;
}

export interface SystemStatus {
  mode: DataComposition;
  snapshotAsOf: string;
  marketStore: {
    connected: boolean;
    provider: string;
    tradeDate: string | null;
    rows: number;
    detail: string;
  };
  universe: { total: number; analyzed: number; provider: string };
  clues: { total: number; lastSuccessAt: string | null };
  sources: DataSourceStatus[];
}

export interface StockListResponse {
  items: StockSnapshot[];
  /** 筛选与排序后的实际条数（表格“筛选结果”）。 */
  total: number;
  /** 当前范围内未过滤的股票总数（页头徽标，不随筛选/排序变化）。 */
  universeTotal: number;
  analyzed: number;
  page: number;
  pageSize: number;
  asOf: string;
}

export interface StockDetailResponse {
  stock: StockSnapshot;
  events: SentimentEvent[];
  marketSource: "东方财富行情" | "东方财富行情缓存" | "行情不可用";
  historyState: "fresh" | "stale" | "unavailable";
}
