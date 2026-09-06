// 市场日历统一放在 domain（前后端共用），本文件仅为前端保留原导入路径。
export { isTradingDate, isTradingSession, marketPhaseAt } from "../domain/marketCalendar";
export type { MarketPhase } from "../domain/marketCalendar";
