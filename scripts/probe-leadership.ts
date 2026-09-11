/**
 * 龙头数据源诊断：逐日对比真实涨停池与本地同日行情，给出核对结论。
 *
 * 用法：
 *   pnpm leadership:probe 2026-09-10 2026-09-09
 *   pnpm leadership:probe            # 默认最近 5 个已留存交易日
 */
import { getMarketQuotesByTradeDate, listTradeDates } from "../server/database.ts";
import { fetchLimitUpPool, type QuoteForVerification } from "../server/leadership.ts";
import { evaluateLeadershipBatch } from "../server/leadershipSync.ts";

const requested = process.argv.slice(2).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
const dates = requested.length ? requested : listTradeDates().slice(0, 5).sort();

for (const tradeDate of dates) {
  try {
    const quotes = getMarketQuotesByTradeDate(tradeDate).map((quote): QuoteForVerification => ({
      code: quote.code,
      price: quote.price,
      pctChange: quote.pctChange,
      quoteAt: quote.quoteAt,
    }));
    const finalized = quotes.some((quote) => Boolean(quote.quoteAt && quote.quoteAt >= `${tradeDate}T07:00:00.000Z`));
    const rows = await fetchLimitUpPool(tradeDate);
    const verification = evaluateLeadershipBatch(tradeDate, rows, quotes, Date.now());
    const maxBoard = rows.reduce((max, row) => Math.max(max, row.boardCount), 0);
    console.log(`== ${tradeDate} 涨停 ${rows.length} 条 · 最高 ${maxBoard} 板 · 本地行情 ${quotes.length} 条 · 收盘批次 ${finalized ? "是" : "否"}`);
    console.log(`   核对：${verification.verified ? "通过" : "拒绝"}${verification.mode ? `（${verification.mode}）` : ""} 一致 ${verification.matched}/${verification.comparable}，盘中时点差 ${verification.timing}${verification.reason ? ` · 原因：${verification.reason}` : ""}`);
    const mismatched = new Set(verification.mismatched);
    for (const row of rows.filter((item) => mismatched.has(item.code)).slice(0, 6)) {
      const quote = quotes.find((item) => item.code === row.code);
      console.log(`   ✗ ${row.code} ${row.name} 池价=${row.close} 本地=${quote?.price ?? "—"} 池涨=${row.pctChange?.toFixed(2) ?? "—"} 本地涨=${quote?.pctChange ?? "—"}`);
    }
  } catch (error) {
    console.log(`== ${tradeDate} 抓取失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
