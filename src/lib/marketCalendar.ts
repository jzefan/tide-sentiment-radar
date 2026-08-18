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
  if (minutes < 570) return { label: "盘前监测", calendarVerified: true };
  if (minutes < 690) return { label: "盘中监测", calendarVerified: true };
  if (minutes < 780) return { label: "午间休市", calendarVerified: true };
  if (minutes < 900) return { label: "盘中监测", calendarVerified: true };
  return { label: "盘后监测", calendarVerified: true };
}
