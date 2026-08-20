export type SentimentTone = "positive" | "negative" | "mixed" | "neutral";
export type SignalLabel = "偏多共振" | "热度观察" | "高分歧" | "风险升温" | "证据不足";
export type SourceKind = "news" | "forum" | "announcement" | "market";
export type ClueCategory = "新闻事件" | "公司公告" | "用户讨论";
export type EventType = "宏观" | "政策" | "行业" | "公司" | "海外";
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

/** 每日舆情快照：某交易日某只股票的线索聚合结果（用于历史异动回看，不含行情字段）。 */
export interface DailySentimentSnapshot {
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
  priceHistory: PricePoint[];
  sourceMix: Record<string, number>;
  asOf: string;
  isWatchlisted?: boolean;
  /** 异动标签：涨幅大（涨幅前100）/ 跌幅大（跌幅前50）与 成交额大（成交额前150）。 */
  moverTags?: MoverTag[];
  /** 涨跌幅榜名次（1-based）：pctChange>0 为涨幅榜名次，pctChange<0 为跌幅榜名次，未入选为 null。 */
  changeRank?: number | null;
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
