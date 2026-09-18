/**
 * A 股板块归属：只按证券代码前缀判定，不依赖行情字段，服务端与界面共用同一套口径。
 *
 * 注意：中小板（002/003）已于 2021-04-06 并入深市主板，交易所口径上不再单独存在。
 * 每日聚焦按产品口径仍把它单独作为一类来平衡候选，因此这里保留「中小板」，
 * 需要合并时只要把 `marketBoardOf` 里 002/003 归到「主板」即可，其余逻辑不用改。
 */
export type MarketBoard = "主板" | "中小板" | "创业板" | "科创板";

/** 每日聚焦参与配额的板块顺序，用于展示与诊断。 */
export const MARKET_BOARDS: readonly MarketBoard[] = ["主板", "中小板", "创业板", "科创板"];

const BOARD_BY_PREFIX: Readonly<Record<string, MarketBoard>> = {
  "600": "主板", "601": "主板", "603": "主板", "605": "主板",
  "000": "主板", "001": "主板",
  "002": "中小板", "003": "中小板",
  "300": "创业板", "301": "创业板",
  "688": "科创板", "689": "科创板",
};

/**
 * 返回代码所属板块；北交所、B 股或未知前缀返回 null。
 * 未知板块不会被丢弃，只是在配额阶段不占名额（见 selectDailyCandidates）。
 */
export function marketBoardOf(code: unknown): MarketBoard | null {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  return BOARD_BY_PREFIX[code.slice(0, 3)] ?? null;
}
