import type { EventType, SentimentTone } from "../src/domain/types.ts";

const POSITIVE = ["增长", "上调", "突破", "中标", "回购", "增持", "改善", "超预期", "涨价", "扩产", "订单", "利好", "领先", "放量", "盈利", "扭亏", "同比增", "创新高", "看多", "上涨", "涨停", "高开", "走强", "反弹", "主升", "起飞", "加仓", "抄底", "大肉"];
const NEGATIVE = ["下调", "减持", "亏损", "处罚", "调查", "跌破", "回撤", "暴雷", "违约", "风险", "下滑", "不及预期", "召回", "终止", "立案", "同比降", "大跌", "减值", "看空", "下跌", "跌停", "低开", "套牢", "割肉", "清仓", "砸盘", "阴跌", "爆仓", "跑路"];

const CATEGORY_WORDS: Array<[EventType, string[]]> = [
  ["政策", ["国务院", "发改委", "工信部", "政策", "监管", "补贴", "规划", "证监会"]],
  ["海外", ["美联储", "海外", "关税", "美元", "纳斯达克", "国际", "出口限制", "港交所"]],
  ["公司", ["公告", "董事会", "股东", "业绩", "中标", "回购", "减持", "半年报", "年报"]],
  ["宏观", ["居民消费价格", "采购经理指数", "利率", "社融", "宏观", "汇率", "流动性"]],
];

const TOPIC_WORDS: Record<string, string[]> = {
  算力: ["算力", "光模块", "服务器", "人工智能芯片", "数据中心"],
  半导体: ["半导体", "芯片", "存储", "晶圆", "封测"],
  新能源: ["储能", "电池", "光伏", "风电", "新能源汽车"],
  资源品: ["黄金", "铜价", "有色", "稀土", "原油"],
  消费: ["白酒", "消费", "零售", "食品饮料", "免税"],
  金融: ["银行", "券商", "保险", "息差", "红利"],
  医药: ["医药", "创新药", "医疗器械", "临床", "医保"],
  机器人: ["机器人", "自动化", "减速器", "人形机器人"],
};

export interface TextClassification {
  tone: SentimentTone;
  score: number;
  confidence: number;
  eventType: EventType;
  keywords: string[];
  topics: string[];
}

export function classifyText(text: string): TextClassification {
  const normalized = text.trim().slice(0, 10_000);
  const positiveHits = POSITIVE.filter((word) => hasAffirmedPhrase(normalized, word));
  const negativeHits = NEGATIVE.filter((word) => hasAffirmedPhrase(normalized, word));
  const raw = positiveHits.length - negativeHits.length;
  const score = Math.max(-100, Math.min(100, raw * 18));
  const tone: SentimentTone = raw > 0 ? "positive" : raw < 0 ? "negative" : "neutral";
  const eventType = CATEGORY_WORDS.find(([, words]) => words.some((word) => normalized.includes(word)))?.[0] ?? "行业";
  const topics = Object.entries(TOPIC_WORDS)
    .filter(([, words]) => words.some((word) => normalized.includes(word)))
    .map(([name]) => name)
    .slice(0, 5);
  const keywords = Array.from(new Set([...positiveHits, ...negativeHits, ...topics])).slice(0, 7);
  const confidence = Math.min(92, 52 + (positiveHits.length + negativeHits.length + topics.length) * 6);
  return { tone, score, confidence, eventType, keywords, topics };
}

function hasAffirmedPhrase(text: string, phrase: string) {
  const index = text.indexOf(phrase);
  if (index < 0) return false;
  const prefix = text.slice(Math.max(0, index - 3), index);
  return !/(不|没|未|不会|并非)$/.test(prefix);
}

export function topicKeywords() {
  return TOPIC_WORDS;
}
