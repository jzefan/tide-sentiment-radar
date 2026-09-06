import { buildIndustryAnalytics, filterIndustryAnalytics, type IndustryAnalyticsResult, type IndustrySource } from "./industryAnalytics.ts";
import { getIndustryForwardOutcomes, getIndustryHistoricalRelationship } from "./database.ts";

/** 行业接口的参数只负责展示筛选，分析逻辑统一在 industryAnalytics.ts。 */
export interface IndustryQuery {
  query?: string;
  hotOnly?: boolean;
  code?: string;
  relation?: string;
  horizon?: 1 | 3 | 5 | 10;
}

export function buildIndustryApiResponse(source: IndustrySource, query: IndustryQuery = {}) {
  const horizon = query.horizon ?? 5;
  const raw = buildIndustryAnalytics(source);
  const result = filterIndustryAnalytics({
    ...raw,
    items: raw.items.map((item) => ({
      ...item,
      historicalRelationship: { ...getIndustryHistoricalRelationship(item.profile.code, horizon), horizon: horizonLabel(horizon) },
    })),
  }, query);
  return {
    ...result,
    items: result.items.map((item) => ({ ...item, profile: { ...item.profile, asOf: source.asOf } })),
    methodology: {
      textHeat: "行业舆情热度只读取独立事件、用户讨论、来源广度、成分股覆盖与线索新鲜度，不读取股票涨跌幅、成交额或行情强度。",
      textDirection: "行业文本方向只读取线索情绪、来源可信度、分析置信度和线索新鲜度。",
      marketStrength: "行业行情强度只读取成分股涨跌幅、全市场等权基准、上涨家数比例和成交额占比。",
      relationship: "当前关系是描述性状态；后验仅统计达到热点门槛的信号日（舆情交易双热或舆情升温、价格未确认），T+1、T+3、T+5、T+10结果在各自观察周期完成后生成。",
      dataCutoff: source.clueAsOf ?? source.asOf,
      version: "行业分析规则 v1",
    },
  };
}

export function getIndustryByCode(source: IndustrySource, code: string): { item: IndustryAnalyticsResult["items"][number]; stocks: IndustryAnalyticsResult["stocks"] } | null {
  const result = buildIndustryAnalytics(source);
  const item = result.items.find((candidate) => candidate.profile.code === code);
  if (!item) return null;
  return { item: { ...item, historicalRelationship: { ...getIndustryHistoricalRelationship(code, 5), horizon: "T+5" } }, stocks: result.stocks.filter((stock) => stock.industry.code === code) };
}

export function getIndustryForwardApi(code: string, horizon: 1 | 3 | 5 | 10 = 5) {
  return {
    industryCode: code,
    horizon: horizonLabel(horizon),
    signalType: "热点行业信号日",
    relationship: { ...getIndustryHistoricalRelationship(code, horizon), horizon: horizonLabel(horizon) },
    outcomes: getIndustryForwardOutcomes(code, horizon, true),
  };
}

function horizonLabel(horizon: 1 | 3 | 5 | 10) {
  return `T+${horizon}` as "T+1" | "T+3" | "T+5" | "T+10";
}
