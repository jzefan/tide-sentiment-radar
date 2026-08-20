import type { EventType, SentimentTone } from "../src/domain/types.ts";
import { FIN_NEGATIVE, FIN_POSITIVE } from "./finLexicon.ts";

/**
 * 可解释中文情绪分类。
 *
 * 判定准则（按信号类型，权重越大越强）：
 * - 正面词（权重 1）：增长/利好/涨停/回购/赚/浮盈 等金融与论坛多头表达。
 * - 负面词（权重 1）：下调/减持/亏损/跌停/套牢/破发/痛失 等空头表达。
 * - 强烈负面（权重 2.5）：咒骂、诅咒、泄愤与愤世表达（天收、报应、割韭菜、圈钱…），单次命中即可判负。
 * - 反讽/愤世（权重 1.5）：王侯将相、权贵、垄断、呵呵、就这、离谱 等带讥讽或怨气的表达。
 * - 反问/质疑句式（权重 1.5）：凭什么、问谁服务、有什么用、不过如此 等负向质问。
 * - 弱负面（权重 0.5）：哎、唉、可惜、无奈 等叹气语气，单独不足以判负。
 *
 * 否定、强调与弱化：
 * - 否定词（不/没/没有/并非/不太…）会把紧随其后的词极性翻转（“不看好”→“看空”）。
 * - 强调词（非常/太/很/严重/大幅…）把强度 ×1.5；弱化词（略/稍微/有点/小幅…）把强度 ×0.5。
 * - 多个词命中时取最长、不重叠的匹配，避免“割韭菜”既算“割韭菜”又算“韭菜”。
 *
 * 得分 = Σ(极性 × 权重 × 语气修正) × 18，截断到 [-100, 100]。
 * 方向判定：score ≥ +15 偏正面；score ≤ -15 偏负面；
 *           两者之间若正负证据并存 → 多空分歧（mixed），否则中性（neutral）。
 */

const POSITIVE = [
  "增长", "上调", "突破", "中标", "回购", "增持", "改善", "超预期", "涨价", "扩产",
  "订单", "利好", "领先", "放量", "盈利", "扭亏", "同比增", "创新高", "看多", "上涨",
  "涨停", "高开", "走强", "反弹", "主升", "起飞", "加仓", "抄底", "大肉",
  "看涨", "唱多", "看好", "建仓", "满仓", "上车", "连板", "翻倍", "大涨", "收涨",
  "飘红", "护盘", "稳了", "真香", "分红", "派息", "业绩增长", "净利增", "营收增",
  "主力流入", "外资流入", "回暖", "复苏", "向好", "企稳", "反包", "新高", "吃肉",
  "赚", "浮盈", "收益", "领涨", "暴涨", "拉升", "涨停板", "涨停潮", "扭亏为盈",
  "获批", "投产", "量产", "翻红", "上行", "牛市", "慢牛", "走牛", "增量", "增资",
];

const NEGATIVE = [
  "下调", "减持", "亏损", "处罚", "调查", "跌破", "回撤", "暴雷", "违约", "风险",
  "下滑", "不及预期", "召回", "终止", "立案", "同比降", "大跌", "减值", "看空", "下跌",
  "跌停", "低开", "套牢", "割肉", "清仓", "砸盘", "阴跌", "爆仓", "跑路",
  "看跌", "唱空", "利空", "崩盘", "股灾", "熔断", "退市", "戴帽", "造假", "欺诈",
  "爆雷", "踩雷", "圈钱", "套现", "减持套现", "内幕", "操纵", "坐庄", "韭菜", "镰刀",
  "收割", "收跌", "飘绿", "绿盘", "破发", "破位", "破净", "缩水", "腰斩", "崩了",
  "凉了", "凉凉", "黄了", "恶心", "垃圾", "忽悠", "坑爹", "圈套", "泡沫", "见顶",
  "顶部", "抛售", "甩卖", "血亏", "巨亏", "深套", "断崖", "变脸", "爆亏", "浮亏",
  "痛失", "非法", "停牌", "冻结", "查封", "退市风险",
];

/** 强烈负面：咒骂、诅咒、泄愤与愤世表达，单次命中即判负。 */
const STRONG_NEGATIVE = [
  "天收", "报应", "遭报应", "遭天谴", "天谴", "该死", "去死", "不得好死", "天打雷劈",
  "断子绝孙", "活该", "完蛋", "完了", "完犊子", "骗局", "诈骗", "骗子", "坑人", "害人",
  "黑心", "割韭菜", "人血馒头", "剥削", "丧尽天良", "天理难容", "天理",
];

/** 反讽 / 愤世表达，权重较普通负面词更强。 */
const SARCASM = [
  "王侯将相", "权贵", "特权", "垄断", "资本收割", "世道", "吃相", "无良", "血汗",
  "呵呵", "呵呵呵", "笑话", "就这", "可笑", "讽刺", "说得好听", "可真行", "无语", "醉了", "离谱", "呵呵哒",
];

/** 弱负面：叹气 / 遗憾语气，单独不足以判负，仅作辅证。 */
const WEAK_NEGATIVE = ["哎！", "哎？", "哎…", "唉", "可惜", "遗憾", "无奈", "叹气"];

/** 反问 / 质疑句式，通常表达不满、失望或批评。 */
const RHETORICAL_PATTERNS: RegExp[] = [
  /凭什么/g,
  /问谁服务|为谁服务|给谁服务|服务谁|谁服务|到底为谁|究竟为谁/g,
  /有什么[用意义]|有何[用意义]|管什么用|顶什么用|有个[屁毛]用/g,
  /算什么|不过如此|也就那样|不过尔尔/g,
];

/** 否定词（含“不太”“没有太”这类组合），紧随命中词之前时翻转极性。 */
const NEGATION_TOKENS = [
  "谈不上", "算不上", "没有太", "没有很", "不是很", "并不是", "并不", "并非", "不再是",
  "不再", "不太", "不怎么", "不很", "没太", "没怎么", "没有", "不是", "不会", "不能",
  "从未", "从不", "绝不", "别", "不", "没", "未", "无", "莫", "勿",
];

/** 强调词：让命中词强度 ×1.5。 */
const INTENSIFIERS = ["非常", "十分", "极其", "极度", "特别", "超级", "严重", "大幅", "彻底", "完全", "狠狠", "狂", "猛", "巨", "太", "很", "极", "爆", "超"];
/** 弱化词：让命中词强度 ×0.5。 */
const DIMINISHERS = ["稍微", "略微", "一点点", "些许", "有点", "有些", "小幅", "轻度", "轻微", "略", "稍", "微"];

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

interface Hit {
  phrase: string;
  start: number;
  end: number;
  polarity: 1 | -1;
  weight: number;
}

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
  const hits = dedupeHits([...lexiconHits(normalized), ...rhetoricalHits(normalized)]);
  const keywords = new Set<string>();

  let sum = 0;
  let positiveEvidence = 0;
  let negativeEvidence = 0;
  for (const hit of hits) {
    const context = contextOf(normalized, hit);
    let polarity = hit.polarity;
    let weight = hit.weight;
    if (context.negated) {
      polarity = polarity === 1 ? -1 : 1;
    } else if (context.intensified) {
      weight *= 1.5;
    } else if (context.diminished) {
      weight *= 0.5;
    }
    const contribution = polarity * weight;
    sum += contribution;
    if (contribution > 0) positiveEvidence += 1;
    else negativeEvidence += 1;
    keywords.add(hit.phrase);
  }

  const topics = Object.entries(TOPIC_WORDS)
    .filter(([, words]) => words.some((word) => normalized.includes(word)))
    .map(([name]) => name)
    .slice(0, 5);
  for (const topic of topics) keywords.add(topic);

  const score = clamp(Math.round(sum * 18), -100, 100);
  const tone = decideTone(score, positiveEvidence, negativeEvidence);
  const eventType = CATEGORY_WORDS.find(([, words]) => words.some((word) => normalized.includes(word)))?.[0] ?? "行业";
  const confidence = Math.min(94, 46 + (hits.length + topics.length) * 7 + Math.min(12, Math.abs(score) / 10));

  return { tone, score, confidence, eventType, keywords: [...keywords].slice(0, 7), topics };
}

function lexiconHits(text: string): Hit[] {
  const hits: Hit[] = [];
  const collect = (phrases: string[], polarity: 1 | -1, weight: number) => {
    for (const phrase of phrases) {
      let index = text.indexOf(phrase);
      while (index >= 0) {
        hits.push({ phrase, start: index, end: index + phrase.length, polarity, weight });
        index = text.indexOf(phrase, index + 1);
      }
    }
  };
  collect(POSITIVE, 1, 1);
  collect(NEGATIVE, -1, 1);
  collect(STRONG_NEGATIVE, -1, 2.5);
  collect(SARCASM, -1, 1.5);
  collect(WEAK_NEGATIVE, -1, 0.5);
  // 姚加权金融社媒词典：半权重补充命中，不覆盖内置精编词表的判定（同位置重复命中由 dedupeHits 去重）。
  collect(FIN_POSITIVE, 1, 0.5);
  collect(FIN_NEGATIVE, -1, 0.5);
  return hits;
}

function rhetoricalHits(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const pattern of RHETORICAL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const phrase = match[0];
      const start = match.index ?? 0;
      hits.push({ phrase, start, end: start + phrase.length, polarity: -1, weight: 1.5 });
    }
  }
  return hits;
}

/** 取最长、不重叠的匹配，避免“割韭菜”与“韭菜”重复计分。 */
function dedupeHits(hits: Hit[]): Hit[] {
  const sorted = [...hits].sort((a, b) => b.end - b.start - (a.end - a.start) || b.weight - a.weight);
  const accepted: Hit[] = [];
  const covered: Array<[number, number]> = [];
  for (const hit of sorted) {
    if (covered.some(([start, end]) => hit.start < end && hit.end > start)) continue;
    accepted.push(hit);
    covered.push([hit.start, hit.end]);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

function contextOf(text: string, hit: Hit) {
  const prefix = text.slice(Math.max(0, hit.start - 8), hit.start);
  const negated = NEGATION_TOKENS.some((token) => prefix.endsWith(token));
  const intensified = !negated && INTENSIFIERS.some((token) => prefix.endsWith(token));
  const diminished = !negated && DIMINISHERS.some((token) => prefix.endsWith(token));
  return { negated, intensified, diminished };
}

function decideTone(score: number, positive: number, negative: number): SentimentTone {
  if (score >= 15) return "positive";
  if (score <= -15) return "negative";
  if (positive > 0 && negative > 0) return "mixed";
  return "neutral";
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function topicKeywords() {
  return TOPIC_WORDS;
}
