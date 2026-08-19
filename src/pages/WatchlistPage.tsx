import { useEffect, useState } from "react";
import { ChevronRight, CircleAlert, Loader2, Search, Star } from "lucide-react";
import { Link } from "react-router-dom";
import type { StockSnapshot } from "../domain/types";
import { api } from "../lib/api";
import { changeLabel } from "../lib/format";
import { useWatchlist } from "../lib/useWatchlist";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingState } from "@/components/LoadingState";
import { cn } from "@/lib/utils";

export function WatchlistPage() {
  const watchlist = useWatchlist();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<StockSnapshot[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => { setPage(1); }, [query]);

  useEffect(() => {
    let controller: AbortController | null = null;
    const loadCurrent = (silent = false) => {
      if (!silent) setLoading(true);
      controller?.abort();
      const activeController = new AbortController();
      controller = activeController;
      api.stocks({ q: query, scope: query ? "all" : "watchlist", sort: "alert", page, pageSize: 50 }, activeController.signal)
        .then((result) => { setItems(result.items); setTotal(result.total); setError(""); })
        .catch((cause) => {
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          setError(cause instanceof Error ? cause.message : "无法读取自选股");
        })
        .finally(() => { if (controller === activeController) setLoading(false); });
    };
    const timer = window.setTimeout(() => loadCurrent(false), query ? 220 : 0);
    const interval = window.setInterval(() => loadCurrent(true), 60_000);
    return () => { controller?.abort(); window.clearTimeout(timer); window.clearInterval(interval); };
  }, [query, page, watchlist.codes.join(",")]);

  const pages = Math.max(1, Math.ceil(total / 50));

  const toggle = async (stock: StockSnapshot) => {
    try {
      await watchlist.toggle(stock.code);
      setItems((current) => query ? current.map((item) => item.code === stock.code ? { ...item, isWatchlisted: !item.isWatchlisted } : item) : current.filter((item) => item.code !== stock.code));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "自选股更新失败");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-6 border-b pb-3">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs uppercase tracking-[0.16em] text-muted-foreground">
          我的自选股 · 每分钟自动更新
          {loading && items.length > 0 && (
            <span className="inline-flex items-center gap-1.5 normal-case tracking-normal">
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              读取中…
            </span>
          )}
        </p>
        <div className="flex items-baseline gap-2"><strong className="text-2xl font-semibold tabular">{watchlist.codes.length}</strong><span className="text-xs text-muted-foreground">只自选股</span></div>
      </header>

      <div className="flex flex-wrap items-end justify-between gap-4 border-b pb-5">
        <div className="relative w-full max-w-xl">
          <Search size={15} className="absolute bottom-3 left-3 text-muted-foreground" aria-hidden="true" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入名称、六位代码或拼音首字母（如 ZGPA）" className="h-10 pl-9 text-sm" />
        </div>
        <p className="text-xs text-muted-foreground">{query ? `找到 ${total} 只匹配股票` : "默认显示全部自选股及其最新舆情状态"}</p>
      </div>

      {error && <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning-soft px-4 py-2.5 text-sm"><CircleAlert size={16} className="text-warning" />{error}</div>}
      {/* 重新加载时保留旧列表不闪屏：骨架屏只在还没有任何数据时显示 */}
      {loading && items.length === 0 ? (
        <div className="flex flex-col items-center gap-5 py-16" role="status" aria-label="正在加载自选股">
          <LoadingState label="正在读取自选股舆情" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : items.length ? (
        <Card className="overflow-hidden py-0">
          <CardContent className="px-0">
            <div className="divide-y">
              {items.map((stock) => (
                <article className="grid min-h-[72px] grid-cols-[40px_minmax(150px,1fr)_110px_90px_36px] items-center gap-3 px-4 transition-colors hover:bg-muted/50" key={stock.code}>
                  <Button
                    type="button"
                    variant={stock.isWatchlisted ? "default" : "outline"}
                    size="icon-sm"
                    className={cn("size-8", stock.isWatchlisted ? "bg-up text-up-foreground hover:bg-up/90" : "text-muted-foreground")}
                    aria-pressed={Boolean(stock.isWatchlisted)}
                    aria-label={`${stock.isWatchlisted ? "移出" : "加入"}自选股：${stock.name}`}
                    onClick={() => void toggle(stock)}
                  ><Star size={15} fill={stock.isWatchlisted ? "currentColor" : "none"} /></Button>
                  <Link to={`/stocks/${stock.code}`} className="block min-w-0 py-2">
                    <strong className="block truncate text-sm font-medium">{stock.name}</strong>
                    <span className="block text-xs text-muted-foreground">{stock.code} · {stock.market}</span>
                  </Link>
                  <div className="text-right">
                    <span className="block truncate text-[11px] text-muted-foreground">{stock.signal}</span>
                    <strong className="text-lg font-semibold tabular leading-tight">{stock.alertScore ?? "—"}</strong>
                    <small className="text-[10px] text-muted-foreground">异动分</small>
                  </div>
                  <div className="text-right">
                    <strong className={cn("block font-semibold tabular", stock.pctChange >= 0 ? "text-up" : "text-down")}>{stock.price.toFixed(2)}</strong>
                    <span className={cn("text-xs tabular", stock.pctChange >= 0 ? "text-up" : "text-down")}>{changeLabel(stock.pctChange)}</span>
                  </div>
                  <Link to={`/stocks/${stock.code}`} className="inline-flex size-8 items-center justify-center text-muted-foreground transition-colors hover:text-up" aria-label={`查看 ${stock.name} 舆情详情`}><ChevronRight size={17} /></Link>
                </article>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-lg border py-16 text-center">
          <Star size={22} className="text-muted-foreground" />
          <div><h2 className="text-sm font-medium">{query ? "没有匹配的股票" : "还没有自选股"}</h2><p className="mt-1 text-xs text-muted-foreground">{query ? "请尝试股票简称或六位代码。" : "在上方搜索股票，点击星标即可加入。"}</p></div>
        </div>
      )}
      {!loading && total > 50 && (
        <nav className="flex items-center justify-center gap-4" aria-label="自选搜索分页">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</Button>
          <span className="text-xs text-muted-foreground tabular">第 {page} / {pages} 页</span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>下一页</Button>
        </nav>
      )}
    </div>
  );
}
