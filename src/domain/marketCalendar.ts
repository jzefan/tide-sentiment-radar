/** Update this registry from the exchange's annual closure notice before expiry. */
export const MARKET_CALENDAR_EXPIRES_ON = "2026-12-31";
const CALENDAR_YEAR = 2026;

// 上海证券交易所 2026 年休市安排：
// https://www.sse.com.cn/disclosure/dealinstruc/closed/
const CLOSED_DATES = new Set([
  "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04",
  "2026-02-14", "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18",
  "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23", "2026-02-28",
  "2026-04-04", "2026-04-05", "2026-04-06",
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-09",
  "2026-06-19", "2026-06-20", "2026-06-21",
  "2026-09-20", "2026-09-25", "2026-09-26", "2026-09-27",
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
  "2026-10-06", "2026-10-07", "2026-10-10",
]);

/** 交易时段（北京时间）：上午 09:15–11:30，下午 13:00–15:00。 */
const MORNING_START = 9 * 60 + 15;
const MORNING_END = 11 * 60 + 30;
const AFTERNOON_START = 13 * 60;
const AFTERNOON_END = 15 * 60;

export interface MarketPhase {
  label: "盘前监测" | "盘中监测" | "午间休市" | "盘后监测" | "休市监测" | "交易状态待确认";
  calendarVerified: boolean;
}

export function marketPhaseAt(now: Date): MarketPhase {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const year = Number(read("year"));
  if (year !== CALENDAR_YEAR) return { label: "交易状态待确认", calendarVerified: false };

  const dateKey = `${read("year")}-${read("month")}-${read("day")}`;
  const weekday = read("weekday");
  if (weekday === "Sat" || weekday === "Sun" || CLOSED_DATES.has(dateKey)) {
    return { label: "休市监测", calendarVerified: true };
  }

  const minutes = Number(read("hour")) * 60 + Number(read("minute"));
  if (minutes < MORNING_START) return { label: "盘前监测", calendarVerified: true };
  if (minutes < MORNING_END) return { label: "盘中监测", calendarVerified: true };
  if (minutes < AFTERNOON_START) return { label: "午间休市", calendarVerified: true };
  if (minutes < AFTERNOON_END) return { label: "盘中监测", calendarVerified: true };
  return { label: "盘后监测", calendarVerified: true };
}

/** 是否处于交易时段（9:15–11:30、13:00–15:00 的交易日）；日历未核验的年份按交易时段处理，保证不遗漏抓取。 */
export function isTradingSession(now: Date): boolean {
  const phase = marketPhaseAt(now);
  return phase.calendarVerified ? phase.label === "盘中监测" : true;
}

/** Calendar decision for an explicit exchange trade date; unknown calendar years fail closed for formal freezes. */
export function isTradingDate(tradeDate: string): boolean {
  // Formal daily-candidate freezes fail closed after the published calendar expires.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || Number(tradeDate.slice(0, 4)) !== CALENDAR_YEAR) return false;
  const weekday = new Date(`${tradeDate}T00:00:00.000Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !CLOSED_DATES.has(tradeDate);
}

const listingAgeCache = new Map<string, number>();

/**
 * Conservative, calendar-verified listing age for the calendar year supported by
 * formal freezes.  Listings from an earlier year are counted from January 1 of
 * the verified year, which is a safe lower bound and avoids depending on how
 * many quote rows happen to exist locally.
 */
export function verifiedTradingDaysSinceListing(listingDate: string | null, tradeDate: string): number {
  if (!listingDate || !/^\d{4}-\d{2}-\d{2}$/.test(listingDate) || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || listingDate > tradeDate || Number(tradeDate.slice(0, 4)) !== CALENDAR_YEAR) return 0;
  const cacheKey = `${listingDate}:${tradeDate}`; const cached = listingAgeCache.get(cacheKey); if (cached !== undefined) return cached;
  const start = listingDate.slice(0, 4) === String(CALENDAR_YEAR) ? listingDate : `${CALENDAR_YEAR}-01-01`;
  let count = 0;
  for (let cursor = new Date(`${start}T00:00:00.000Z`), end = new Date(`${tradeDate}T00:00:00.000Z`); cursor <= end; cursor = new Date(cursor.valueOf() + 86_400_000)) {
    if (isTradingDate(cursor.toISOString().slice(0, 10))) count += 1;
  }
  listingAgeCache.set(cacheKey, count);
  return count;
}
