import assert from "node:assert/strict";
import test from "node:test";
import { calendarDays, composeAnnouncementRange } from "./eastMoney.ts";

const day = (date: string) => ({
  kind: "server-window-paginated" as const,
  queryFrom: new Date(`${date}T00:00:00.000+08:00`).toISOString(),
  queryTo: new Date(`${date}T23:59:59.999+08:00`).toISOString(),
  cursorExhausted: true as const,
});

test("splits an announcement window into contiguous calendar days", () => {
  assert.deepEqual(calendarDays("2026-09-09", "2026-09-10"), ["2026-09-09", "2026-09-10"]);
  // 周五到周一必须包含周末：窗口内的周末公告同样属于当日舆情。
  assert.deepEqual(calendarDays("2026-09-04", "2026-09-07"), ["2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"]);
  assert.deepEqual(calendarDays("2026-09-10", "2026-09-10"), ["2026-09-10"]);
  assert.deepEqual(calendarDays("2026-09-10", "2026-09-09"), []);
  assert.deepEqual(calendarDays("not-a-date", "2026-09-10"), []);
});

test("composes a proven window only when every day is independently exhausted", () => {
  const composed = composeAnnouncementRange([day("2026-09-09"), day("2026-09-10")]);
  assert.deepEqual(composed, {
    kind: "server-window-paginated",
    queryFrom: new Date("2026-09-09T00:00:00.000+08:00").toISOString(),
    queryTo: new Date("2026-09-10T23:59:59.999+08:00").toISOString(),
    cursorExhausted: true,
  });
});

test("refuses a window when any single day could not be exhausted", () => {
  assert.equal(composeAnnouncementRange([day("2026-09-09"), null]), null, "缺一天的证明就整段不接受");
  assert.equal(composeAnnouncementRange([{ ...day("2026-09-09"), cursorExhausted: false as unknown as true }]), null);
  assert.equal(composeAnnouncementRange([]), null);
});

test("refuses non-contiguous days instead of silently widening the window", () => {
  assert.equal(composeAnnouncementRange([day("2026-09-04"), day("2026-09-07")]), null, "跳过周末会让窗口出现缺口");
});

test("accepts overlapping adjacent days, because display time can spill past midnight", () => {
  const spilled = {
    kind: "server-window-paginated" as const,
    queryFrom: new Date("2026-09-08T20:00:00.000+08:00").toISOString(),
    queryTo: new Date("2026-09-09T23:59:59.999+08:00").toISOString(),
    cursorExhausted: true as const,
  };
  const composed = composeAnnouncementRange([spilled, day("2026-09-10")]);
  assert.equal(composed?.queryFrom, spilled.queryFrom);
  assert.equal(composed?.queryTo, day("2026-09-10").queryTo);
});
