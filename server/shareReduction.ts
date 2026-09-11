/**
 * 股东减持识别（每日聚焦硬门槛）。
 *
 * 只读取可核验的文本（上市公司公告标题、直接关联的新闻标题），是纯函数：
 * 同一段文本在任何时间、任何进程里都得到同一判定，冻结记录可以逐条复核。
 *
 * 判定顺序：
 * 1. 必须出现“减持”，否则不是减持信号。
 * 2. “未减持 / 不减持 / 尚未减持”等明确表示没有卖出动作的表述不算减持信号。
 * 3. “终止 / 放弃 / 取消减持”只有在同时说明已实施、已完成或给出减持结果时
 *    才仍按减持处理，否则视为抛压已解除。
 * 4. 只处置可转债、公司债等非股份权益且未提及股份/股票的，不算股份减持。
 * 5. 大幅减持：控股股东、实际控制人、一致行动人、5% 以上股东、清仓、
 *    全部股份、大幅/巨额/大额，或标题给出“减持不超过 X%”且 X ≥ 2。
 */
export type ShareReductionLevel = "major" | "minor";

export interface ShareReductionMatch {
  level: ShareReductionLevel;
  /** 触发判定的关键词，冻结后与标题一起留档复核。 */
  matched: string[];
}

/** 大幅减持门槛：董事、监事、高级管理人员的小额减持仍属减持，但不升级为“大幅”。 */
export const MAJOR_REDUCTION_PERCENT = 2;

const REDUCTION = /减持/;
/** 明确没有卖出动作的表述。 */
const NOT_EXECUTED = /未减持|不减持|不再减持|尚未减持|无减持|未实施减持|未发生减持/;
/** 计划终止类表述：没有“已实施/已完成/结果”证据时，视为抛压解除。 */
const PLAN_STOPPED = /终止减持|提前终止|放弃减持|取消减持|终止本次减持/;
const EXECUTED = /结果|完成|实施|已减持|累计减持/;
/** 只是承诺、说明或澄清，没有实际减持动作的公告。 */
const NON_ACTION = /说明|承诺|澄清/;
const ACTION = /计划|预披露|结果|完成|实施/;
/** 非股份权益的处置不构成股份减持；只有同时提到股份/股票时才按股份减持处理。 */
const NON_EQUITY = /可转债|可转换公司债券|公司债|债券|转债/;
const EQUITY = /股份|股票|股权/;
const MAJOR_PATTERNS: Array<[string, RegExp]> = [
  ["控股股东", /控股股东/],
  ["实际控制人", /实际控制人/],
  ["一致行动人", /一致行动人/],
  ["5%以上股东", /(?:5|５)\s*[%％]\s*以上|百分之五以上/],
  ["清仓", /清仓|全部(?:股份|股票|持股|所持)/],
  ["大幅减持", /大幅|巨额|大额/],
];
/** “减持不超过 2%”“减持公司 1.5% 股份”这类比例；要求百分比出现在“减持”之后，避免把“持股5%以上股东”读成减持比例，也要排除“减持至5%以下”这类持股比例变化。 */
const REDUCTION_PERCENT = /(?:减持|减仓|减少)(?!至|到)[^，,。；;]{0,16}?(\d+(?:\.\d+)?)\s*[%％]/;

export function classifyShareReductionText(text: string): ShareReductionMatch | null {
  const normalized = normalize(text);
  if (!normalized || !REDUCTION.test(normalized) || NOT_EXECUTED.test(normalized)) return null;
  if (PLAN_STOPPED.test(normalized) && !EXECUTED.test(normalized)) return null;
  if (NON_ACTION.test(normalized) && !ACTION.test(normalized)) return null;
  if (NON_EQUITY.test(normalized) && !EQUITY.test(normalized)) return null;
  const matched = MAJOR_PATTERNS.filter(([, pattern]) => pattern.test(normalized)).map(([label]) => label);
  const percent = Number(REDUCTION_PERCENT.exec(normalized)?.[1] ?? Number.NaN);
  if (Number.isFinite(percent) && percent >= MAJOR_REDUCTION_PERCENT) matched.push(`减持比例 ${percent}%`);
  return { level: matched.length ? "major" : "minor", matched };
}

/** 全角空格与不间空格在公告标题里很常见，先归一化再匹配，避免同一个词漏判。 */
function normalize(text: string): string {
  return text.replace(/[\u3000\u00a0]/g, " ").replace(/\s+/g, " ").trim();
}
