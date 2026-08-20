import { readStoredMarketQuotes } from "../server/marketSync.ts";
import { getStoredClues } from "../server/database.ts";
import { fetchUserDiscussionClues } from "../server/userPosts.ts";
import { selectMovers } from "../server/radarEngine.ts";

async function main() {
  const market = readStoredMarketQuotes();
  console.log("stored market:", market ? `${market.items.length} 只, tradeDate=${market.tradeDate}, stale=${market.stale}` : "null");
  if (!market) return;
  const { focusCodes } = selectMovers(market.items);
  console.log("movers:", focusCodes.length);
  const bundle = await fetchUserDiscussionClues(focusCodes, true, new Map(market.items.map((q) => [q.code, q.name])));
  console.log("discussions items:", bundle.items.length, "| failures:", bundle.failures);
  for (const s of bundle.sources) console.log(`  ${s.id}: ${s.state} (${s.count}) ${s.detail.slice(0, 40)}`);
  const stored = getStoredClues();
  console.log("stored clues:", stored.length);
}
void main();
