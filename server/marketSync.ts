import {
  getLatestCompleteMarketSnapshot,
  recordMarketSnapshotFailure,
  saveCompleteMarketSnapshot,
  type MarketSnapshotInfo,
} from "./database.ts";
import { fetchEastMoneyMarketSnapshot, type EastMoneyEndpointTier, type EastMoneyMarketQuote } from "./eastMoneyMarket.ts";

const MARKET_REFRESH_MS = 75_000;

export interface MarketQuote extends Omit<EastMoneyMarketQuote, "price" | "pctChange" | "volume" | "amount" | "turnover" | "marketCap"> {
  price: number;
  pctChange: number;
  volume: number;
  amount: number;
  turnover: number;
  marketCap: number;
}

export interface MarketSyncResult {
  items: MarketQuote[];
  updatedAt: string;
  quoteAt: string;
  tradeDate: string;
  cached: boolean;
  stale: boolean;
  sourceTier: EastMoneyEndpointTier;
  snapshot: MarketSnapshotInfo;
  error?: string;
}

let activeSync: Promise<MarketSyncResult> | null = null;

export async function syncMarketQuotes(force = false): Promise<MarketSyncResult> {
  const current = getLatestCompleteMarketSnapshot();
  if (!force && current && Date.now() - new Date(current.fetchedAt).valueOf() < MARKET_REFRESH_MS) {
    return fromStored(current, false);
  }
  if (activeSync) return activeSync;
  activeSync = runSync(current).finally(() => { activeSync = null; });
  return activeSync;
}

export function readStoredMarketQuotes(): MarketSyncResult | null {
  const current = getLatestCompleteMarketSnapshot();
  return current ? fromStored(current, isStale(current.fetchedAt)) : null;
}

async function runSync(previous: ReturnType<typeof getLatestCompleteMarketSnapshot>): Promise<MarketSyncResult> {
  try {
    const remote = await fetchEastMoneyMarketSnapshot();
    const saved = saveCompleteMarketSnapshot(remote);
    return {
      items: normalize(remote.items),
      updatedAt: remote.fetchedAt,
      quoteAt: remote.quoteAt,
      tradeDate: remote.tradeDate,
      cached: false,
      stale: false,
      sourceTier: remote.sourceTier,
      snapshot: saved,
    };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : "东方财富行情同步失败";
    try {
      recordMarketSnapshotFailure({ sourceTier: "delayed", endpoint: "https://push2delay.eastmoney.com/api/qt/clist/get", error });
    } catch {
      // 记录状态失败不能遮蔽最后一个已验证的真实批次。
    }
    if (previous) return { ...fromStored(previous, true), error };
    throw new Error(`${error}；本地尚无可用的完整行情快照`);
  }
}

function fromStored(snapshot: NonNullable<ReturnType<typeof getLatestCompleteMarketSnapshot>>, stale: boolean): MarketSyncResult {
  return {
    items: normalize(snapshot.items),
    updatedAt: snapshot.fetchedAt,
    quoteAt: snapshot.quoteAt,
    tradeDate: snapshot.tradeDate,
    cached: true,
    stale,
    sourceTier: snapshot.sourceTier,
    snapshot,
  };
}

function normalize(items: EastMoneyMarketQuote[]): MarketQuote[] {
  return items.filter((item) => item.price !== null).map((item) => ({
    ...item,
    price: item.price!,
    pctChange: item.pctChange ?? 0,
    volume: item.volume ?? 0,
    amount: item.amount ?? 0,
    turnover: item.turnover ?? 0,
    marketCap: item.marketCap ?? 0,
  }));
}

function isStale(fetchedAt: string) {
  return Date.now() - new Date(fetchedAt).valueOf() > 10 * 60_000;
}
