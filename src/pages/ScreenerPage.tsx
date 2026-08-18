import { useEffect, useState } from "react";
import { ArrowDownUp, ChevronLeft, ChevronRight, CircleAlert, MoveHorizontal, Search, Star } from "lucide-react";
import { Link } from "react-router-dom";
import { Sparkline } from "../components/Visuals";
import type { SignalLabel, StockListResponse, StockSnapshot } from "../domain/types";
import { api } from "../lib/api";
import { changeLabel, formatNumber } from "../lib/format";
import { useWatchlist } from "../lib/useWatchlist";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type SortKey = "alert" | "direction" | "attention" | "mentions" | "risk" | "market";
type SignalFilter = "all" | SignalLabel;

const signals: Array<{ value: SignalFilter; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "偏多共振", label: "偏多共振" },
  { value: "高分歧", label: "高分歧" },
  { value: "风险升温", label: "风险升温" },
  { value: "热度观察", label: "热度观察" },
  { value: "证据不足", label: "暂无线索" },
];

export function ScreenerPage() {
  const [payload, setPayload] = useState<StockListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [signal, setSignal] = useState<SignalFilter>("all");
  const [sort, setSort] = useState<SortKey>("alert");
  const [scope, setScope] = useState<"all" | "only">("all");
  const [market, setMarket] = useState("all");
  const [page, setPage] = useState(1);
  const watchlist = useWatchlist();

  useEffect(() => { setPage(1); }, [query, signal, sort, scope, market]);
  useEffect(() => {
    let controller: AbortController | null = null;
    const load = (silent = false) => {
      if (!silent) setLoading(true);
      controller?.abort();
      const activeController = new AbortController();
      controller = activeController;
      api.stocks({ q: query, signal, sort, watchlist: scope, market, page, pageSize: 50 }, activeController.signal)
        .then((next) => { setPayload(next); setError(""); })
        .catch((cause) => {
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          setError(cause instanceof Error ? cause.message : "读取全市场股票池失败");
        })
        .finally(() => { if (controller === activeController) setLoading(false); });
    };
    const timer = window.setTimeout(() => load(false), query ? 220 : 0);
    const interval = window.setInterval(() => load(true), 60_000);
    return () => { controller?.abort(); window.clearTimeout(timer); window.clearInterval(interval); };
  }, [query, signal, sort, scope, market, page]);

  const items = payload?.items ?? [];
  const pages = Math.max(1, Math.ceil((payload?.total ?? 0) / (payload?.pageSize ?? 50)));
  const toggleWatchlist = async (code: string) => {
    try {
      await watchlist.toggle(code);
      setPayload((current) => current ? {
        ...current,
        items: current.items
          .map((stock) => stock.code === code ? { ...stock, isWatchlisted: !stock.isWatchlisted } : stock)
          .filter((stock) => scope !== "only" || stock.isWatchlisted),
      } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "自选股更新失败");
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center justify-between gap-6 border-b pb-4">
        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">全市场舆情筛选 · 每分钟自动更新</p>
        <div className="flex items-baseline gap-2"><strong className="text-2xl font-semibold tabular">{formatNumber(payload?.total ?? 0)}</strong><span className="text-xs text-muted-foreground">{scope === "only" ? "只自选股" : "匹配股票"}</span></div>
      </header>

      <section className="grid grid-cols-1 divide-y rounded-lg border sm:grid-cols-3 sm:divide-x sm:divide-y-0" aria-label="股票池状态">
        <div className="flex items-center justify-between px-5 py-3"><span className="text-xs text-muted-foreground">全市场模式</span><strong className="text-sm font-medium">{scope === "all" ? "已开启" : "已切至自选"}</strong></div>
        <div className="flex items-center justify-between px-5 py-3"><span className="text-xs text-muted-foreground">已有关联舆情</span><strong className="text-sm font-medium tabular">{formatNumber(payload?.analyzed ?? 0)}</strong></div>
        <div className="flex items-center justify-between px-5 py-3"><span className="text-xs text-muted-foreground">数据更新时间</span><strong className="text-sm font-medium tabular">{payload?.asOf ? new Date(payload.asOf).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "连接中"}</strong></div>
      </section>

      <div className="sticky top-0 z-20 -mx-4 border-b bg-background/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3">
            <Tabs value={scope} onValueChange={(value) => setScope(value as typeof scope)}>
              <TabsList className="h-9">
                <TabsTrigger value="all" className="text-xs">全部股票</TabsTrigger>
                <TabsTrigger value="only" className="text-xs"><Star className="mr-1" size={13} />我的自选</TabsTrigger>
              </TabsList>
            </Tabs>
            <Tabs value={signal} onValueChange={(value) => setSignal(value as SignalFilter)} className="hidden md:block">
              <TabsList className="h-9 overflow-x-auto">
                {signals.map((item) => <TabsTrigger value={item.value} key={item.value} className="text-xs">{item.label}</TabsTrigger>)}
              </TabsList>
            </Tabs>
          </div>
          <div className="flex flex-wrap items-end gap-3 md:hidden">
            <Select value={signal} onValueChange={(value) => setSignal(value as SignalFilter)}>
              <SelectTrigger className="w-[180px] text-xs"><SelectValue placeholder="舆情状态" /></SelectTrigger>
              <SelectContent>{signals.map((item) => <SelectItem value={item.value} key={item.value}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="relative min-w-[220px] flex-1">
              <Search size={15} className="absolute bottom-3 left-3 text-muted-foreground" aria-hidden="true" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：中际旭创、300308、半导体" className="h-10 pl-9 text-sm" />
            </div>
            <Select value={market} onValueChange={setMarket}>
              <SelectTrigger className="w-[130px] text-xs"><SelectValue placeholder="全部市场" /></SelectTrigger>
              <SelectContent>
                {["all", "沪市", "深市", "北交所"].map((value) => <SelectItem value={value} key={value}>{value === "all" ? "全部市场" : value}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={(value) => setSort(value as SortKey)}>
              <SelectTrigger className="w-[190px] text-xs"><ArrowDownUp size={14} /><SelectValue placeholder="排序方式" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="alert">自选优先，其次异动分</SelectItem>
                <SelectItem value="direction">方向分偏正面</SelectItem>
                <SelectItem value="risk">方向分偏负面</SelectItem>
                <SelectItem value="attention">讨论热度</SelectItem>
                <SelectItem value="mentions">关联线索数</SelectItem>
                <SelectItem value="market">市场表现</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <section className="min-w-0">
        {error && payload && <div className="mb-4 flex items-center gap-2 rounded-md border border-warning/40 bg-warning-soft px-4 py-2.5 text-sm"><CircleAlert size={16} className="text-warning" /><span>自动更新暂时失败，当前仍显示上次成功数据：{error}</span></div>}
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">筛选结果 <strong className="text-sm text-foreground tabular">{formatNumber(payload?.total ?? 0)}</strong></span>
          <p className="flex items-center gap-2 text-xs text-muted-foreground"><i className="size-1.5 rounded-full bg-warning" />方向分以 50 为中性；异动分不代表上涨概率。</p>
        </div>
        {loading && !payload ? <Skeleton className="h-96 w-full" /> : error && !payload ? (
          <div className="flex items-center gap-2 rounded-md border px-4 py-3 text-sm"><CircleAlert size={16} className="text-warning" /><span>{error}</span></div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border py-16 text-center">
            <Search size={22} className="text-muted-foreground" />
            <div><h2 className="text-sm font-medium">{scope === "only" ? "自选股中没有匹配结果" : "没有匹配的股票"}</h2><p className="mt-1 text-xs text-muted-foreground">调整关键词或舆情状态后再试。</p></div>
          </div>
        ) : (
          <Card className="overflow-hidden py-0">
            <CardContent className="px-0">
              <div className="relative hidden overflow-x-auto md:block">
                <Table className="min-w-[1020px]">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-12 text-center">自选</TableHead>
                      <TableHead>股票与主题</TableHead>
                      <TableHead className="text-center">舆情走势</TableHead>
                      <TableHead className="text-center">异动分</TableHead>
                      <TableHead className="text-center">方向分</TableHead>
                      <TableHead className="text-center">讨论热度</TableHead>
                      <TableHead className="text-center">观点共识</TableHead>
                      <TableHead className="text-center">关联线索</TableHead>
                      <TableHead className="text-center">实时涨跌</TableHead>
                      <TableHead className="w-12"><span className="sr-only">查看</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>{items.map((stock) => <CandidateRow key={stock.code} stock={stock} onToggle={toggleWatchlist} />)}</TableBody>
                </Table>
              </div>
              <div className="space-y-3 p-4 md:hidden">
                {items.map((stock) => <CandidateCard key={stock.code} stock={stock} onToggle={toggleWatchlist} />)}
              </div>
            </CardContent>
          </Card>
        )}
        {!loading && !error && (payload?.total ?? 0) > 0 && (
          <nav className="mt-6 flex items-center justify-center gap-4" aria-label="股票列表分页">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft />上一页</Button>
            <span className="text-xs text-muted-foreground tabular">第 {page} / {pages} 页</span>
            <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>下一页<ChevronRight /></Button>
          </nav>
        )}
      </section>
    </div>
  );
}

function WatchButton({ stock, onToggle }: { stock: StockSnapshot; onToggle: (code: string) => void }) {
  const selected = Boolean(stock.isWatchlisted);
  return <Button
    type="button"
    variant={selected ? "default" : "outline"}
    size="icon-sm"
    className={cn("size-8", selected ? "bg-up text-up-foreground hover:bg-up/90" : "text-muted-foreground")}
    aria-label={`${selected ? "移出" : "加入"}自选股：${stock.name}`}
    aria-pressed={selected}
    onClick={() => onToggle(stock.code)}
  ><Star size={15} fill={selected ? "currentColor" : "none"} /></Button>;
}

function CandidateRow({ stock, onToggle }: { stock: StockSnapshot; onToggle: (code: string) => void }) {
  return (
    <TableRow>
      <TableCell className="text-center"><WatchButton stock={stock} onToggle={onToggle} /></TableCell>
      <TableCell>
        <Link className="block transition-colors hover:text-up" to={`/stocks/${stock.code}`}>
          <strong className="text-sm font-medium">{stock.name}</strong>
          <span className="mt-0.5 block text-xs text-muted-foreground">{stock.code} · {stock.market}</span>
          <em className="mt-1.5 block truncate text-xs not-italic text-muted-foreground">{stock.topics.length ? stock.topics.slice(0, 2).join(" · ") : stock.signal}</em>
        </Link>
      </TableCell>
      <TableCell className="w-[110px]">{stock.sparkline.length ? <Sparkline values={stock.sparkline} tone={stock.factors.sentiment >= 0 ? "positive" : "negative"} /> : <span className="text-xs text-muted-foreground">暂无</span>}</TableCell>
      <TableCell className="text-center"><strong className="text-lg font-semibold tabular">{stock.alertScore ?? "—"}</strong></TableCell>
      <TableCell className="text-center"><DirectionScore score={stock.radarScore} /></TableCell>
      <TableCell className="text-center"><MetricBar value={stock.factors.attention} /></TableCell>
      <TableCell className="text-center"><MetricBar value={stock.factors.consensus} variant="consensus" /></TableCell>
      <TableCell className="text-center tabular">{stock.mentionCount}</TableCell>
      <TableCell className="text-center"><strong className={cn("font-semibold tabular", stock.pctChange >= 0 ? "text-up" : "text-down")}>{changeLabel(stock.pctChange)}</strong></TableCell>
      <TableCell className="text-center"><Link to={`/stocks/${stock.code}`} className="inline-flex size-8 items-center justify-center text-muted-foreground transition-colors hover:text-up" aria-label={`查看 ${stock.name} 详情`}><ChevronRight size={17} /></Link></TableCell>
    </TableRow>
  );
}

function CandidateCard({ stock, onToggle }: { stock: StockSnapshot; onToggle: (code: string) => void }) {
  return (
    <article className="rounded-md border bg-card p-4">
      <div className="grid grid-cols-[36px_1fr_auto] items-center gap-3">
        <WatchButton stock={stock} onToggle={onToggle} />
        <div><strong className="text-sm font-medium">{stock.name}</strong><span className="block text-xs text-muted-foreground">{stock.code} · {stock.market}</span></div>
        <em className={cn("not-italic font-semibold tabular", stock.pctChange >= 0 ? "text-up" : "text-down")}>{changeLabel(stock.pctChange)}</em>
      </div>
      <Link to={`/stocks/${stock.code}`} className="mt-3 block">
        <p className="line-clamp-1 text-xs text-muted-foreground">{stock.summary}</p>
        {stock.sparkline.length ? <div className="mt-2"><Sparkline values={stock.sparkline} tone={stock.factors.sentiment >= 0 ? "positive" : "negative"} /></div> : <div className="mt-2 border-t pt-2 text-xs text-muted-foreground">当前窗口暂无关联线索</div>}
        <dl className="mt-3 grid grid-cols-4 gap-2 border-y py-2">
          <div className="text-center"><dt className="text-[10px] text-muted-foreground">异动分</dt><dd className="text-sm font-semibold tabular">{stock.alertScore ?? "—"}</dd></div>
          <div className="text-center"><dt className="text-[10px] text-muted-foreground">方向分</dt><dd className="text-sm font-semibold tabular">{stock.radarScore ?? "—"}</dd></div>
          <div className="text-center"><dt className="text-[10px] text-muted-foreground">热度</dt><dd className="text-sm font-semibold tabular">{stock.factors.attention || "—"}</dd></div>
          <div className="text-center"><dt className="text-[10px] text-muted-foreground">线索</dt><dd className="text-sm font-semibold tabular">{stock.mentionCount}</dd></div>
        </dl>
        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground"><span>{stock.signal}</span><span className="flex items-center gap-1">{stock.mentionCount} 条实时线索<ChevronRight size={15} /></span></div>
      </Link>
    </article>
  );
}

function MetricBar({ value, variant = "default" }: { value: number; variant?: "default" | "consensus" }) {
  return value ? (
    <span className="inline-grid min-w-[70px] grid-cols-[42px_22px] items-center gap-1.5">
      <i className={cn("h-[3px] overflow-hidden rounded-full bg-muted", variant === "consensus" && "bg-muted")}><b className="block h-full origin-left rounded-full bg-up" style={{ transform: `scaleX(${value / 100})` }} /></i>
      <strong className="text-xs font-medium tabular">{value}</strong>
    </span>
  ) : <span className="text-xs text-muted-foreground">—</span>;
}

function DirectionScore({ score }: { score: number | null }) {
  if (score === null) return <span className="text-xs text-muted-foreground">—</span>;
  const className = score > 58 ? "text-up border-up" : score < 42 ? "text-down border-down" : "text-muted-foreground border-border";
  return <span className={cn("relative inline-flex size-11 items-center justify-center rounded-full border text-sm font-semibold tabular", className)}><strong>{score}</strong><i className="absolute -bottom-1.5 size-1 rounded-full bg-current" /></span>;
}
