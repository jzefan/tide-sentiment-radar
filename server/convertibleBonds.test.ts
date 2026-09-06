import assert from "node:assert/strict";
import test from "node:test";
import { clearConvertibleBondCacheForTests, getConvertibleBonds } from "./convertibleBonds.ts";

const row = (input: Partial<Record<string, unknown>> & { SECURITY_CODE: string; SECURITY_NAME_ABBR: string }) => ({
  SECUCODE: `${input.SECURITY_CODE}.SZ`,
  CONVERT_STOCK_CODE: "300001",
  SECURITY_SHORT_NAME: "测试正股",
  LISTING_DATE: "2026-01-01 00:00:00",
  DELIST_DATE: null,
  PUBLIC_START_DATE: "2025-12-15 00:00:00",
  CURRENT_BOND_PRICE: 120,
  CHANGE_RATE: 1.5,
  TURNOVERVALUE: 100_000,
  TRANSFER_VALUE: 110,
  TRANSFER_PREMIUM_RATIO: 9.09,
  CONVERT_STOCK_CHANGE_RATE: -1.25,
  CONVERT_STOCK_TURNOVERVALUE: 234_567_890,
  RATING: "AA",
  ACTUAL_ISSUE_SCALE: 8,
  ...input,
});

test("convertible bond views keep active bonds, future subscriptions, and latest listings separate", async () => {
  clearConvertibleBondCacheForTests();
  const rows = [
    row({ SECURITY_CODE: "123001", SECURITY_NAME_ABBR: "旧转债", LISTING_DATE: "2025-01-01 00:00:00", TURNOVERVALUE: 200_000, CURRENT_BOND_PRICE: 110 }),
    row({ SECURITY_CODE: "123002", SECURITY_NAME_ABBR: "新转债", LISTING_DATE: "2026-08-20 00:00:00", TURNOVERVALUE: 100_000, CURRENT_BOND_PRICE: 130 }),
    row({ SECURITY_CODE: "123003", SECURITY_NAME_ABBR: "未来转债", LISTING_DATE: null, PUBLIC_START_DATE: "2026-09-02 00:00:00", CURRENT_BOND_PRICE: null }),
    row({ SECURITY_CODE: "123004", SECURITY_NAME_ABBR: "退市转债", DELIST_DATE: "2026-08-01 00:00:00" }),
  ];
  const originalFetch = globalThis.fetch;
  const requestedPages: number[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("pageNumber"));
    requestedPages.push(page);
    const data = page === 1 ? rows.slice(0, 2) : rows.slice(2);
    return new Response(JSON.stringify({ success: true, code: 0, result: { pages: 2, count: rows.length, data } }));
  };

  try {
    const now = new Date("2026-08-28T04:00:00.000Z");
    const all = await getConvertibleBonds({ view: "all", now, pageSize: 20 });
    assert.deepEqual(all.items.map((item) => item.code), ["123001", "123002", "123003"], "all keeps active bonds and disclosed upcoming bonds together while excluding delisted bonds");
    assert.deepEqual(
      { pctChange: all.items[0]?.stockPctChange, amount: all.items[0]?.stockAmount },
      { pctChange: -1.25, amount: 234_567_890 },
      "underlying-stock change and turnover are retained with each bond",
    );
    assert.deepEqual(requestedPages.sort(), [1, 2]);

    const upcoming = await getConvertibleBonds({ view: "upcoming", now, pageSize: 20 });
    assert.deepEqual(upcoming.items.map((item) => [item.code, item.subscriptionDate]), [["123003", "2026-09-02"]]);

    const latest = await getConvertibleBonds({ view: "latest", now, pageSize: 20 });
    assert.deepEqual(latest.items.map((item) => item.code), ["123002"], "latest only includes bonds listed within the preceding calendar month");
    assert.deepEqual(
      all.items.map((item) => [item.code, item.isLatestTradable, item.isUpcoming]),
      [["123001", false, false], ["123002", true, false], ["123003", false, true]],
      "list tags are returned as data rather than inferred by the page",
    );

    const priceDescending = await getConvertibleBonds({ view: "all", sort: "price", now, pageSize: 20 });
    assert.deepEqual(priceDescending.items.map((item) => item.code), ["123002", "123001", "123003"], "each API sort applies before pagination and defaults to descending");
    const priceAscending = await getConvertibleBonds({ view: "all", sort: "-price", now, pageSize: 20 });
    assert.deepEqual(priceAscending.items.map((item) => item.code), ["123001", "123002", "123003"], "a leading minus switches the same column to ascending");

    const search = await getConvertibleBonds({ view: "all", query: "新转", now, pageSize: 20 });
    assert.deepEqual(search.items.map((item) => item.code), ["123002"]);
    assert.equal(requestedPages.length, 2, "subsequent views reuse the five-minute snapshot");
  } finally {
    globalThis.fetch = originalFetch;
    clearConvertibleBondCacheForTests();
  }
});
