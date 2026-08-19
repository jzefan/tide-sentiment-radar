import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Info,
  Loader2,
  Search,
  Star,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Sparkline } from "../components/Visuals";
import type {
  MoverTag,
  SignalLabel,
  StockListResponse,
  StockSnapshot,
} from "../domain/types";
import { api } from "../lib/api";
import { changeLabel, formatNumber } from "../lib/format";
import { useWatchlist } from "../lib/useWatchlist";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingState } from "@/components/LoadingState";
import { cn } from "@/lib/utils";

type SortBaseKey =
  | "alert"
  | "direction"
  | "attention"
  | "consensus"
  | "mentions"
  | "pct"
  | "risk"
  | "market"
  | "amount";
type SortKey = SortBaseKey | `-${SortBaseKey}`;
type SignalFilter = "all" | SignalLabel;

const signals: Array<{ value: SignalFilter; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "偏多共振", label: "偏多共振" },
  { value: "高分歧", label: "高分歧" },
  { value: "风险升温", label: "风险升温" },
  { value: "热度观察", label: "热度观察" },
  { value: "证据不足", label: "暂无线索" },
];

/** 行情类排序键（历史交易日可用）；其余为舆情类，历史日期无舆情分需回退。 */
const MARKET_SORT_KEYS: SortBaseKey[] = ["pct", "market", "amount"];

export function ScreenerPage() {
  const [payload, setPayload] = useState<StockListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [signal, setSignal] = useState<SignalFilter>("all");
  const [sort, setSort] = useState<SortKey>("alert");
  const [scope, setScope] = useState<"movers" | "watchlist">("movers");
  const [tagFilter, setTagFilter] = useState<MoverTag[]>([]);
  const [market, setMarket] = useState("all");
  const [date, setDate] = useState("");
  const [tradeDates, setTradeDates] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const watchlist = useWatchlist();
  const latestDate = tradeDates[0] ?? "";
  const isHistorical = Boolean(date) && Boolean(latestDate) && date !== latestDate;
  // 搜索始终在全市场范围内进行；只有“我的自选”且未输入关键词时才收窄到自选股。
  const requestScope: "all" | "watchlist" = scope === "watchlist" && !query ? "watchlist" : "all";

  useEffect(() => {
    const controller = new AbortController();
    api
      .tradeDates(controller.signal)
      .then((next) => setTradeDates(next.dates ?? []))
      .catch(() => {
        // 交易日列表读取失败不阻断主列表，日期选择器保持空。
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    setPage(1);
  }, [query, signal, sort, scope, market, tagFilter, date]);
  useEffect(() => {
    let controller: AbortController | null = null;
    const load = (silent = false) => {
      if (!silent) setLoading(true);
      controller?.abort();
      const activeController = new AbortController();
      controller = activeController;
      api
        .stocks(
          {
            q: query,
            signal,
            sort,
            scope: requestScope,
            market,
            date,
            tags: tagFilter,
            page,
            pageSize,
          },
          activeController.signal,
        )
        .then((next) => {
          setPayload(next);
          setError("");
        })
        .catch((cause) => {
          if (cause instanceof DOMException && cause.name === "AbortError")
            return;
          setError(
            cause instanceof Error ? cause.message : "读取全市场股票池失败",
          );
        })
        .finally(() => {
          if (controller === activeController) setLoading(false);
        });
    };
    const timer = window.setTimeout(() => load(false), query ? 220 : 0);
    const interval = window.setInterval(() => load(true), 60_000);
    return () => {
      controller?.abort();
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [query, signal, sort, scope, market, tagFilter, date, page, pageSize]);

  const items = payload?.items ?? [];
  const pages = Math.max(
    1,
    Math.ceil((payload?.total ?? 0) / Math.max(1, payload?.pageSize ?? pageSize)),
  );
  /** 列头点击：同列切换升/降序，换列默认降序（大→小）。 */
  const toggleSort = (key: SortBaseKey) => {
    setSort((current) => {
      const base = current.replace(/^-/, "") as SortBaseKey;
      if (base === key) return current.startsWith("-") ? key : `-${key}`;
      return key;
    });
  };
  const sortBase = sort.replace(/^-/, "") as SortBaseKey;
  const toggleTag = (tag: MoverTag) => {
    setTagFilter((current) =>
      current.includes(tag)
        ? current.filter((value) => value !== tag)
        : [...current, tag],
    );
  };
  const toggleWatchlist = async (code: string) => {
    try {
      await watchlist.toggle(code);
      setPayload((current) =>
        current
          ? {
              ...current,
              items: current.items
                .map((stock) =>
                  stock.code === code
                    ? { ...stock, isWatchlisted: !stock.isWatchlisted }
                    : stock,
                )
                .filter(
                  (stock) => requestScope !== "watchlist" || stock.isWatchlisted,
                ),
            }
          : current,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "自选股更新失败");
    }
  };
  const handleDateChange = (value: string) => {
    const next = value === "__latest__" ? "" : value;
    setDate(next);
    // 历史交易日没有舆情分，行情类排序外的排序键回退到成交额。
    if (next && latestDate && next !== latestDate && !MARKET_SORT_KEYS.includes(sortBase)) {
      setSort("amount");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b pb-3">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs uppercase tracking-[0.16em] text-muted-foreground">
          异动候选 · {isHistorical ? "历史交易日" : "每分钟自动更新"}
          <span className="normal-case tracking-normal">
            {date ? `交易日 ${date}` : `最新交易日${latestDate ? ` ${latestDate}` : ""}`}
          </span>
          {(payload?.analyzed ?? 0) > 0 && (
            <span className="normal-case tracking-normal">
              已关联舆情{" "}
              <strong className="font-semibold text-foreground tabular">
                {formatNumber(payload?.analyzed ?? 0)}
              </strong>
            </span>
          )}
          {loading && payload && (
            <span className="inline-flex items-center gap-1.5 normal-case tracking-normal">
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              读取中…
            </span>
          )}
        </p>
        <div className="flex items-baseline gap-2">
          <strong className="text-2xl font-semibold tabular">
            {formatNumber(payload?.universeTotal ?? 0)}
          </strong>
          <span className="text-xs text-muted-foreground">全市场</span>
        </div>
      </header>

      <div className="sticky top-0 z-20 -mx-4 border-b bg-background/95 px-4 pb-4 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-5">
            <Tabs
              value={scope}
              onValueChange={(value) => setScope(value as typeof scope)}
            >
              <TabsList className="h-9">
                <TabsTrigger value="movers" className="text-xs">
                  异动候选
                </TabsTrigger>
                <TabsTrigger value="watchlist" className="text-xs">
                  <Star className="mr-1" size={13} />
                  我的自选
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Tabs
              value={signal}
              onValueChange={(value) => setSignal(value as SignalFilter)}
              className="hidden md:block"
            >
              <TabsList className="h-9 overflow-x-auto overflow-y-hidden">
                {signals.map((item) => (
                  <TabsTrigger
                    value={item.value}
                    key={item.value}
                    className="text-xs"
                  >
                    {item.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
          <div className="flex flex-wrap items-end gap-3 md:hidden">
            <Select
              value={signal}
              onValueChange={(value) => setSignal(value as SignalFilter)}
            >
              <SelectTrigger className="w-[180px] text-xs">
                <SelectValue placeholder="舆情状态" />
              </SelectTrigger>
              <SelectContent>
                {signals.map((item) => (
                  <SelectItem value={item.value} key={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="relative min-w-[220px] flex-1">
              <Search
                size={15}
                className="absolute bottom-3 left-3 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="例如：中际旭创、300308、ZJXC、半导体"
                className="h-10 pl-9 text-sm"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "flex h-10 items-center gap-1.5 rounded-md border px-3 text-xs transition-colors",
                    tagFilter.length
                      ? "border-primary/60 bg-primary/5 text-foreground"
                      : "text-muted-foreground hover:border-foreground/40 hover:text-foreground",
                  )}
                >
                  异动标签
                  {tagFilter.length > 0 && (
                    <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground tabular">
                      {tagFilter.length}
                    </span>
                  )}
                  <ChevronDown size={13} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                <DropdownMenuLabel>异动标签（多选）</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {(["涨幅大", "跌幅大", "成交额大"] as const).map((tag) => (
                  <DropdownMenuCheckboxItem
                    key={tag}
                    checked={tagFilter.includes(tag)}
                    onCheckedChange={() => toggleTag(tag)}
                  >
                    {tag}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Select value={market} onValueChange={setMarket}>
              <SelectTrigger className="w-[130px] text-xs">
                <SelectValue placeholder="全部市场" />
              </SelectTrigger>
              <SelectContent>
                {["all", "沪市", "深市", "北交所"].map((value) => (
                  <SelectItem value={value} key={value}>
                    {value === "all" ? "全部市场" : value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={date || "__latest__"} onValueChange={handleDateChange}>
              <SelectTrigger className="w-[170px] text-xs">
                <CalendarDays size={14} />
                <SelectValue placeholder="交易日" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__latest__">
                  最新交易日{latestDate ? `（${latestDate}）` : ""}
                </SelectItem>
                {tradeDates.map((value) => (
                  <SelectItem value={value} key={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={sortBase}
              onValueChange={(value) => setSort(value as SortBaseKey)}
            >
              <SelectTrigger className="w-[190px] text-xs">
                <ArrowDownUp size={14} />
                <SelectValue placeholder="排序方式" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="alert">自选优先，其次异动分</SelectItem>
                <SelectItem value="direction">方向分偏正面</SelectItem>
                <SelectItem value="risk">方向分偏负面</SelectItem>
                <SelectItem value="attention">讨论热度</SelectItem>
                <SelectItem value="consensus">观点共识</SelectItem>
                <SelectItem value="mentions">关联线索数</SelectItem>
                <SelectItem value="pct">涨跌幅</SelectItem>
                <SelectItem value="market">市场表现</SelectItem>
                <SelectItem value="amount">成交额</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <section className="min-w-0">
        {error && payload && (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-warning/40 bg-warning-soft px-4 py-2.5 text-sm">
            <CircleAlert size={16} className="text-warning" />
            <span>自动更新暂时失败，当前仍显示上次成功数据：{error}</span>
          </div>
        )}
        <div className="mb-3 flex flex-nowrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            筛选结果{" "}
            <strong className="text-sm text-foreground tabular">
              {formatNumber(payload?.total ?? 0)}
            </strong>
          </span>
          <span className="flex items-start gap-2 text-xs text-muted-foreground">
            <i className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning" />
            方向分以 50 为中性（50+ 偏正面 / 50− 偏负面）；异动分 = 讨论增速 35%
            + 互动热度 25% + 来源质量 20% + 情绪位移
            20%，用于发现变化，不代表上涨概率。
          </span>
        </div>
        {loading && !payload ? (
          <div className="flex flex-col items-center gap-5 py-16">
            <LoadingState label="正在读取全市场股票池" />
            <Skeleton className="h-72 w-full" />
          </div>
        ) : error && !payload ? (
          <div className="flex items-center gap-2 rounded-md border px-4 py-3 text-sm">
            <CircleAlert size={16} className="text-warning" />
            <span>{error}</span>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border py-16 text-center">
            <Search size={22} className="text-muted-foreground" />
            <div>
              <h2 className="text-sm font-medium">
                {scope === "watchlist"
                  ? "自选股中没有匹配结果"
                  : "全市场中没有匹配结果"}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {isHistorical
                  ? "该交易日已保存的行情中没有符合条件的结果，换一个交易日或调整筛选后再试。"
                  : "调整关键词或舆情状态后再试。"}
              </p>
            </div>
          </div>
        ) : (
          <Card className="overflow-hidden py-0">
            <CardContent className="px-0">
              <div className="relative hidden overflow-x-auto md:block">
                <Table className="w-full table-fixed">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-10 px-1 text-center">
                        自选
                      </TableHead>
                      <TableHead className="px-2">股票与主题</TableHead>
                      <TableHead className="w-[92px] px-1 text-center">
                        舆情走势
                      </TableHead>
                      <SortableTh
                        label="异动分"
                        sortKey="alert"
                        sort={sort}
                        onSort={toggleSort}
                      />
                      <SortableTh
                        label="方向分"
                        sortKey="direction"
                        sort={sort}
                        onSort={toggleSort}
                      />
                      <SortableTh
                        label="热度"
                        sortKey="attention"
                        sort={sort}
                        onSort={toggleSort}
                      />
                      <SortableTh
                        label="共识"
                        sortKey="consensus"
                        sort={sort}
                        onSort={toggleSort}
                      />
                      <SortableTh
                        label="线索"
                        sortKey="mentions"
                        sort={sort}
                        onSort={toggleSort}
                      />
                      <SortableTh
                        label="涨跌"
                        sortKey="pct"
                        sort={sort}
                        onSort={toggleSort}
                      />
                      <SortableTh
                        label="成交额"
                        sortKey="amount"
                        sort={sort}
                        onSort={toggleSort}
                      />
                      <TableHead className="w-9 px-0">
                        <span className="sr-only">查看</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((stock) => (
                      <CandidateRow
                        key={stock.code}
                        stock={stock}
                        onToggle={toggleWatchlist}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="space-y-3 p-4 md:hidden">
                {items.map((stock) => (
                  <CandidateCard
                    key={stock.code}
                    stock={stock}
                    onToggle={toggleWatchlist}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        )}
        {!loading && !error && (payload?.total ?? 0) > 0 && (
          <nav
            className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-2"
            aria-label="股票列表分页"
          >
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((value) => value - 1)}
            >
              <ChevronLeft />
              上一页
            </Button>
            <span className="text-xs text-muted-foreground tabular">
              第 {page} / {pages} 页 · 共 {formatNumber(payload?.total ?? 0)} 条
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">每页</span>
              <Select
                value={String(pageSize)}
                onValueChange={(value) => {
                  setPageSize(Number(value));
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-8 w-[84px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[20, 50, 100].map((size) => (
                    <SelectItem value={String(size)} key={size}>
                      {size} 条
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pages}
              onClick={() => setPage((value) => value + 1)}
            >
              下一页
              <ChevronRight />
            </Button>
          </nav>
        )}
      </section>
    </div>
  );
}

const SCORE_HINTS: Partial<Record<SortBaseKey, string>> = {
  direction:
    "方向分以 50 为中性：情绪方向决定偏向，强度由情绪强度与证据权重（关注度、共识、来源质量、价格确认、时效）共同决定。50 以上偏正面，50 以下偏负面。",
};

function SortableTh({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: SortBaseKey;
  sort: SortKey;
  onSort: (key: SortBaseKey) => void;
}) {
  const active = sort === sortKey || sort === `-${sortKey}`;
  const ascending = sort === `-${sortKey}`;
  const hint = SCORE_HINTS[sortKey];
  return (
    <TableHead className="text-center">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex cursor-pointer items-center gap-0.5 whitespace-nowrap transition-colors hover:text-foreground",
          active ? "font-semibold text-foreground" : "text-muted-foreground",
        )}
        aria-label={`按${label}排序，当前${active ? (ascending ? "升序" : "降序") : "未启用"}`}
        title={`点击按${label}排序；再次点击切换升降序`}
      >
        {label}
        {active ? (
          ascending ? (
            <ArrowUp size={12} className="text-up" aria-hidden="true" />
          ) : (
            <ArrowDown size={12} className="text-up" aria-hidden="true" />
          )
        ) : (
          <ArrowDownUp size={12} className="opacity-40" aria-hidden="true" />
        )}
      </button>
      {hint && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="ml-1 inline-flex size-4 cursor-pointer items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
              aria-label={`查看${label}的说明`}
              onClick={(event) => event.stopPropagation()}
            >
              <Info size={12} />
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            className="max-w-[300px] text-xs leading-relaxed"
          >
            <p className="font-medium">{label}怎么算</p>
            <p className="mt-1 text-muted-foreground">{hint}</p>
          </TooltipContent>
        </Tooltip>
      )}
    </TableHead>
  );
}

function SparklineCell({ stock }: { stock: StockSnapshot }) {
  if (!stock.sparkline.length) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help text-xs text-muted-foreground">
            暂无
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[260px] text-xs">
          <p className="font-medium">舆情走势</p>
          <p className="mt-1 leading-relaxed text-muted-foreground">
            当前窗口内没有与该股票直接关联的线索，因此没有走势曲线。系统不会用模拟数据填充。
          </p>
        </TooltipContent>
      </Tooltip>
    );
  }
  const recent = stock.sparkline.at(-1) ?? 0;
  const average = Math.round(
    stock.sparkline.reduce((sum, value) => sum + value, 0) /
      stock.sparkline.length,
  );
  const rising = recent > average;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-block w-full cursor-help">
          <Sparkline
            values={stock.sparkline}
            tone={stock.factors.sentiment >= 0 ? "positive" : "negative"}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[270px] text-xs">
        <p className="font-medium">舆情走势</p>
        <p className="mt-1 leading-relaxed text-muted-foreground">
          折线为最近 {stock.sparkline.length} 条关联线索的
          <b className="font-medium text-foreground">热度</b>
          变化，从左到右由旧到新；热度综合发布时间、互动量与关联股票数计算。
        </p>
        <dl className="mt-2 space-y-1 border-t pt-1.5">
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">最近一条线索热度</span>
            <span className="font-mono font-medium tabular">{recent}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">平均热度</span>
            <span className="font-mono font-medium tabular">{average}</span>
          </div>
        </dl>
        <p
          className={cn("mt-1.5 font-medium", rising ? "text-up" : "text-down")}
        >
          {rising
            ? "↗ 最近热度高于平均水平，讨论正在升温"
            : "↘ 最近热度低于平均水平，讨论有所降温"}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

const ALERT_BREAKDOWN = [
  { label: "讨论增速", weight: 0.35, key: "velocity" as const },
  { label: "互动热度", weight: 0.25, key: "attention" as const },
  { label: "来源广度与质量", weight: 0.2, key: "sourceQuality" as const },
  { label: "情绪位移(绝对值)", weight: 0.2, key: "sentiment" as const },
];

function AlertScoreCell({ stock }: { stock: StockSnapshot }) {
  if (stock.alertScore === null)
    return <span className="text-xs text-muted-foreground">—</span>;
  const factors = stock.factors;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <strong className="cursor-help text-lg font-semibold tabular underline decoration-dotted decoration-muted-foreground/40 underline-offset-4">
          {stock.alertScore}
        </strong>
      </TooltipTrigger>
      <TooltipContent side="top" className="min-w-[230px] text-xs">
        <p className="font-medium">异动分 {stock.alertScore} 的计算明细</p>
        <dl className="mt-2 space-y-1">
          {ALERT_BREAKDOWN.map(({ label, weight, key }) => {
            const value =
              key === "sentiment" ? Math.abs(factors.sentiment) : factors[key];
            return (
              <div
                className="flex items-center justify-between gap-4"
                key={key}
              >
                <span className="text-muted-foreground">
                  {label} {value} × {Math.round(weight * 100)}%
                </span>
                <span className="font-mono font-medium tabular">
                  {(value * weight).toFixed(1)}
                </span>
              </div>
            );
          })}
        </dl>
        <p className="mt-2 border-t pt-1.5 text-muted-foreground">
          合计四舍五入取整 = {stock.alertScore}，用于发现变化，不代表上涨概率。
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function AmountCell({ stock }: { stock: StockSnapshot }) {
  const history = stock.amountHistory ?? [];
  return (
    <div className="flex flex-col items-center gap-1">
      <strong className="text-xs font-semibold tabular">
        {(stock.amount / 1e8).toFixed(3)}
      </strong>
      {history.length >= 2 ? (
        <div
          className="flex h-7 items-end gap-[3px]"
          title={history
            .map(
              (point) => `${point.date}：${(point.amount / 1e8).toFixed(3)}亿`,
            )
            .join("\n")}
        >
          {history.map((point, index) => {
            const max = Math.max(
              ...history.map((candidate) => candidate.amount),
            );
            return (
              <i
                key={point.date}
                className={cn(
                  "w-[6px] rounded-sm",
                  index === history.length - 1 ? "bg-up" : "bg-foreground/25",
                )}
                style={{
                  height: `${Math.max(12, (point.amount / max) * 100)}%`,
                }}
              />
            );
          })}
        </div>
      ) : (
        <span className="text-[10px] text-muted-foreground">历史不足</span>
      )}
    </div>
  );
}

const MOVER_TAG_STYLES: Record<MoverTag, string> = {
  涨幅大: "border-up/30 bg-up-soft text-up",
  跌幅大: "border-down/30 bg-down-soft text-down",
  成交额大: "border-border bg-muted text-muted-foreground",
};

function MoverTagBadge({ tag }: { tag: MoverTag }) {
  return (
    <em
      className={cn(
        "rounded border px-1.5 py-0.5 text-[10px] not-italic leading-none",
        MOVER_TAG_STYLES[tag],
      )}
    >
      {tag}
    </em>
  );
}

function WatchButton({
  stock,
  onToggle,
}: {
  stock: StockSnapshot;
  onToggle: (code: string) => void;
}) {
  const selected = Boolean(stock.isWatchlisted);
  return (
    <Button
      type="button"
      variant={selected ? "default" : "outline"}
      size="icon-sm"
      className={cn(
        "size-8",
        selected
          ? "bg-up text-up-foreground hover:bg-up/90"
          : "text-muted-foreground",
      )}
      aria-label={`${selected ? "移出" : "加入"}自选股：${stock.name}`}
      aria-pressed={selected}
      onClick={() => onToggle(stock.code)}
    >
      <Star size={15} fill={selected ? "currentColor" : "none"} />
    </Button>
  );
}

function CandidateRow({
  stock,
  onToggle,
}: {
  stock: StockSnapshot;
  onToggle: (code: string) => void;
}) {
  return (
    <TableRow>
      <TableCell className="px-1 py-2 text-center">
        <WatchButton stock={stock} onToggle={onToggle} />
      </TableCell>
      <TableCell className="px-2">
        <Link
          className="block transition-colors hover:text-up"
          to={`/stocks/${stock.code}`}
        >
          <strong className="text-sm font-medium">{stock.name}</strong>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {stock.code} · {stock.market}
          </span>
          {stock.moverTags?.length ? (
            <span className="mt-1.5 flex flex-wrap gap-1">
              {stock.moverTags.map((tag) => (
                <MoverTagBadge key={tag} tag={tag} />
              ))}
            </span>
          ) : (
            <em className="mt-1.5 block truncate text-xs not-italic text-muted-foreground">
              {stock.topics.length
                ? stock.topics.slice(0, 2).join(" · ")
                : stock.signal}
            </em>
          )}
        </Link>
      </TableCell>
      <TableCell className="w-[92px] px-1 py-2 text-center">
        <SparklineCell stock={stock} />
      </TableCell>
      <TableCell className="px-1 py-2 text-center">
        <AlertScoreCell stock={stock} />
      </TableCell>
      <TableCell className="px-1 py-2 text-center">
        <DirectionScore score={stock.radarScore} />
      </TableCell>
      <TableCell className="px-1 py-2 text-center">
        <MetricBar value={stock.factors.attention} />
      </TableCell>
      <TableCell className="px-1 py-2 text-center">
        <MetricBar value={stock.factors.consensus} variant="consensus" />
      </TableCell>
      <TableCell className="px-1 py-2 text-center tabular">
        {stock.mentionCount}
      </TableCell>
      <TableCell className="px-1 py-2 text-center">
        <strong
          className={cn(
            "font-semibold tabular",
            stock.pctChange >= 0 ? "text-up" : "text-down",
          )}
        >
          {changeLabel(stock.pctChange)}
        </strong>
      </TableCell>
      <TableCell className="w-[84px] px-1 py-2 text-center">
        <AmountCell stock={stock} />
      </TableCell>
      <TableCell className="px-0 py-2 text-center">
        <Link
          to={`/stocks/${stock.code}`}
          className="inline-flex size-8 items-center justify-center text-muted-foreground transition-colors hover:text-up"
          aria-label={`查看 ${stock.name} 详情`}
        >
          <ChevronRight size={17} />
        </Link>
      </TableCell>
    </TableRow>
  );
}

function CandidateCard({
  stock,
  onToggle,
}: {
  stock: StockSnapshot;
  onToggle: (code: string) => void;
}) {
  return (
    <article className="rounded-md border bg-card p-4">
      <div className="grid grid-cols-[36px_1fr_auto] items-center gap-3">
        <WatchButton stock={stock} onToggle={onToggle} />
        <div>
          <strong className="text-sm font-medium">{stock.name}</strong>
          <span className="block text-xs text-muted-foreground">
            {stock.code} · {stock.market}
          </span>
        </div>
        <em
          className={cn(
            "not-italic font-semibold tabular",
            stock.pctChange >= 0 ? "text-up" : "text-down",
          )}
        >
          {changeLabel(stock.pctChange)}
        </em>
      </div>
      {stock.moverTags?.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {stock.moverTags.map((tag) => (
            <MoverTagBadge key={tag} tag={tag} />
          ))}
        </div>
      ) : null}
      <Link to={`/stocks/${stock.code}`} className="mt-3 block">
        <p className="line-clamp-1 text-xs text-muted-foreground">
          {stock.summary}
        </p>
        {stock.sparkline.length ? (
          <div className="mt-2">
            <Sparkline
              values={stock.sparkline}
              tone={stock.factors.sentiment >= 0 ? "positive" : "negative"}
            />
          </div>
        ) : (
          <div className="mt-2 border-t pt-2 text-xs text-muted-foreground">
            当前窗口暂无关联线索
          </div>
        )}
        <dl className="mt-3 grid grid-cols-4 gap-2 border-y py-2">
          <div className="text-center">
            <dt className="text-[10px] text-muted-foreground">异动分</dt>
            <dd className="text-sm font-semibold tabular">
              {stock.alertScore ?? "—"}
            </dd>
          </div>
          <div className="text-center">
            <dt className="text-[10px] text-muted-foreground">方向分</dt>
            <dd className="text-sm font-semibold tabular">
              {stock.radarScore ?? "—"}
            </dd>
          </div>
          <div className="text-center">
            <dt className="text-[10px] text-muted-foreground">热度</dt>
            <dd className="text-sm font-semibold tabular">
              {stock.factors.attention || "—"}
            </dd>
          </div>
          <div className="text-center">
            <dt className="text-[10px] text-muted-foreground">线索</dt>
            <dd className="text-sm font-semibold tabular">
              {stock.mentionCount}
            </dd>
          </div>
        </dl>
        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>{stock.signal}</span>
          <span className="flex items-center gap-1">
            {stock.mentionCount} 条实时线索
            <ChevronRight size={15} />
          </span>
        </div>
      </Link>
    </article>
  );
}

function MetricBar({
  value,
  variant = "default",
}: {
  value: number;
  variant?: "default" | "consensus";
}) {
  return value ? (
    <span className="inline-grid grid-cols-[34px_20px] items-center gap-1">
      <i
        className={cn(
          "h-[3px] overflow-hidden rounded-full bg-muted",
          variant === "consensus" && "bg-muted",
        )}
      >
        <b
          className="block h-full origin-left rounded-full bg-up"
          style={{ transform: `scaleX(${value / 100})` }}
        />
      </i>
      <strong className="text-xs font-medium tabular">{value}</strong>
    </span>
  ) : (
    <span className="text-xs text-muted-foreground">—</span>
  );
}

function DirectionScore({ score }: { score: number | null }) {
  if (score === null)
    return <span className="text-xs text-muted-foreground">—</span>;
  const className =
    score > 58
      ? "text-up border-up"
      : score < 42
        ? "text-down border-down"
        : "text-muted-foreground border-border";
  return (
    <span
      className={cn(
        "relative inline-flex size-9 items-center justify-center rounded-full border text-sm font-semibold tabular",
        className,
      )}
    >
      <strong>{score}</strong>
      <i className="absolute -bottom-1.5 size-1 rounded-full bg-current" />
    </span>
  );
}
