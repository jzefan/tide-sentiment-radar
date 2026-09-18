import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Info,
  Loader2,
  Search,
  Star,
} from "lucide-react";
import { Link } from "react-router-dom";
import {
  AmountTrendChart,
  ReturnTrendSparkline,
  Sparkline,
} from "../components/Visuals";
import type {
  MoverTag,
  SignalLabel,
  StockListResponse,
  StockSnapshot,
} from "../domain/types";
import {
  api,
  type ConvertibleBondItem,
  type ConvertibleBondListResponse,
  type ConvertibleBondSort,
  type ConvertibleBondView,
  type DailyCandidateEntryResponse,
  type DailyCandidateOutcomeResponse,
  type DailyCandidatePerformanceResponse,
  type DailyCandidatesResponse,
  type DailyFocusLiveItemResponse,
  type DailyFocusPoolItemResponse,
  type DailyFocusPoolResponse,
  type DailyFocusPoolWindowSessions,
} from "../lib/api";
import { changeLabel, formatDateTime, formatNumber } from "../lib/format";
import {
  DAILY_FOCUS_REFRESH_MS,
  asNumber,
  asRecord,
  asString,
  dailyFocusCandidateStrength,
  dailyFocusBoardLabel,
  dailyFocusBoardMixText,
  dailyFocusDataMode,
  dailyFocusDataModeLabel,
  dailyFocusDataModeNotice,
  dailyFocusDateOptions,
  dailyFocusFocusTypeLabel,
  dailyFocusLaneLabel,
  dailyFocusLaneNotice,
  dailyFocusV7ScoreRows,
  dailyFocusExclusionLabel,
  dailyFocusIndustryLabel,
  dailyFocusLeadership,
  dailyFocusPhase,
  dailyFocusScoreBreakdown,
  dailyFocusSourceKind,
  dailyFocusStatus,
  discussionBaselineMedian,
  industryNewsScore,
  keepDailyFocusPayload,
  qualityEntries,
  scoreRows,
  shouldPollDailyFocus,
} from "../lib/dailyFocusPresentation";
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
  | "mentions"
  | "pct"
  | "risk"
  | "market"
  | "amount"
  | "industry_heat";
type SortKey = SortBaseKey | `-${SortBaseKey}`;
type SignalFilter = "all" | SignalLabel;
type ScreenerScope = "daily" | "pool" | "movers" | "watchlist" | "bonds";
type BondSort = ConvertibleBondSort | `-${ConvertibleBondSort}`;

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

/** 异动候选页的排序/筛选状态持久化：离开页面（看个股详情再返回）后恢复原条件。 */
const SCREENER_STORAGE_KEY = "tide.screener.state.v1";

interface ScreenerPersistedState {
  query: string;
  signal: SignalFilter;
  sort: SortKey;
  scope: ScreenerScope;
  market: string;
  tags: MoverTag[];
  date: string;
  page: number;
  pageSize: number;
  industry?: string;
  hotIndustryOnly?: boolean;
}

function loadScreenerState(): Partial<ScreenerPersistedState> {
  try {
    const raw = sessionStorage.getItem(SCREENER_STORAGE_KEY);
    const persisted = raw
      ? (JSON.parse(raw) as Partial<ScreenerPersistedState>)
      : {};
    // 首页热点行业卡片通过地址栏传入行业编号；显式地址参数进入当前实时行业视图，
    // 不应被上次会话残留的日期、关键词或状态筛选污染。
    const industry = new URLSearchParams(window.location.search)
      .get("industry")
      ?.trim();
    return industry
      ? {
          industry,
          date: "",
          query: "",
          signal: "all",
          sort: "industry_heat",
          scope: "movers",
          market: "all",
          tags: [],
          page: 1,
          hotIndustryOnly: false,
        }
      : persisted;
  } catch {
    return {};
  }
}

function saveScreenerState(state: ScreenerPersistedState) {
  try {
    sessionStorage.setItem(SCREENER_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 隐私模式等场景下忽略持久化失败。
  }
}

export function ScreenerPage() {
  const [initial] =
    useState<Partial<ScreenerPersistedState>>(loadScreenerState);
  const restoredScope = initial.scope as string | undefined;
  const [payload, setPayload] = useState<StockListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState(initial.query ?? "");
  const [signal, setSignal] = useState<SignalFilter>(initial.signal ?? "all");
  const [sort, setSort] = useState<SortKey>(
    String(initial.sort ?? "") === "consensus"
      ? "alert"
      : (initial.sort ?? "alert"),
  );
  const [scope, setScope] = useState<ScreenerScope>(
    restoredScope === "bond-upcoming" || restoredScope === "bond-latest"
      ? "bonds"
      : restoredScope &&
          ["daily", "pool", "movers", "watchlist", "bonds"].includes(
            restoredScope,
          )
        ? (restoredScope as ScreenerScope)
        : "daily",
  );
  const [tagFilter, setTagFilter] = useState<MoverTag[]>(initial.tags ?? []);
  const [market, setMarket] = useState(initial.market ?? "all");
  const [date, setDate] = useState(initial.date ?? "");
  const [tradeDates, setTradeDates] = useState<string[]>([]);
  const [page, setPage] = useState(initial.page ?? 1);
  const [pageSize, setPageSize] = useState(initial.pageSize ?? 50);
  const [industryFilter, setIndustryFilter] = useState(initial.industry ?? "");
  const [hotIndustryOnly, setHotIndustryOnly] = useState(
    initial.hotIndustryOnly ?? false,
  );
  const [industryItems, setIndustryItems] = useState<
    StockSnapshot["industryPulse"][]
  >([]);
  const [retryNonce, setRetryNonce] = useState(0);
  const watchlist = useWatchlist();
  const latestDate = tradeDates[0] ?? "";
  const isHistorical =
    Boolean(date) && Boolean(latestDate) && date !== latestDate;
  const effectiveHotIndustryOnly = hotIndustryOnly && !isHistorical;
  // 搜索始终在全市场范围内进行；只有“我的自选”且未输入关键词时才收窄到自选股。
  const requestScope: "all" | "watchlist" =
    scope === "watchlist" && !query ? "watchlist" : "all";

  // 排序/筛选条件变化即持久化，返回本页时恢复。
  useEffect(() => {
    saveScreenerState({
      query,
      signal,
      sort,
      scope,
      market,
      tags: tagFilter,
      date,
      page,
      pageSize,
      industry: industryFilter,
      hotIndustryOnly,
    });
  }, [
    query,
    signal,
    sort,
    scope,
    market,
    tagFilter,
    date,
    page,
    pageSize,
    industryFilter,
    hotIndustryOnly,
  ]);

  useEffect(() => {
    let controller: AbortController | null = null;
    const loadIndustries = () => {
      controller?.abort();
      controller = new AbortController();
      api
        .industries({}, controller.signal)
        .then((next) => setIndustryItems(next.items))
        .catch((cause) => {
          if (cause instanceof DOMException && cause.name === "AbortError")
            return;
          setIndustryItems([]);
        });
    };
    loadIndustries();
    const interval = window.setInterval(loadIndustries, 60_000);
    return () => {
      controller?.abort();
      window.clearInterval(interval);
    };
  }, []);

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

  // 交易日列表就绪后自愈：若恢复的日期已不在可用列表中（如曾被清理），自动回到最新交易日，避免 404 空页。
  useEffect(() => {
    if (
      tradeDates.length > 0 &&
      date &&
      date !== tradeDates[0] &&
      !tradeDates.includes(date)
    ) {
      setDate("");
    }
  }, [tradeDates, date]);

  // 热点行业是当前实时窗口的同期状态；历史交易日没有对应的热点快照，自动关闭避免空结果。
  useEffect(() => {
    if (isHistorical && hotIndustryOnly) setHotIndustryOnly(false);
  }, [isHistorical, hotIndustryOnly]);

  // 筛选/排序条件变化时回到第 1 页；首次挂载（含 StrictMode 双调用）不重置，保留从 sessionStorage 恢复的页码。
  const prevFilters = useRef({
    query,
    signal,
    sort,
    scope,
    market,
    tagFilter,
    date,
    industryFilter,
    hotIndustryOnly,
  });
  useEffect(() => {
    const changed =
      query !== prevFilters.current.query ||
      signal !== prevFilters.current.signal ||
      sort !== prevFilters.current.sort ||
      scope !== prevFilters.current.scope ||
      market !== prevFilters.current.market ||
      tagFilter !== prevFilters.current.tagFilter ||
      date !== prevFilters.current.date ||
      industryFilter !== prevFilters.current.industryFilter ||
      hotIndustryOnly !== prevFilters.current.hotIndustryOnly;
    prevFilters.current = {
      query,
      signal,
      sort,
      scope,
      market,
      tagFilter,
      date,
      industryFilter,
      hotIndustryOnly,
    };
    if (changed) setPage(1);
  });
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
            industry: industryFilter,
            hotIndustry: effectiveHotIndustryOnly,
            page,
            pageSize,
          },
          activeController.signal,
        )
        .then((next) => {
          setPayload(next);
          setError("");
          // 恢复的页码可能超出新数据的总页数（数据量变化），自动收回到最后一页。
          const nextPages = Math.max(
            1,
            Math.ceil(next.total / Math.max(1, next.pageSize)),
          );
          setPage((current) => (current > nextPages ? nextPages : current));
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
    // 指定了交易日但列表尚未就绪时先等待：过期日期会被上面的自愈逻辑重置，避免 404 空页闪烁。
    if (
      scope === "daily" ||
      scope === "pool" ||
      scope === "bonds" ||
      (date && tradeDates.length === 0)
    )
      return;
    const timer = window.setTimeout(() => load(false), query ? 220 : 0);
    const interval = window.setInterval(() => load(true), 60_000);
    return () => {
      controller?.abort();
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [
    query,
    signal,
    sort,
    scope,
    market,
    tagFilter,
    date,
    industryFilter,
    effectiveHotIndustryOnly,
    tradeDates,
    page,
    pageSize,
    retryNonce,
  ]);

  const items = payload?.items ?? [];
  const pages = Math.max(
    1,
    Math.ceil(
      (payload?.total ?? 0) / Math.max(1, payload?.pageSize ?? pageSize),
    ),
  );
  const hotIndustryItems = industryItems
    .filter((item): item is NonNullable<typeof item> => {
      if (isHistorical || !item) return false;
      return (
        item.textHeat >= 70 &&
        (item.relation === "舆情交易双热" ||
          item.relation === "舆情升温、价格未确认")
      );
    })
    .slice(0, 6);
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
                  (stock) =>
                    requestScope !== "watchlist" || stock.isWatchlisted,
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
    if (next && latestDate && next !== latestDate) setHotIndustryOnly(false);
    // 历史交易日没有舆情分，行情类排序外的排序键回退到成交额。
    if (
      next &&
      latestDate &&
      next !== latestDate &&
      !MARKET_SORT_KEYS.includes(sortBase)
    ) {
      setSort("amount");
    }
  };
  /** 一键清除全部筛选条件（保留当前 Tab 与排序），供筛选结果为空时快速恢复。 */
  const clearFilters = () => {
    setQuery("");
    setSignal("all");
    setMarket("all");
    setTagFilter([]);
    setDate("");
    setIndustryFilter("");
    setHotIndustryOnly(false);
    setPage(1);
  };

  if (scope === "daily") {
    return <DailyFocusPanel tradeDates={tradeDates} onTabChange={setScope} />;
  }

  if (scope === "pool") {
    return <DailyFocusPoolPanel onTabChange={setScope} />;
  }

  if (scope === "bonds") {
    return <ConvertibleBondPanel onTabChange={setScope} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b pb-3">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs uppercase tracking-[0.16em] text-muted-foreground">
          异动候选 · {isHistorical ? "历史交易日" : "每分钟自动更新"}
          <span className="normal-case tracking-normal">
            {date
              ? `交易日 ${date}`
              : `最新交易日${latestDate ? ` ${latestDate}` : ""}`}
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
              <TabsList className="h-11 max-w-[calc(100vw-2rem)] overflow-x-auto overflow-y-hidden">
                <TabsTrigger value="daily" className="text-xs">
                  每日聚焦
                </TabsTrigger>
                <TabsTrigger value="pool" className="text-xs">
                  聚焦股票池
                </TabsTrigger>
                <TabsTrigger value="movers" className="text-xs">
                  全市场异动
                </TabsTrigger>
                <TabsTrigger value="watchlist" className="text-xs">
                  <Star className="mr-1" size={13} />
                  我的自选
                </TabsTrigger>
                <TabsTrigger value="bonds" className="text-xs">
                  转债
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
            <Select
              value={industryFilter || "__all_industry__"}
              onValueChange={(value) =>
                setIndustryFilter(value === "__all_industry__" ? "" : value)
              }
            >
              <SelectTrigger className="w-[160px] text-xs">
                <SelectValue placeholder="全部行业" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all_industry__">全部行业</SelectItem>
                {industryItems
                  .filter((item): item is NonNullable<typeof item> =>
                    Boolean(item),
                  )
                  .map((item) => (
                    <SelectItem
                      value={item.profile.code}
                      key={item.profile.code}
                    >
                      {item.profile.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant={hotIndustryOnly ? "default" : "outline"}
              size="sm"
              className="h-10 text-xs"
              aria-pressed={hotIndustryOnly}
              onClick={() => setHotIndustryOnly((value) => !value)}
              disabled={isHistorical}
              title={
                isHistorical
                  ? "历史交易日没有对应的实时行业热点快照"
                  : "只看当前实时窗口的热点行业"
              }
            >
              {isHistorical ? "历史日无热点筛选" : "仅看热点行业"}
            </Button>
            <Select
              value={date || "__latest__"}
              onValueChange={handleDateChange}
            >
              <SelectTrigger className="w-[240px] text-xs sm:w-[170px]">
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
                <SelectItem value="direction">情绪方向偏正面</SelectItem>
                <SelectItem value="risk">情绪方向偏负面</SelectItem>
                <SelectItem value="attention">讨论热度</SelectItem>
                <SelectItem value="mentions">关联线索数</SelectItem>
                <SelectItem value="pct">涨跌幅</SelectItem>
                <SelectItem value="market">市场表现</SelectItem>
                <SelectItem value="amount">成交额</SelectItem>
                <SelectItem value="industry_heat">行业舆情热度</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {hotIndustryItems.length > 0 && (
        <section
          className="overflow-hidden rounded-lg border bg-card"
          aria-label="当前热点行业"
        >
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                行业雷达
              </p>
              <h2 className="mt-1 text-sm font-semibold">当前热点行业</h2>
            </div>
            <span className="text-[11px] text-muted-foreground">
              舆情热度不含涨跌幅 · 当前关系为同期状态
            </span>
          </div>
          <div className="grid gap-px overflow-x-auto sm:grid-cols-2 lg:grid-cols-3">
            {hotIndustryItems.map((pulse) => (
              <button
                type="button"
                key={pulse.profile.code}
                onClick={() => setIndustryFilter(pulse.profile.code)}
                className="min-w-[220px] px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"
                aria-label={`按${pulse.profile.name}筛选股票`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium">
                    {pulse.profile.name}
                  </span>
                  <span className="text-sm font-semibold tabular text-up">
                    {pulse.textHeat}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                  <span>
                    {pulse.relation} · {pulse.stage}
                  </span>
                  <span
                    className={
                      pulse.industryReturn >= 0 ? "text-up" : "text-down"
                    }
                  >
                    {changeLabel(pulse.industryReturn)}
                  </span>
                </div>
                {pulse.informationCategories.length ? (
                  <p className="mt-1 truncate text-[10px] text-muted-foreground">
                    信息分类：{pulse.informationCategories.join(" · ")}
                  </p>
                ) : null}
              </button>
            ))}
          </div>
          <p className="border-t px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
            热点卡只描述当前实时窗口的舆情与行情是否同向；历史后验关系需每日冻结并完成未来5个交易日的样本观察后再显示。
          </p>
        </section>
      )}
      {isHistorical && (
        <p className="-mt-1 text-xs leading-relaxed text-muted-foreground">
          当前为历史交易日：仅展示已保存的行情快照，实时热点行业与“仅看热点行业”筛选已关闭；历史后验关系需完成未来5个交易日的样本观察。
        </p>
      )}

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
            情绪方向以 50 为中性（50+ 偏正面 / 50− 偏负面）；异动分 = 讨论增速
            35% + 互动热度 25% + 来源质量 20% + 情绪位移
            20%，用于发现变化，不代表上涨概率。
          </span>
        </div>
        {loading && !payload ? (
          <div className="flex flex-col items-center gap-5 py-16">
            <LoadingState label="正在读取全市场股票池" />
            <Skeleton className="h-72 w-full" />
          </div>
        ) : error && !payload ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning-soft px-4 py-3 text-sm">
            <div className="flex min-w-0 items-center gap-2">
              <CircleAlert size={16} className="shrink-0 text-warning" />
              <span>{error}</span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRetryNonce((value) => value + 1)}
            >
              重新读取
            </Button>
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
            {(query ||
              signal !== "all" ||
              market !== "all" ||
              tagFilter.length > 0 ||
              date ||
              industryFilter ||
              hotIndustryOnly) && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={clearFilters}
              >
                清除筛选条件
              </Button>
            )}
          </div>
        ) : (
          <Card className="overflow-hidden py-0">
            <CardContent className="px-0">
              <div className="relative hidden overflow-x-auto md:block">
                <Table className="min-w-[1010px] w-full table-fixed">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-10 px-1 text-center">
                        自选
                      </TableHead>
                      <TableHead className="px-2">股票与主题</TableHead>
                      <TableHead className="w-[150px] px-2">行业联动</TableHead>
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
                        label="情绪方向"
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

function DailyFocusPoolPanel({
  onTabChange,
}: {
  onTabChange: (tab: ScreenerScope) => void;
}) {
  const [payload, setPayload] = useState<DailyFocusPoolResponse | null>(null);
  const [windowSessions, setWindowSessions] =
    useState<DailyFocusPoolWindowSessions>(5);
  /** 观察截止日；空字符串表示跟随最新交易日。 */
  const [windowEndDate, setWindowEndDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let controller: AbortController | null = null;
    const load = (silent = false) => {
      if (!silent) setLoading(true);
      controller?.abort();
      const active = new AbortController();
      controller = active;
      api
        .dailyFocusPool(windowSessions, windowEndDate, active.signal)
        .then((next) => {
          setPayload(next);
          setError("");
        })
        .catch((cause) => {
          if (cause instanceof DOMException && cause.name === "AbortError")
            return;
          setError(
            cause instanceof Error ? cause.message : "读取聚焦股票池失败",
          );
        })
        .finally(() => {
          if (controller === active) setLoading(false);
        });
    };
    load();
    // 历史窗口不再变化，只有跟随最新交易日时才需要轮询。
    const interval = windowEndDate
      ? null
      : window.setInterval(() => load(true), 60_000);
    return () => {
      controller?.abort();
      if (interval !== null) window.clearInterval(interval);
    };
  }, [retryNonce, windowEndDate, windowSessions]);

  const ratioLabel = (value: number | null) =>
    value === null ? "—" : `${(value * 100).toFixed(1)}%`;
  // 请求发出后立刻高亮被点选的日期，不用等新窗口返回。
  const activeEndDate = windowEndDate || payload?.window.end || "";
  const latestTradeDate = payload?.window.latestTradeDate ?? "";
  const viewingHistory = Boolean(windowEndDate) && windowEndDate !== latestTradeDate;

  return (
    <div className="focus-pool-page flex flex-col gap-5">
      <header className="border-b pb-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">聚焦股票池</h1>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              窗口内每日聚焦名单汇总，标注龙头与趋势。
            </p>
          </div>
          <Tabs
            value="pool"
            onValueChange={(value) => onTabChange(value as ScreenerScope)}
          >
            <TabsList className="h-11 max-w-[calc(100vw-2rem)] overflow-x-auto overflow-y-hidden">
              <TabsTrigger value="daily" className="text-xs">
                每日聚焦
              </TabsTrigger>
              <TabsTrigger value="pool" className="text-xs">
                聚焦股票池
              </TabsTrigger>
              <TabsTrigger value="movers" className="text-xs">
                全市场异动
              </TabsTrigger>
              <TabsTrigger value="watchlist" className="text-xs">
                <Star className="mr-1" size={13} />
                我的自选
              </TabsTrigger>
              <TabsTrigger value="bonds" className="text-xs">
                转债
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </header>

      <section className="focus-pool-toolbar" aria-label="聚焦股票池观察窗口">
        <div>
          <label htmlFor="focus-pool-window">观察窗口</label>
          <Select
            value={String(windowSessions)}
            onValueChange={(value) => {
              setPayload(null);
              setWindowSessions(Number(value) as DailyFocusPoolWindowSessions);
            }}
          >
            <SelectTrigger
              id="focus-pool-window"
              className="h-10 w-[156px] text-xs"
            >
              <CalendarDays size={14} />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="5">最近 5 个交易日</SelectItem>
              <SelectItem value="4">最近 4 个交易日</SelectItem>
              <SelectItem value="3">最近 3 个交易日</SelectItem>
              <SelectItem value="2">最近 2 个交易日</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label htmlFor="focus-pool-end">截止交易日</label>
          <Select
            value={windowEndDate || "__latest__"}
            onValueChange={(value) =>
              // 显式选到最新交易日时等同于“最新”，这样轮询与实时预览行为保持一致。
              setWindowEndDate(
                value === "__latest__" || value === latestTradeDate ? "" : value,
              )
            }
          >
            <SelectTrigger
              id="focus-pool-end"
              className="h-10 w-[178px] text-xs"
            >
              <CalendarDays size={14} />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__latest__">
                最新交易日{latestTradeDate ? `（${latestTradeDate}）` : ""}
              </SelectItem>
              {(payload?.window.availableTradeDates ?? []).map((tradeDate) => (
                <SelectItem value={tradeDate} key={tradeDate}>
                  {tradeDate}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p>窗口内日期可直接点选为观察截止日。</p>
        {loading && payload && (
          <LoadingState label="正在切换观察窗口" />
        )}
      </section>

      {error && !payload ? (
        <section
          className="daily-focus-notice border-warning/40 bg-warning-soft"
          role="alert"
        >
          <CircleAlert size={17} className="text-warning" />
          <div>
            <strong>无法读取聚焦股票池</strong>
            <p>{error}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRetryNonce((value) => value + 1)}
          >
            重试
          </Button>
        </section>
      ) : loading && !payload ? (
        <section className="daily-focus-loading">
          <LoadingState label={`正在汇总近 ${windowSessions} 个交易日`} />
          <Skeleton className="mt-5 h-64 w-full" />
        </section>
      ) : payload ? (
        <>
          {error ? (
            <section
              className="daily-focus-notice border-warning/40 bg-warning-soft"
              role="status"
            >
              <CircleAlert size={17} className="text-warning" />
              <p>自动更新失败，当前展示上次成功记录：{error}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRetryNonce((value) => value + 1)}
              >
                重试
              </Button>
            </section>
          ) : null}

          <section
            className="focus-pool-summary"
            aria-label={`最近${payload.window.sessions}日聚焦股票统计`}
          >
            <div className="focus-pool-window">
              <div className="focus-pool-window-head">
                <span>
                  最近 {payload.window.sessions} 个交易日
                  {viewingHistory ? " · 历史窗口" : ""}
                </span>
                {viewingHistory && (
                  <button
                    type="button"
                    className="focus-pool-reset"
                    onClick={() => setWindowEndDate("")}
                  >
                    回到最新
                  </button>
                )}
              </div>
              <strong>
                {payload.window.start && payload.window.end
                  ? `${payload.window.start} — ${payload.window.end}`
                  : "等待交易日数据"}
              </strong>
              <div
                className="focus-pool-dates"
                role="group"
                aria-label="窗口交易日，可点击选择观察截止日"
              >
                {payload.window.tradeDates.map((tradeDate) => (
                  <button
                    type="button"
                    key={tradeDate}
                    className={cn(
                      "focus-pool-date",
                      tradeDate === activeEndDate && "is-active",
                    )}
                    aria-pressed={tradeDate === activeEndDate}
                    title={`以 ${tradeDate} 作为窗口截止日（最近 ${payload.window.sessions} 个交易日）`}
                    onClick={() =>
                      setWindowEndDate(
                        tradeDate === latestTradeDate ? "" : tradeDate,
                      )
                    }
                  >
                    {tradeDate.slice(5)}
                  </button>
                ))}
              </div>
            </div>
            <PoolMetric
              label="池内股票"
              value={`${payload.stats.total} 只`}
              detail={`${payload.stats.priced} 只已有有效价格`}
            />
            <PoolMetric
              label="上涨比例"
              value={ratioLabel(payload.stats.upRatio)}
              detail={`${payload.stats.up} 涨 · ${payload.stats.flat} 平`}
              tone="up"
            />
            <PoolMetric
              label="下跌比例"
              value={ratioLabel(payload.stats.downRatio)}
              detail={`${payload.stats.down} 跌`}
              tone="down"
            />
            <PoolMetric
              label="热门行业占比"
              value={ratioLabel(payload.stats.hotIndustryRatio)}
              detail={`${payload.stats.hotIndustry} / ${payload.stats.total} 只`}
              tone={
                payload.stats.hotIndustryRatio !== null &&
                payload.stats.hotIndustryRatio >= 0.5
                  ? "up"
                  : "warning"
              }
            />
            <PoolMetric
              label="龙头占比"
              value={ratioLabel(payload.stats.leaderRatio)}
              detail={`${payload.stats.leaders} / ${payload.stats.total} 只 · 窗口内曾为龙头`}
              tone={payload.stats.leaders > 0 ? "up" : "neutral"}
            />
          </section>

          {payload.items.length ? (
            <section
              className="focus-pool-group"
              aria-labelledby="focus-pool-list-title"
            >
              <div className="focus-pool-group-head">
                <div>
                  <span>
                    {String(payload.window.sessions).padStart(2, "0")} DAY
                  </span>
                  <h2 id="focus-pool-list-title">
                    窗口内聚焦股票<em>{payload.items.length} 只</em>
                  </h2>
                </div>
                <p>龙头优先排列。</p>
              </div>
              <div className="focus-pool-columns" aria-hidden="true">
                <span>股票 / 聚焦日</span>
                <span>行业标签</span>
                <span>每日股价变动</span>
                <span>总变动</span>
                <span>趋势 / 龙头</span>
              </div>
              <div className="focus-pool-list">
                {payload.items.map((item) => (
                  <DailyFocusPoolRow item={item} key={item.code} />
                ))}
              </div>
            </section>
          ) : (
            <section className="daily-focus-empty">
              <Search size={19} />
              <div>
                <h2 className="font-medium">
                  最近 {payload.window.sessions} 个交易日暂无聚焦股票
                </h2>
                <p>
                  股票池只纳入正式冻结名单与当前交易日预览；历史回填记录不会用于短线统计。
                </p>
              </div>
            </section>
          )}

          <footer className="focus-pool-footnote">
            <span>口径</span>
            <p>
              股票范围来自窗口内已冻结的每日聚焦名单
              {payload.window.livePreviewDate
                ? `（含 ${payload.window.livePreviewDate} 预览）`
                : ""}
              ，总变动为每日涨跌幅的复合结果。趋势与龙头标记来自涨停池、龙虎榜，不是收益承诺。
            </p>
            <time>
              {payload.asOf
                ? `行情更新 ${formatDateTime(payload.asOf)}`
                : "行情时间待确认"}
            </time>
          </footer>
        </>
      ) : null}
    </div>
  );
}

function PoolMetric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "up" | "down" | "warning" | "neutral";
}) {
  return (
    <dl className={cn("focus-pool-metric", `focus-pool-metric--${tone}`)}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      <p>{detail}</p>
    </dl>
  );
}

function DailyFocusPoolRow({ item }: { item: DailyFocusPoolItemResponse }) {
  const returnTone =
    item.windowPctChange === null
      ? "neutral"
      : item.windowPctChange > 0
        ? "up"
        : item.windowPctChange < 0
          ? "down"
          : "neutral";
  const trendTone =
    item.trend.direction === "strong-up" ||
    item.trend.direction === "up" ||
    item.trend.direction === "repairing"
      ? "up"
      : item.trend.direction === "down"
        ? "down"
        : item.trend.direction === "weakening"
          ? "warning"
          : "neutral";
  const recency =
    item.sessionsSinceFocus === 0
      ? "最新交易日仍在池"
      : `距最近聚焦 ${item.sessionsSinceFocus} 个交易日`;
  return (
    <article className="focus-pool-row">
      <Link to={`/stocks/${item.code}`} className="focus-pool-stock">
        <span>
          <strong>{item.name}</strong>
          {item.leadership.isLeader ? (
            <em
              className={cn(
                "focus-pool-leader",
                item.leadership.tier === "market" && "is-market",
              )}
              title={item.leadership.reasons.join("；")}
            >
              {item.leadership.tier === "market" ? "市场龙头" : "行业龙头"}
            </em>
          ) : null}
          {item.focus.focusType ? (
            <em
              className={cn(
                "focus-pool-focus",
                item.focus.focusType === "hot" && "is-hot",
              )}
              title={
                item.focus.primaryEventTitle
                  ? `最近聚焦：${dailyFocusFocusTypeLabel(item.focus.focusType)} · ${item.focus.primaryEventTitle}`
                  : `最近聚焦：${dailyFocusFocusTypeLabel(item.focus.focusType)}`
              }
            >
              {dailyFocusFocusTypeLabel(item.focus.focusType)}
            </em>
          ) : null}
          {item.isHotIndustry ? <em>热门</em> : null}
        </span>
        <small>
          {item.code} · 窗口内聚焦 {item.focusDates.length} 日 · {recency}
        </small>
        <small title={item.focusDates.join(" / ")}>
          聚焦 {item.focusDates.map((date) => date.slice(5)).join(" / ")}
        </small>
        {item.focus.timeline.some((point) => point.lane || point.focusType) ? (
          <small title={item.focus.primaryEventTitle ?? ""}>
            {item.focus.timeline
              .map((point) => {
                const label =
                  dailyFocusLaneLabel(point.lane) ??
                  dailyFocusFocusTypeLabel(point.focusType);
                return label ? `${point.tradeDate.slice(5)} ${label}` : null;
              })
              .filter(Boolean)
              .join(" → ")}
            {item.focus.changed ? " · 理由有变化" : ""}
          </small>
        ) : null}
      </Link>
      <div className="focus-pool-industries">
        {item.industries.length ? (
          item.industries.map((industry) => (
            <span
              className={cn(industry.hot && "is-hot")}
              title={
                industry.source === "clue" ? "来自关联线索" : "个股所属行业"
              }
              key={`${industry.code}-${industry.name}`}
            >
              {industry.name}
            </span>
          ))
        ) : (
          <small>行业待确认</small>
        )}
      </div>
      <div className="focus-pool-daily" aria-label={`${item.name}每日股价变动`}>
        {item.dailyChanges.map((point) => {
          const tone =
            point.pctChange === null
              ? "neutral"
              : point.pctChange > 0
                ? "up"
                : point.pctChange < 0
                  ? "down"
                  : "neutral";
          return (
            <span
              className={`focus-pool-day focus-pool-day--${tone}`}
              key={point.tradeDate}
            >
              <time>{point.tradeDate.slice(5)}</time>
              <strong>
                {point.pctChange === null ? "—" : changeLabel(point.pctChange)}
              </strong>
              <small>
                {point.price === null ? "价格 —" : point.price.toFixed(2)}
              </small>
            </span>
          );
        })}
      </div>
      <div
        className={cn("focus-pool-return", `focus-pool-return--${returnTone}`)}
      >
        <strong>
          {item.windowPctChange === null
            ? "—"
            : changeLabel(item.windowPctChange)}
        </strong>
        <small>
          合计 · {item.upDays} 涨 / {item.downDays} 跌 / {item.flatDays} 平
        </small>
      </div>
      <div className={cn("focus-pool-trend", `focus-pool-trend--${trendTone}`)}>
        <strong>{item.trend.label}</strong>
        <p>{item.trend.summary}</p>
        <small>
          {item.leadership.maxBoardCount === null
            ? "窗口内无涨停记录（涨停池未取证时不作判断）"
            : `窗口内最高 ${item.leadership.maxBoardCount} 连板${
                item.leadership.limitUpDates.length
                  ? ` · 涨停 ${item.leadership.limitUpDates.map((date) => date.slice(5)).join("/")}`
                  : ""
              }${item.leadership.lastFirstSealTime ? ` · 最近封板 ${item.leadership.lastFirstSealTime}` : ""}`}
        </small>
        {item.leadership.dragonTigerDates.length ? (
          <small>
            龙虎榜 {item.leadership.dragonTigerDates.map((date) => date.slice(5)).join("/")}
          </small>
        ) : null}
      </div>
    </article>
  );
}

function ConvertibleBondPanel({
  onTabChange,
}: {
  onTabChange: (tab: ScreenerScope) => void;
}) {
  const [payload, setPayload] = useState<ConvertibleBondListResponse | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ConvertibleBondView>("all");
  const [sort, setSort] = useState<BondSort>("amount");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => setPage(1), [query, sort, view]);

  useEffect(() => {
    let controller: AbortController | null = null;
    const load = (silent = false) => {
      if (!silent) setLoading(true);
      controller?.abort();
      const active = new AbortController();
      controller = active;
      api
        .convertibleBonds(
          { view, q: query, sort, page, pageSize },
          active.signal,
        )
        .then((next) => {
          setPayload(next);
          setError("");
          const pages = Math.max(
            1,
            Math.ceil(next.total / Math.max(1, next.pageSize)),
          );
          if (page > pages) setPage(pages);
        })
        .catch((cause) => {
          if (cause instanceof DOMException && cause.name === "AbortError")
            return;
          setError(
            cause instanceof Error ? cause.message : "读取可转债列表失败",
          );
        })
        .finally(() => {
          if (controller === active) setLoading(false);
        });
    };
    const timer = window.setTimeout(() => load(false), query ? 220 : 0);
    const interval = window.setInterval(() => load(true), 5 * 60_000);
    return () => {
      controller?.abort();
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [query, sort, view, page, pageSize, retryNonce]);

  const changeView = (next: ConvertibleBondView) => {
    setView(next);
    setSort(
      next === "latest"
        ? "listingDate"
        : next === "upcoming"
          ? "-subscriptionDate"
          : "amount",
    );
  };

  const toggleSort = (key: ConvertibleBondSort) => {
    setSort((current) => {
      const currentKey = current.replace(/^-/, "") as ConvertibleBondSort;
      if (currentKey === key) return current.startsWith("-") ? key : `-${key}`;
      return key;
    });
  };

  const items = payload?.items ?? [];
  const pages = Math.max(
    1,
    Math.ceil(
      (payload?.total ?? 0) / Math.max(1, payload?.pageSize ?? pageSize),
    ),
  );

  return (
    <div className="flex flex-col gap-5">
      <header className="border-b pb-4">
        <div className="flex min-w-0 items-end justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight">转债</h1>
            <p
              className="mt-1 truncate whitespace-nowrap text-sm text-muted-foreground"
              title="覆盖沪深市场可交易及已披露待交易的转债；最近一个月上市的转债在列表内标记。不构成投资建议。"
            >
              覆盖沪深市场可交易及已披露待交易的转债；最近一个月上市的转债在列表内标记。不构成投资建议。
            </p>
          </div>
          <div className="flex items-baseline gap-2">
            <strong className="text-2xl font-semibold tabular">
              {formatNumber(payload?.total ?? 0)}
            </strong>
            <span className="text-xs text-muted-foreground">只</span>
          </div>
        </div>
      </header>

      <div className="sticky top-0 z-20 -mx-4 border-b bg-background/95 px-4 pb-4 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="flex flex-col gap-3">
          <Tabs
            value="bonds"
            onValueChange={(value) => onTabChange(value as ScreenerScope)}
          >
            <TabsList className="h-11 max-w-[calc(100vw-2rem)] overflow-x-auto overflow-y-hidden">
              <TabsTrigger value="daily" className="text-xs">
                每日聚焦
              </TabsTrigger>
              <TabsTrigger value="pool" className="text-xs">
                聚焦股票池
              </TabsTrigger>
              <TabsTrigger value="movers" className="text-xs">
                全市场异动
              </TabsTrigger>
              <TabsTrigger value="watchlist" className="text-xs">
                <Star className="mr-1" size={13} />
                我的自选
              </TabsTrigger>
              <TabsTrigger value="bonds" className="text-xs">
                转债
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] flex-1">
              <Search
                size={15}
                className="absolute bottom-3 left-3 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索转债代码、名称、正股或评级"
                className="h-10 pl-9 text-sm"
              />
            </div>
            <Select
              value={view}
              onValueChange={(value) =>
                changeView(value as ConvertibleBondView)
              }
            >
              <SelectTrigger className="h-10 w-[145px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部转债</SelectItem>
                <SelectItem value="latest">最新可交易</SelectItem>
                <SelectItem value="upcoming">即将交易</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-[11px] text-muted-foreground">
              东方财富公开行情 ·{" "}
              {payload ? formatDateTime(payload.asOf) : "读取中"}
              {loading && payload ? (
                <Loader2
                  size={12}
                  className="ml-1.5 inline animate-spin"
                  aria-hidden="true"
                />
              ) : null}
            </span>
          </div>
        </div>
      </div>

      {error && payload ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning-soft px-4 py-2.5 text-sm">
          <span className="flex items-center gap-2">
            <CircleAlert size={16} className="text-warning" />
            自动更新失败，仍显示上次数据：{error}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRetryNonce((value) => value + 1)}
          >
            重试
          </Button>
        </div>
      ) : null}

      {loading && !payload ? (
        <div className="flex flex-col items-center gap-5 py-16">
          <LoadingState label="正在读取可转债列表" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : error && !payload ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning-soft px-4 py-3 text-sm">
          <span className="flex items-center gap-2">
            <CircleAlert size={16} className="text-warning" />
            {error}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRetryNonce((value) => value + 1)}
          >
            重新读取
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border py-16 text-center">
          <CalendarDays size={22} className="text-muted-foreground" />
          <div>
            <h2 className="text-sm font-medium">
              {query ? "没有匹配的转债" : "当前没有可展示的转债"}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {query
                ? "换一个代码、名称、正股或评级再试。"
                : "发行日历会在公告披露后自动更新。"}
            </p>
          </div>
          {query ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setQuery("")}
            >
              清除搜索
            </Button>
          ) : null}
        </div>
      ) : (
        <Card className="overflow-hidden py-0">
          <CardContent className="px-0">
            <div className="hidden lg:block">
              <Table className="w-full table-fixed text-xs">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <BondSortableTh
                      label="转债"
                      sortKey="name"
                      sort={sort}
                      onSort={toggleSort}
                      className="w-[15%] px-3"
                      align="left"
                    />
                    <BondSortableTh
                      label="价格"
                      sortKey="price"
                      sort={sort}
                      onSort={toggleSort}
                      className="w-[8%]"
                      align="right"
                    />
                    <BondSortableTh
                      label="涨跌幅"
                      sortKey="pctChange"
                      sort={sort}
                      onSort={toggleSort}
                      className="w-[8%]"
                      align="right"
                    />
                    <BondSortableTh
                      label="成交额"
                      sortKey="amount"
                      sort={sort}
                      onSort={toggleSort}
                      className="w-[9%]"
                      align="right"
                    />
                    <BondStackedSortableTh
                      items={[
                        { label: "转股价值", sortKey: "conversionValue" },
                        { label: "溢价", sortKey: "premiumRate" },
                      ]}
                      sort={sort}
                      onSort={toggleSort}
                      className="w-[13%]"
                      align="right"
                    />
                    <BondSortableTh
                      label="正股"
                      sortKey="stock"
                      sort={sort}
                      onSort={toggleSort}
                      className="w-[15%] px-3"
                      align="left"
                    />
                    <BondStackedSortableTh
                      items={[
                        { label: "评级", sortKey: "rating" },
                        { label: "规模", sortKey: "issueScale" },
                      ]}
                      sort={sort}
                      onSort={toggleSort}
                      className="w-[10%]"
                      align="right"
                    />
                    <BondStackedSortableTh
                      items={[
                        { label: "上市日", sortKey: "listingDate" },
                        { label: "申购日", sortKey: "subscriptionDate" },
                      ]}
                      sort={sort}
                      onSort={toggleSort}
                      className="w-[17%]"
                      align="left"
                    />
                    <TableHead className="w-[5%]">
                      <span className="sr-only">资料</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <ConvertibleBondRow item={item} key={item.code} />
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="space-y-3 p-4 lg:hidden">
              {items.map((item) => (
                <ConvertibleBondCard item={item} key={item.code} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {!loading && !error && (payload?.total ?? 0) > 0 ? (
        <nav
          className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2"
          aria-label="可转债列表分页"
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
      ) : null}
    </div>
  );
}

function BondSortableTh({
  label,
  sortKey,
  sort,
  onSort,
  className,
  align,
}: {
  label: string;
  sortKey: ConvertibleBondSort;
  sort: BondSort;
  onSort: (key: ConvertibleBondSort) => void;
  className?: string;
  align: "left" | "right";
}) {
  const active = sort === sortKey || sort === `-${sortKey}`;
  const ascending = sort === `-${sortKey}`;
  return (
    <TableHead
      className={cn(className, align === "right" ? "text-right" : "text-left")}
      aria-sort={active ? (ascending ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex cursor-pointer items-center gap-0.5 whitespace-nowrap transition-colors hover:text-foreground",
          align === "right" && "justify-end",
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
    </TableHead>
  );
}

function BondStackedSortableTh({
  items,
  sort,
  onSort,
  className,
  align,
}: {
  items: Array<{ label: string; sortKey: ConvertibleBondSort }>;
  sort: BondSort;
  onSort: (key: ConvertibleBondSort) => void;
  className?: string;
  align: "left" | "right";
}) {
  return (
    <TableHead
      className={cn(className, align === "right" ? "text-right" : "text-left")}
    >
      <div
        className={cn(
          "flex items-center gap-1 whitespace-nowrap",
          align === "right" && "justify-end",
        )}
      >
        {items.map(({ label, sortKey }, index) => {
          const active = sort === sortKey || sort === `-${sortKey}`;
          const ascending = sort === `-${sortKey}`;
          return (
            <span className="inline-flex items-center gap-1" key={sortKey}>
              {index > 0 ? (
                <span className="text-muted-foreground/60" aria-hidden="true">
                  /
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => onSort(sortKey)}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-0.5 whitespace-nowrap transition-colors hover:text-foreground",
                  active
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground",
                )}
                aria-label={`按${label}排序，当前${active ? (ascending ? "升序" : "降序") : "未启用"}`}
                title={`点击按${label}排序；再次点击切换升降序`}
              >
                {label}
                {active ? (
                  ascending ? (
                    <ArrowUp size={11} className="text-up" aria-hidden="true" />
                  ) : (
                    <ArrowDown
                      size={11}
                      className="text-up"
                      aria-hidden="true"
                    />
                  )
                ) : (
                  <ArrowDownUp
                    size={11}
                    className="opacity-35"
                    aria-hidden="true"
                  />
                )}
              </button>
            </span>
          );
        })}
      </div>
    </TableHead>
  );
}

function BondStatusTags({
  upcoming = false,
  latest = false,
}: {
  upcoming?: boolean;
  latest?: boolean;
}) {
  if (!upcoming && !latest) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
        upcoming ? "bg-warning-soft text-warning" : "bg-up-soft text-up",
      )}
    >
      {upcoming ? "即将交易" : "最新可交易"}
    </span>
  );
}

function ConvertibleBondRow({ item }: { item: ConvertibleBondItem }) {
  return (
    <TableRow>
      <TableCell className="px-3">
        <a
          className="group flex min-w-0 flex-col"
          href={`https://data.eastmoney.com/kzz/detail/${item.code}.html`}
          target="_blank"
          rel="noreferrer"
        >
          <span className="flex min-w-0 items-center gap-1">
            <strong className="truncate text-sm font-medium group-hover:underline">
              {item.name}
            </strong>
            <BondStatusTags
              upcoming={item.isUpcoming}
              latest={item.isLatestTradable}
            />
          </span>
          <span className="text-[11px] text-muted-foreground tabular">
            {item.code} · {item.exchange}
          </span>
        </a>
      </TableCell>
      <TableCell className="text-right font-medium tabular">
        {formatBondNumber(item.price)}
      </TableCell>
      <TableCell
        className={cn(
          "text-right tabular",
          item.pctChange === null
            ? "text-muted-foreground"
            : item.pctChange >= 0
              ? "text-up"
              : "text-down",
        )}
      >
        {item.pctChange === null ? "—" : changeLabel(item.pctChange)}
      </TableCell>
      <TableCell className="text-right text-xs tabular">
        {formatBondAmount(item.amount)}
      </TableCell>
      <TableCell className="text-right text-xs tabular">
        <strong className="block font-medium">
          {formatBondNumber(item.conversionValue)}
        </strong>
        <span className="text-muted-foreground">
          {item.premiumRate === null
            ? "溢价 —"
            : `溢价 ${item.premiumRate.toFixed(2)}%`}
        </span>
      </TableCell>
      <TableCell className="px-3">
        <Link
          className="flex min-w-0 flex-col hover:underline"
          to={`/stocks/${item.stockCode}`}
        >
          <span className="truncate text-sm">
            {item.stockName || item.stockCode}
          </span>
          <span className="whitespace-nowrap text-[11px] text-muted-foreground tabular">
            {item.stockCode}
            {item.stockPrice === null
              ? ""
              : ` · ¥${item.stockPrice.toFixed(2)}`}
            <span
              className={cn(
                "ml-1",
                item.stockPctChange === null
                  ? ""
                  : item.stockPctChange >= 0
                    ? "text-up"
                    : "text-down",
              )}
            >
              {item.stockPctChange === null
                ? ""
                : ` · ${changeLabel(item.stockPctChange)}`}
            </span>
          </span>
          <span className="whitespace-nowrap text-[11px] text-muted-foreground tabular">
            {formatStockAmount(item.stockAmount)}
          </span>
        </Link>
      </TableCell>
      <TableCell className="text-right text-xs tabular">
        <strong className="block font-medium">{item.rating ?? "—"}</strong>
        <span className="text-muted-foreground">
          {item.issueScale === null
            ? "规模 —"
            : `${item.issueScale.toFixed(2)} 亿`}
        </span>
      </TableCell>
      <TableCell className="text-xs tabular">
        <strong className="block font-medium">
          {item.listingDate ?? "待上市"}
        </strong>
        <span className="text-muted-foreground">
          申购 {item.subscriptionDate ?? "待披露"}
        </span>
      </TableCell>
      <TableCell>
        <a
          href={`https://data.eastmoney.com/kzz/detail/${item.code}.html`}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground"
          aria-label={`查看${item.name}资料`}
        >
          <ExternalLink size={14} />
        </a>
      </TableCell>
    </TableRow>
  );
}

function ConvertibleBondCard({ item }: { item: ConvertibleBondItem }) {
  return (
    <article className="rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="flex items-center gap-1.5">
            <a
              className="font-medium hover:underline"
              href={`https://data.eastmoney.com/kzz/detail/${item.code}.html`}
              target="_blank"
              rel="noreferrer"
            >
              {item.name}
            </a>
            <BondStatusTags
              upcoming={item.isUpcoming}
              latest={item.isLatestTradable}
            />
          </span>
          <p className="mt-0.5 text-[11px] text-muted-foreground tabular">
            {item.code} · {item.exchange} · {item.rating ?? "未评级"}
          </p>
        </div>
        <div className="text-right">
          <strong className="tabular">{formatBondNumber(item.price)}</strong>
          <p
            className={cn(
              "text-xs tabular",
              item.pctChange === null
                ? "text-muted-foreground"
                : item.pctChange >= 0
                  ? "text-up"
                  : "text-down",
            )}
          >
            {item.pctChange === null ? "待交易" : changeLabel(item.pctChange)}
          </p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-3 border-y py-3 text-xs">
        <div>
          <dt className="text-muted-foreground">转股价值</dt>
          <dd className="mt-1 font-medium tabular">
            {formatBondNumber(item.conversionValue)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">转股溢价</dt>
          <dd className="mt-1 font-medium tabular">
            {item.premiumRate === null
              ? "—"
              : `${item.premiumRate.toFixed(2)}%`}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">发行规模</dt>
          <dd className="mt-1 font-medium tabular">
            {item.issueScale === null
              ? "—"
              : `${item.issueScale.toFixed(2)} 亿`}
          </dd>
        </div>
      </dl>
      <div className="mt-3 flex items-end justify-between gap-3 text-xs">
        <div className="min-w-0">
          <Link className="hover:underline" to={`/stocks/${item.stockCode}`}>
            {item.stockName || item.stockCode}{" "}
            <span className="text-muted-foreground tabular">
              {item.stockCode}
            </span>
          </Link>
          <p className="mt-0.5 whitespace-nowrap text-[11px] text-muted-foreground tabular">
            <span
              className={cn(
                item.stockPctChange === null
                  ? ""
                  : item.stockPctChange >= 0
                    ? "text-up"
                    : "text-down",
              )}
            >
              {item.stockPctChange === null
                ? "涨跌 —"
                : changeLabel(item.stockPctChange)}
            </span>{" "}
            · {formatStockAmount(item.stockAmount)}
          </p>
        </div>
        <span className="text-right text-muted-foreground tabular">
          {item.listingDate
            ? `上市 ${item.listingDate}`
            : `申购 ${item.subscriptionDate ?? "待披露"}`}
        </span>
      </div>
    </article>
  );
}

function formatBondNumber(value: number | null) {
  return value === null ? "—" : value.toFixed(2);
}

function formatBondAmount(value: number | null) {
  if (value === null) return "—";
  return value >= 100_000_000
    ? `${(value / 100_000_000).toFixed(2)} 亿`
    : `${(value / 10_000).toFixed(0)} 万`;
}

function formatStockAmount(value: number | null) {
  return value === null
    ? "成交 —"
    : `成交 ${(value / 100_000_000).toFixed(2)} 亿`;
}

function DailyFocusPanel({
  tradeDates,
  onTabChange,
}: {
  tradeDates: string[];
  onTabChange: (tab: ScreenerScope) => void;
}) {
  const [date, setDate] = useState("");
  const [payload, setPayload] = useState<DailyCandidatesResponse | null>(null);
  const [performance, setPerformance] =
    useState<DailyCandidatePerformanceResponse | null>(null);
  const [windowDays, setWindowDays] = useState<20 | 60>(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [currentTradeDate, setCurrentTradeDate] = useState("");
  const liveTradeDate =
    currentTradeDate ||
    tradeDates[0] ||
    (date ? "" : (payload?.tradeDate ?? ""));
  const dateOptions = dailyFocusDateOptions(tradeDates, liveTradeDate);

  useEffect(() => {
    if (!shouldPollDailyFocus(date, liveTradeDate)) return;
    const interval = window.setInterval(
      () => setRefreshNonce((value) => value + 1),
      DAILY_FOCUS_REFRESH_MS,
    );
    return () => window.clearInterval(interval);
  }, [date, liveTradeDate]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    Promise.all([
      api.dailyCandidates(date || undefined, controller.signal),
      api.dailyCandidatePerformance(windowDays, 0, controller.signal),
    ])
      .then(([nextCandidates, nextPerformance]) => {
        if (!date) setCurrentTradeDate(nextCandidates.tradeDate);
        setPayload((current) => keepDailyFocusPayload(current, nextCandidates));
        setPerformance((current) =>
          keepDailyFocusPayload(current, nextPerformance),
        );
        setError("");
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError")
          return;
        setError(cause instanceof Error ? cause.message : "读取每日聚焦失败");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [date, windowDays, retryNonce, refreshNonce]);

  const status = payload
    ? dailyFocusStatus(payload.status, payload.origin)
    : null;
  // 证据模式与实测通道构成：文本证据不足时必须明说榜单由什么构成（设计 §33）。
  const dataMode = payload ? dailyFocusDataMode(payload.dataQuality) : null;
  const dataModeNotice = dataMode ? dailyFocusDataModeNotice(dataMode) : null;
  const laneNotice = payload
    ? dailyFocusLaneNotice(
        payload.items.slice(0, 8).map((item) => asRecord(item.snapshot).lane),
      )
    : null;
  const historyHydrating = payload?.dataQuality.history === "hydrating";
  const selectedDate = date || payload?.tradeDate || "";

  return (
    <div className="daily-focus-page flex flex-col gap-5">
      <header className="daily-focus-header border-b pb-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">每日聚焦</h1>
          </div>
          <Tabs
            value="daily"
            onValueChange={(value) => onTabChange(value as ScreenerScope)}
          >
            <TabsList className="h-11 max-w-[calc(100vw-2rem)] overflow-x-auto overflow-y-hidden">
              <TabsTrigger value="daily" className="text-xs">
                每日聚焦
              </TabsTrigger>
              <TabsTrigger value="pool" className="text-xs">
                聚焦股票池
              </TabsTrigger>
              <TabsTrigger value="movers" className="text-xs">
                全市场异动
              </TabsTrigger>
              <TabsTrigger value="watchlist" className="text-xs">
                <Star className="mr-1" size={13} />
                我的自选
              </TabsTrigger>
              <TabsTrigger value="bonds" className="text-xs">
                转债
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </header>

      <section className="daily-focus-toolbar" aria-label="每日聚焦范围">
        <div className="flex flex-wrap items-center gap-3">
          <label
            className="text-xs text-muted-foreground"
            htmlFor="daily-focus-date"
          >
            候选日期
          </label>
          <Select
            value={date || "__latest__"}
            onValueChange={(value) =>
              setDate(value === "__latest__" ? "" : value)
            }
          >
            <SelectTrigger id="daily-focus-date" className="w-[205px] text-xs">
              <CalendarDays size={14} />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__latest__">
                当前交易日（未冻结时显示预览）
              </SelectItem>
              {dateOptions.map((item) => (
                <SelectItem value={item} key={item}>
                  {item}
                  {item === liveTradeDate ? "（当前交易日）" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {loading && (
            <LoadingState label="正在校验冻结记录" className="ml-auto" />
          )}
        </div>
      </section>

      {error && !payload ? (
        <section
          className="daily-focus-notice border-warning/40 bg-warning-soft"
          role="alert"
        >
          <CircleAlert size={17} className="text-warning" />
          <div>
            <strong>无法读取 {selectedDate || "最新"} 每日聚焦</strong>
            <p>{error}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRetryNonce((value) => value + 1)}
          >
            重试
          </Button>
        </section>
      ) : loading && !payload ? (
        <section className="daily-focus-loading">
          <LoadingState label="正在读取每日聚焦" />
          <Skeleton className="mt-5 h-48 w-full" />
        </section>
      ) : payload && status ? (
        <>
          {error && (
            <section
              className="daily-focus-notice border-warning/40 bg-warning-soft"
              role="status"
            >
              <CircleAlert size={17} className="text-warning" />
              <p>自动更新失败，当前展示上次成功记录：{error}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRetryNonce((value) => value + 1)}
              >
                重试
              </Button>
            </section>
          )}
          <section className="daily-focus-audit" aria-label="冻结审计摘要">
            <div className="daily-focus-status">
              <span
                className={cn(
                  "daily-focus-state",
                  `daily-focus-state--${status.tone}`,
                )}
              >
                {status.label}
              </span>
              <div>
                <strong>{payload.tradeDate}</strong>
                <p>{status.detail}</p>
              </div>
            </div>
            <AuditMetric
              label="特征截点"
              value={formatDateTime(payload.featureCutoff)}
            />
            <AuditMetric
              label="冻结时间"
              value={
                payload.frozenAt ? formatDateTime(payload.frozenAt) : "未冻结"
              }
            />
            <AuditMetric label="方法版本" value={payload.methodologyVersion} />
            <AuditMetric
              label="数据质量"
              value={dataQualitySummary(payload.dataQuality)}
            />
            {dataMode ? (
              <AuditMetric
                label="证据模式"
                value={dailyFocusDataModeLabel(dataMode)}
              />
            ) : null}
          </section>
          <QualityDisclosure quality={payload.dataQuality} />

          {dataModeNotice || laneNotice ? (
            <section className="daily-focus-mode-note" role="status">
              <Info size={15} />
              <p>{[dataModeNotice, laneNotice].filter(Boolean).join(" ")}</p>
            </section>
          ) : null}

          {payload.items.length === 0 &&
          (payload.liveFocusItems?.length ?? 0) > 0 ? (
            <LiveFocusFallback items={payload.liveFocusItems!} />
          ) : payload.status === "unavailable" ? (
            <section className="daily-focus-empty border-warning/40 bg-warning-soft">
              <CircleAlert size={19} className="text-warning" />
              <div>
                <h2 className="font-medium">本日没有可展示的候选</h2>
                <p>
                  {payload.reason === "候选数量不足 3 只"
                    ? "该历史记录按旧版“至少 3 只”规则冻结，原始空记录保持不变；新版规则从后续交易日起改为合格几只展示几只，最多 10 只。"
                    : (payload.reason ??
                      "没有标的通过筛选门槛，或数据覆盖尚未达到冻结要求。")}
                </p>
              </div>
            </section>
          ) : payload.items.length === 0 ? (
            <section className="daily-focus-empty">
              <Search size={19} />
              <div>
                <h2 className="font-medium">
                  {historyHydrating ? "正在补齐近 5 日行情" : "暂无候选"}
                </h2>
                <p>
                  {historyHydrating
                    ? "正在补齐当日候选池的历史成交额，完成后会自动更新推荐列表。"
                    : "该日已有记录，但没有可展示的候选。请查看数据质量与排除计数。"}
                </p>
              </div>
            </section>
          ) : (
            <section
              className="daily-focus-list"
              aria-labelledby="daily-focus-ranking-title"
            >
              <div className="daily-focus-section-head">
                <div>
                  <p className="text-[10px] tracking-[0.16em] text-muted-foreground">
                    候选排序
                  </p>
                  <h2 id="daily-focus-ranking-title">
                    候选排行 <span>{payload.items.length} 只</span>
                  </h2>
                </div>
                <p>
                  V7 以未来约两周仍值得持续研究的新变化为主，并保留少量当前最热股票。
                  研究价值权重 80%，当前热度权重 20%；不再按板块配额凑满固定数量。
                </p>
                <p className="daily-focus-board-mix">
                  本次入选板块：{dailyFocusBoardMixText(payload.items.slice(0, 8).map((item) => item.code))}
                </p>
              </div>
              <div className="daily-focus-columns" aria-hidden="true">
                <span>名次 / 标的</span>
                <span>入选强度</span>
                <span>总分</span>
                <span>情绪 / 讨论</span>
                <span>行情 / 次日趋势</span>
                <span />
              </div>
              <div className="divide-y">
                {payload.items.slice(0, 8).map((item) => (
                  <DailyFocusCandidate
                    key={item.code}
                    item={item}
                    outcome={
                      payload.outcomes.find(
                        (outcome) => outcome.code === item.code,
                      ) ?? null
                    }
                    frozen={
                      payload.status === "frozen" &&
                      payload.origin === "prospective"
                    }
                  />
                ))}
              </div>
            </section>
          )}
          <PerformanceStrip
            performance={performance}
            windowDays={windowDays}
            onWindowChange={setWindowDays}
          />
          <section className="daily-focus-footnote">
            <span>排除计数</span>
            {Object.entries(payload.exclusionCounts).length ? (
              Object.entries(payload.exclusionCounts).map(([key, value]) => (
                <em key={key}>
                  {dailyFocusExclusionLabel(key)} {value}
                </em>
              ))
            ) : (
              <em>无</em>
            )}
            <p>
              减持排除依据当日数据窗口内已核验的上市公司公告，命中即不可放宽；
              仅 prospective + frozen 的完整 T+3 样本计入表现，重建记录始终排除。
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}

function LiveFocusFallback({ items }: { items: DailyFocusLiveItemResponse[] }) {
  return (
    <section
      className="daily-focus-list"
      aria-labelledby="daily-focus-live-title"
    >
      <div className="daily-focus-section-head">
        <div>
          <p className="text-[10px] tracking-[0.16em] text-muted-foreground">
            历史补齐期间
          </p>
          <h2 id="daily-focus-live-title">
            盘中关注 <span>{items.length} 只</span>
          </h2>
        </div>
        <p>
          从沪深全部 A 股中评分，排除北交所及成交额不足 1 亿的股票；成交额权重
          30%。待近 5 日成交额补齐后自动切换为正式候选。
        </p>
      </div>
      <div className="daily-focus-columns" aria-hidden="true">
        <span>名次 / 标的</span>
        <span>盘中评分</span>
        <span>情绪方向</span>
        <span>讨论热度</span>
        <span>行情 / 行业</span>
        <span />
      </div>
      <div className="divide-y">
        {items.slice(0, 10).map((item) => (
          <div className="daily-focus-row" key={item.code}>
            <Link to={`/stocks/${item.code}`} className="daily-focus-stock">
              <span className="daily-focus-rank">
                {String(item.rank).padStart(2, "0")}
              </span>
              <span>
                <strong>{item.name}</strong>
                <small>
                  {item.code} ·{" "}
                  {dailyFocusBoardLabel(item.code) ?? "板块未识别"}
                </small>
                <small>{item.reasons.join(" · ")}</small>
              </span>
            </Link>
            <strong className="daily-focus-score">
              {item.liveScore.toFixed(1)}
              <small>待历史确认</small>
              <small>成交 {item.scores.turnover.toFixed(1)} / 30</small>
            </strong>
            <strong className="daily-focus-score">
              {item.textDirection ?? "—"}
              <small>情绪方向</small>
            </strong>
            <span className="daily-focus-signal">
              <b>{item.discussionCount}</b>
              <small>当前讨论</small>
            </span>
            <span className="daily-focus-market">
              <b className={item.pctChange >= 0 ? "text-up" : "text-down"}>
                {changeLabel(item.pctChange)}
              </b>
              <small>成交 {(item.amount / 100_000_000).toFixed(2)} 亿</small>
              <small>{item.industryName ?? "行业待确认"}</small>
            </span>
            <Link className="daily-focus-expand" to={`/stocks/${item.code}`}>
              查看
            </Link>
          </div>
        ))}
      </div>
    </section>
  );
}

function AuditMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="daily-focus-audit-metric">
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

function dataQualitySummary(value: Record<string, unknown>) {
  const entries = qualityEntries(value);
  const preferred = ["行情", "行情股票数"].flatMap((label) =>
    entries.filter(([key]) => key === label),
  );
  const parts = [
    ...preferred,
    ...entries.filter(([key]) => !preferred.some(([label]) => label === key)),
  ].map(([key, item]) => `${key}: ${item}`);
  return parts.slice(0, 2).join(" · ") || "已留存质量审计";
}

function QualityDisclosure({ quality }: { quality: Record<string, unknown> }) {
  const entries = qualityEntries(quality);
  if (!entries.length) return null;
  return (
    <details className="daily-focus-quality">
      <summary>展开完整数据质量证据（来源状态、失败项与覆盖水位）</summary>
      <dl>
        {entries.map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** 旧冻结记录没有行业新闻字段，返回 undefined 以便界面区分“未留存”和“当日无新闻”。 */
function industryNewsSignalOf(
  snapshot: Record<string, unknown>,
): { count: number; textDirection: number } | null | undefined {
  if (!("industryNews" in snapshot)) return undefined;
  const raw = snapshot.industryNews;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const count = asNumber(record.count);
  const textDirection = asNumber(record.textDirection);
  return count === null || textDirection === null ? null : { count, textDirection };
}

/** 行业舆情角度：热门行业的当日新闻列表，以及它在行业共振分里的占比。 */
function IndustryNewsAngle({
  industryName,
  relation,
  textHeat,
  signal,
  evidence,
}: {
  industryName: string | null;
  relation: string | null;
  textHeat: number | null;
  signal: { count: number; textDirection: number } | null | undefined;
  evidence: Record<string, unknown>[] | null;
}) {
  if (!industryName)
    return (
      <p className="text-xs text-muted-foreground">
        行业未确认，无法归属行业新闻；本项不计分。
      </p>
    );
  return (
    <div className="daily-focus-industry-news">
      <p className="text-xs text-muted-foreground">
        {industryName}
        {relation ? ` · ${relation}` : ""}
        {textHeat === null ? "" : ` · 舆情热度 ${textHeat}`}
        {signal ? ` · 行业舆情方向 ${signal.textDirection}` : ""}
      </p>
      {evidence === null ? (
        <p className="mt-2 text-xs text-muted-foreground">
          该冻结记录按旧版口径生成，未留存行业新闻证据。
        </p>
      ) : evidence.length ? (
        <ul className="daily-focus-evidence">
          {evidence.slice(0, 5).map((item, index) => {
            const title = asString(item.title) ?? asString(item.source) ?? "行业新闻";
            const url = asString(item.url);
            return (
              <li key={`${asString(item.id) ?? "industry-news"}-${index}`}>
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer">
                    {title}
                    <ExternalLink size={12} />
                  </a>
                ) : (
                  <span>{title}</span>
                )}
                <small>
                  {item.scope === "industry" ? "行业级新闻" : "成分股新闻"} ·{" "}
                  {dailyFocusSourceKind(item.sourceKind)} ·{" "}
                  {asString(item.source) ?? "来源未留存"} ·{" "}
                  {asString(item.publishedAt)
                    ? formatDateTime(asString(item.publishedAt)!)
                    : "时间未留存"}
                  {!url && " · 原链接未留存"}
                </small>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          当日数据窗口内没有该行业的可核验新闻，行业新闻确认记 0 分。
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        行业新闻只读取新闻与公告来源，论坛讨论不计入；条数与方向合计最多 2 分。
      </p>
    </div>
  );
}

function DailyFocusCandidate({
  item,
  outcome,
  frozen,
}: {
  item: DailyCandidateEntryResponse;
  outcome: DailyCandidateOutcomeResponse | null;
  frozen: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const snapshot = asRecord(item.snapshot);
  const focusType = asString(snapshot.focusType);
  const lane = asString(snapshot.lane);
  const researchScore2W = asNumber(snapshot.researchScore2W);
  const hotScore = asNumber(snapshot.hotScore);
  const repeatPenalty = asNumber(snapshot.repeatPenalty);
  const continuationBonus = asNumber(snapshot.continuationBonus);
  const primaryEvent = asRecord(snapshot.primaryEvent);
  const v7ScoreRows = dailyFocusV7ScoreRows(snapshot);
  const name = asString(snapshot.name) ?? item.code;
  const amount = asNumber(snapshot.amount);
  const pctChange = asNumber(snapshot.pctChange);
  const textDirection = asNumber(snapshot.textDirection);
  const discussion = asNumber(snapshot.discussionCount);
  const interactions = asNumber(snapshot.discussionInteractions);
  const discussionGrowth = asRecord(snapshot.discussionGrowth);
  const mentionDelta = asNumber(discussionGrowth.mentionDelta);
  const growth = asNumber(discussionGrowth.value);
  const industry = asRecord(snapshot.industry);
  const industryName = asString(industry.name);
  const industryNewsSignal = industryNewsSignalOf(snapshot);
  const industryNewsEvidence = Array.isArray(snapshot.industryNewsEvidence)
    ? snapshot.industryNewsEvidence.map(asRecord)
    : null;
  const history = Array.isArray(snapshot.amountHistory)
    ? snapshot.amountHistory.flatMap((value) => asNumber(value) ?? [])
    : [];
  const discussionHistory = Array.isArray(snapshot.discussionHistory)
    ? snapshot.discussionHistory.map(asRecord)
    : [];
  const discussionBaseline = discussionBaselineMedian(
    discussionGrowth,
    discussionHistory,
  );
  const evidence = Array.isArray(snapshot.events)
    ? snapshot.events.map(asRecord)
    : [];
  const amountTrend =
    history.length >= 2 && history[0]
      ? (history.at(-1)! / history[0] - 1) * 100
      : null;
  const nextTrend = item.nextDayTrend;
  const leader = dailyFocusLeadership(snapshot);
  const nextActual = nextTrend.actual;
  const nextTrendText = nextActual
    ? `${nextActual.phase === "closed" ? "收盘" : "盘中"}${nextActual.status === "matched" ? "符合" : nextActual.status === "missed" ? "不符合" : "持平"} ${changeLabel(nextActual.pctChange)}`
    : `${nextTrend.targetTradeDate ?? "下一交易日"} 待验证`;
  const outcomeText =
    outcome?.status === "completed"
      ? `T+3 ${outcome.marketExcess === null ? "已完成" : `超额 ${changeLabel(outcome.marketExcess * 100)}`}`
      : outcome?.status === "unavailable"
        ? "T+3 不可用"
        : outcome?.status === "observing"
          ? "T+3 观察中"
          : frozen
            ? "T+3 待结算"
            : "T+3 非前视";
  const auditId = `daily-focus-${item.code}`;
  return (
    <article className="daily-focus-candidate">
      <div className="daily-focus-row">
        <Link to={`/stocks/${item.code}`} className="daily-focus-stock">
          <span className="daily-focus-rank">
            {String(item.rank).padStart(2, "0")}
          </span>
          <span>
            <span className="daily-focus-name">
              <strong>{name}</strong>
              {leader ? (
                <em
                  className={cn(
                    "daily-focus-leader",
                    leader.tier === "market" && "is-market",
                  )}
                  title={leader.reasons.join("；") || leader.label}
                >
                  {leader.label}
                </em>
              ) : null}
            </span>
            <small>
              {item.code} ·{" "}
              {dailyFocusBoardLabel(item.code) ?? "板块未识别"} ·{" "}
              {dailyFocusIndustryLabel(industryName, item.isHotIndustry)}
            </small>
            {focusType ? (
              <small>
                {dailyFocusFocusTypeLabel(focusType) ?? focusType}
                {dailyFocusLaneLabel(lane) ? ` · ${dailyFocusLaneLabel(lane)}` : ""}
                {snapshot.focusReasonChanged === true ? " · 理由有变化" : ""}
              </small>
            ) : null}
            <small>
              {item.reasons.slice(0, 3).join(" · ") || "筛选理由未留存"}
            </small>
          </span>
        </Link>
        <span
          className={cn(
            "daily-focus-grade",
            item.grade === "A"
              ? "daily-focus-grade--a"
              : "daily-focus-grade--b",
          )}
        >
          {dailyFocusCandidateStrength(item.grade)}
        </span>
        <strong className="daily-focus-score">
          {item.finalScore.toFixed(1)}
          <small>
            {researchScore2W !== null && hotScore !== null
              ? `研究 ${researchScore2W.toFixed(1)} · 热度 ${hotScore.toFixed(1)}`
              : dailyFocusScoreBreakdown(item)}
          </small>
        </strong>
        <span className="daily-focus-signal">
          <b>{textDirection ?? "—"}</b>
          <small>
            情绪方向 · 讨论 {discussion ?? "—"}
            {mentionDelta === null
              ? ""
              : ` · 增量 ${mentionDelta >= 0 ? "+" : ""}${mentionDelta}`}
          </small>
          <small>
            行业舆情{" "}
            {industryNewsEvidence === null
              ? "未留存"
              : industryNewsEvidence.length
                ? `${industryNewsEvidence.length} 条`
                : "无行业新闻"}
          </small>
        </span>
        <span className="daily-focus-market">
          <b
            className={
              pctChange === null ? "" : pctChange >= 0 ? "text-up" : "text-down"
            }
          >
            {pctChange === null ? "—" : changeLabel(pctChange)}
          </b>
          <small>
            {amount === null
              ? "成交额未留存"
              : `成交 ${(amount / 1e8).toFixed(2)}亿`}
            {amountTrend === null
              ? " · 5日不足"
              : ` · 5日 ${changeLabel(amountTrend)}`}
          </small>
          <small
            className={cn(
              nextActual?.status === "matched"
                ? "!text-up"
                : nextActual?.status === "missed"
                  ? "!text-down"
                  : "",
            )}
          >
            T+1 {nextTrend.label} · {nextTrendText}
          </small>
        </span>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={auditId}
          onClick={() => setExpanded((value) => !value)}
          className="daily-focus-expand"
        >
          <span>{outcomeText}</span>
          {expanded ? "收起" : "审计"}
          <ChevronDown
            size={15}
            className={cn("transition-transform", expanded && "rotate-180")}
          />
        </button>
      </div>
      <div
        id={auditId}
        className={cn(
          "daily-focus-detail",
          expanded && "daily-focus-detail--open",
        )}
      >
        <div className="daily-focus-detail-inner">
          <section>
            <p className="daily-focus-kicker">筛选门槛</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              沪深常规股票、上市满 30 个交易日、非
              ST/退市、可用成交额与完整行情；评分输入冻结于当日特征截点。
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              入选理由：{item.reasons.join(" · ") || "未留存"}
            </p>
          </section>
          <section>
            <p className="daily-focus-kicker">
              {v7ScoreRows ? "V7 双目标评分 / 风险调整" : "六维分项 / 风险调整"}
            </p>
            {v7ScoreRows ? (
              <dl className="daily-focus-score-grid">
                {v7ScoreRows.map((row) => (
                  <div key={row.label} title={row.detail}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <dl className="daily-focus-score-grid">
                {scoreRows(item.scores).map(([label, score]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{score.toFixed(1)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              {v7ScoreRows
                ? v7ScoreRows
                    .map((row) => `${row.label} ${row.value}`)
                    .join(" · ")
                : `旧版基础分 ${item.baseScore.toFixed(1)}`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {researchScore2W !== null && hotScore !== null
                ? `研究 ${researchScore2W.toFixed(1)} × 80% + 热度 ${hotScore.toFixed(1)} × 20%`
                : `基础 ${item.baseScore.toFixed(1)}`}
              {" · "}
              持续确认 +{(continuationBonus ?? 0).toFixed(1)}
              {" · "}
              重复扣分 −{(repeatPenalty ?? 0).toFixed(1)}
              {" · "}
              过热扣分 −{item.overheatPenalty.toFixed(1)}
              {" = "}
              {item.finalScore.toFixed(1)}
            </p>
            {asString(primaryEvent.title) ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {lane === "event" || lane === "dual"
                  ? `核心事件（重要度 ${asNumber(primaryEvent.importance) ?? "—"} · 新鲜度 ${asNumber(primaryEvent.novelty) ?? "—"}）：${asString(primaryEvent.title)}`
                  : `当日公告未达事件门槛（重要度 ${asNumber(primaryEvent.importance) ?? "—"}），仅作证据保留：${asString(primaryEvent.title)}`}
              </p>
            ) : null}
            {industryName && industryNewsSignal !== undefined && (
              <p className="mt-1 text-xs text-muted-foreground">
                行业共振 {(item.scores.industry ?? 0).toFixed(1)} / 12：其中行业新闻确认{" "}
                {industryNewsScore(industryNewsSignal).toFixed(1)} 分（条数 1 分 + 方向 1 分）。
              </p>
            )}
          </section>
          <section>
            <p className="daily-focus-kicker">冻结原始输入</p>
            <RawSnapshot snapshot={snapshot} industry={industry} />
          </section>
          <section>
            <p className="daily-focus-kicker">
              行业舆情{industryName ? ` · ${industryName}` : ""}
            </p>
            <IndustryNewsAngle
              industryName={industryName}
              relation={asString(industry.relation)}
              textHeat={asNumber(industry.textHeat)}
              signal={industryNewsSignal}
              evidence={industryNewsEvidence}
            />
          </section>
          <section>
            <p className="daily-focus-kicker">5 日成交额</p>
            <AmountTrendChart
              values={history.map((amountValue, index) => ({
                label: `T-${history.length - index - 1}`,
                amount: amountValue,
              }))}
            />
            {amount !== null && (
              <p className="mt-2 text-xs text-muted-foreground">
                当日成交额 {(amount / 1e8).toFixed(2)} 亿
              </p>
            )}
          </section>
          <section>
            <p className="daily-focus-kicker">讨论基线</p>
            <DiscussionBaseline
              current={discussion}
              interactions={interactions}
              mentionDelta={mentionDelta}
              growth={growth}
              baseline={discussionBaseline}
              history={discussionHistory}
            />
          </section>
          <section>
            <p className="daily-focus-kicker">龙头数据（涨停池 / 龙虎榜）</p>
            <LeadershipAudit snapshot={snapshot} />
          </section>
          <section>
            <p className="daily-focus-kicker">来源证据</p>
            <EvidenceLinks evidence={evidence} />
          </section>
          <section>
            <p className="daily-focus-kicker">下一交易日趋势</p>
            <NextDayTrendAudit trend={nextTrend} />
          </section>
          <section>
            <p className="daily-focus-kicker">T+3 跟踪</p>
            <OutcomeAudit outcome={outcome} frozen={frozen} />
          </section>
        </div>
      </div>
    </article>
  );
}

/** 龙头依据：只陈述涨停池/龙虎榜的可核验事实，未取证时明确说明而不是留空。 */
function LeadershipAudit({ snapshot }: { snapshot: Record<string, unknown> }) {
  const leadership = dailyFocusLeadership(snapshot);
  const raw = asRecord(snapshot.leadership);
  const boardCount = asNumber(raw.boardCount);
  const dragonTiger = asRecord(raw.dragonTiger);
  const netAmount = asNumber(dragonTiger.netAmount);
  if (!Object.keys(raw).length)
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        当日涨停池与龙虎榜未取证，本次不加龙头分；这不代表该股不是龙头。
      </p>
    );
  return (
    <dl className="daily-focus-baseline">
      <div>
        <dt>龙头判定</dt>
        <dd className={cn(leadership && "text-up")}>
          {leadership ? leadership.label : "未达龙头标准"}
        </dd>
      </div>
      <div>
        <dt>连板高度</dt>
        <dd>{boardCount === null ? "当日未涨停" : `${boardCount} 板`}</dd>
      </div>
      <div>
        <dt>首次封板</dt>
        <dd>{asString(raw.firstSealTime) ?? "—"}</dd>
      </div>
      <div>
        <dt>炸板次数</dt>
        <dd>{asNumber(raw.breakCount) ?? "—"}</dd>
      </div>
      <div>
        <dt>行业涨停家数</dt>
        <dd>{asNumber(raw.industryLimitUps) ?? "—"}</dd>
      </div>
      <div>
        <dt>龙虎榜净买</dt>
        <dd>
          {netAmount === null
            ? "未上榜"
            : `${netAmount >= 0 ? "+" : "-"}${(Math.abs(netAmount) / 1e4).toFixed(0)} 万元`}
        </dd>
      </div>
      {leadership ? (
        <div>
          <dt>龙头加分</dt>
          <dd className="text-up">+{leadership.bonus.toFixed(1)}</dd>
        </div>
      ) : null}
      <p>
        {leadership?.reasons.length
          ? `依据：${leadership.reasons.join("；")}。首板不标龙头；加分只使用当日可核验的涨停与龙虎榜事实。`
          : "首板不标龙头；加分只使用当日可核验的涨停与龙虎榜事实。"}
      </p>
    </dl>
  );
}

function NextDayTrendAudit({
  trend,
}: {
  trend: DailyCandidateEntryResponse["nextDayTrend"];
}) {
  const actual = trend.actual;
  return (
    <dl className="daily-focus-baseline">
      <div>
        <dt>趋势判断</dt>
        <dd className="text-up">{trend.label}</dd>
      </div>
      <div>
        <dt>信号分</dt>
        <dd>{trend.signalScore.toFixed(1)}</dd>
      </div>
      <div>
        <dt>验证日期</dt>
        <dd>{trend.targetTradeDate ?? "待确认"}</dd>
      </div>
      <div>
        <dt>实际涨跌</dt>
        <dd
          className={
            actual ? (actual.pctChange >= 0 ? "text-up" : "text-down") : ""
          }
        >
          {actual ? changeLabel(actual.pctChange) : "待验证"}
        </dd>
      </div>
      <div>
        <dt>符合趋势</dt>
        <dd>
          {actual
            ? actual.status === "matched"
              ? "符合"
              : actual.status === "missed"
                ? "不符合"
                : "持平"
            : "—"}
        </dd>
      </div>
      <div>
        <dt>验证阶段</dt>
        <dd>
          {actual ? (actual.phase === "closed" ? "收盘" : "盘中") : "未开始"}
        </dd>
      </div>
      <p>
        判断只使用候选日特征；信号分表示相对强弱，不是上涨概率。盘中结果会随行情更新，收盘后定稿。
      </p>
    </dl>
  );
}

function OutcomeAudit({
  outcome,
  frozen,
}: {
  outcome: DailyCandidateOutcomeResponse | null;
  frozen: boolean;
}) {
  if (!outcome)
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        {frozen
          ? "已冻结前视候选：等待 T+1 开盘至 T+3 收盘的有效行情结算。"
          : "该记录不属于可计入表现的前视冻结样本。"}
      </p>
    );
  if (outcome.status === "observing")
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        观察中 · {outcome.reason ?? "等待 T+3"}
      </p>
    );
  if (outcome.status === "unavailable")
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        不可用 · {outcome.reason ?? "结算数据不足"}
        {outcome.coverage !== null
          ? `（基准覆盖 ${(outcome.coverage * 100).toFixed(0)}%）`
          : ""}
      </p>
    );
  return (
    <dl className="daily-focus-baseline">
      <div>
        <dt>个股收益</dt>
        <dd
          className={
            outcome.stockReturn !== null && outcome.stockReturn >= 0
              ? "text-up"
              : "text-down"
          }
        >
          {outcome.stockReturn === null
            ? "—"
            : changeLabel(outcome.stockReturn * 100)}
        </dd>
      </div>
      <div>
        <dt>市场超额</dt>
        <dd
          className={
            outcome.marketExcess !== null && outcome.marketExcess >= 0
              ? "text-up"
              : "text-down"
          }
        >
          {outcome.marketExcess === null
            ? "—"
            : changeLabel(outcome.marketExcess * 100)}
        </dd>
      </div>
      <div>
        <dt>最大不利</dt>
        <dd>
          {outcome.maxAdverse === null
            ? "—"
            : changeLabel(outcome.maxAdverse * 100)}
        </dd>
      </div>
      <p>
        {outcome.entryTradeDate ?? "—"} 开盘至 {outcome.exitTradeDate ?? "—"}{" "}
        收盘
      </p>
    </dl>
  );
}

function RawSnapshot({
  snapshot,
  industry,
}: {
  snapshot: Record<string, unknown>;
  industry: Record<string, unknown>;
}) {
  const fields: Array<[string, number | null]> = [
    ["开", asNumber(snapshot.open)],
    ["高", asNumber(snapshot.high)],
    ["低", asNumber(snapshot.low)],
    ["收", asNumber(snapshot.close)],
    ["情绪方向", asNumber(snapshot.textDirection)],
    ["文本置信", asNumber(snapshot.textConfidence)],
  ];
  return (
    <dl className="daily-focus-baseline">
      {fields.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>
            {value === null ? "—" : value.toFixed(label.length === 1 ? 2 : 0)}
          </dd>
        </div>
      ))}
      <p>
        行业：{asString(industry.name) ?? "未分类"} ·{" "}
        {asString(industry.relation) ?? "关系未留存"}
      </p>
    </dl>
  );
}

function DiscussionBaseline({
  current,
  interactions,
  mentionDelta,
  growth,
  baseline,
  history,
}: {
  current: number | null;
  interactions: number | null;
  mentionDelta: number | null;
  growth: number | null;
  baseline: number | null;
  history: Record<string, unknown>[];
}) {
  const verified = history.filter((item) => item.verified === true);
  return (
    <dl className="daily-focus-baseline">
      <div>
        <dt>当前讨论</dt>
        <dd>{current ?? "—"}</dd>
      </div>
      <div>
        <dt>有效基线</dt>
        <dd>{baseline === null ? "未验证" : baseline.toFixed(1)}</dd>
      </div>
      <div>
        <dt>提及增量</dt>
        <dd>
          {mentionDelta === null
            ? "未验证"
            : `${mentionDelta >= 0 ? "+" : ""}${mentionDelta}`}
        </dd>
      </div>
      <div>
        <dt>讨论增长</dt>
        <dd>{growth === null ? "未验证" : growth.toFixed(2)}</dd>
      </div>
      <div>
        <dt>互动量</dt>
        <dd>{interactions ?? "—"}</dd>
      </div>
      <p>
        {verified.length
          ? `${verified.length}/${history.length} 个可验证历史窗口`
          : "无可验证历史窗口，不把缺失数据当作零"}
      </p>
    </dl>
  );
}

function EvidenceLinks({ evidence }: { evidence: Record<string, unknown>[] }) {
  if (!evidence.length)
    return (
      <p className="text-xs text-muted-foreground">未留存可归属的来源证据。</p>
    );
  return (
    <ul className="daily-focus-evidence">
      {evidence.slice(0, 5).map((item, index) => {
        const source = asString(item.source) ?? "未知来源";
        const url = asString(item.url);
        return (
          <li key={`${asString(item.id) ?? source}-${index}`}>
            {url ? (
              <a href={url} target="_blank" rel="noreferrer">
                {source}
                <ExternalLink size={12} />
              </a>
            ) : (
              <span>{source}</span>
            )}
            <small>
              {dailyFocusSourceKind(item.sourceKind)} ·{" "}
              {asString(item.publishedAt)
                ? formatDateTime(asString(item.publishedAt)!)
                : "时间未留存"}
              {!url && " · 原链接未留存"}
            </small>
          </li>
        );
      })}
    </ul>
  );
}

function PerformanceStrip({
  performance,
  windowDays,
  onWindowChange,
}: {
  performance: DailyCandidatePerformanceResponse | null;
  windowDays: 20 | 60;
  onWindowChange: (window: 20 | 60) => void;
}) {
  const percent = (value: number | null) =>
    value === null ? "样本不足" : changeLabel(value * 100);
  return (
    <section
      className="daily-focus-performance"
      aria-labelledby="daily-focus-performance-title"
    >
      <div className="daily-focus-section-head">
        <div>
          <h2 id="daily-focus-performance-title">历史表现</h2>
        </div>
        <Tabs
          value={String(windowDays)}
          onValueChange={(value) => onWindowChange(Number(value) as 20 | 60)}
        >
          <TabsList className="h-11">
            <TabsTrigger value="20" className="text-xs">
              20 日
            </TabsTrigger>
            <TabsTrigger value="60" className="text-xs">
              60 日
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {performance ? (
        <>
          <div className="daily-focus-performance-grid">
            <AuditMetric
              label="样本交易日"
              value={`${performance.sampleDays} · ${dailyFocusPhase(performance.sampleStage)}`}
            />
            <AuditMetric
              label="平均超额"
              value={percent(performance.averageMarketExcess)}
            />
            <AuditMetric
              label={`净平均超额（成本 ${performance.costBps}bp）`}
              value={percent(performance.netAverageMarketExcess)}
            />
            <AuditMetric
              label="中位数超额"
              value={percent(performance.medianMarketExcess)}
            />
            <AuditMetric
              label="胜率"
              value={
                performance.hitRate === null
                  ? "样本不足"
                  : `${(performance.hitRate * 100).toFixed(1)}%`
              }
            />
            <AuditMetric
              label="日等权超额"
              value={percent(performance.dailyEqualWeightMarketExcess)}
            />
          </div>
          <div className="daily-focus-groups">
            <span>
              按入选强度：强信号 {percent(performance.groups.A)} · 达标信号{" "}
              {percent(performance.groups.B)} · 热门行业{" "}
              {percent(performance.groups.hotIndustry)} · 非热门行业{" "}
              {percent(performance.groups.nonHotIndustry)}
            </span>
            <span>
              {performance.confidenceInterval
                ? `95% 置信区间 ${percent(performance.confidenceInterval.low)} 至 ${percent(performance.confidenceInterval.high)}（${performance.confidenceInterval.blockDays} 日块）`
                : "置信区间需至少 60 个冻结交易日"}
            </span>
          </div>
        </>
      ) : (
        <LoadingState label="正在读取历史表现" />
      )}
    </section>
  );
}

const SCORE_HINTS: Partial<Record<SortBaseKey, string>> = {
  direction:
    "情绪方向以 50 为中性，只读取已关联线索的情绪方向，不读取当日涨跌幅。价情共振分另行描述价格是否配合。",
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

function PctChangeCell({ stock }: { stock: StockSnapshot }) {
  const history = stock.returnHistory ?? [];
  const cumulative = history.reduce(
    (value, point) =>
      (1 + value / 100) * (1 + point.pctChange / 100) * 100 - 100,
    0,
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex cursor-help flex-col items-center gap-0.5">
          <strong
            className={cn(
              "font-semibold tabular",
              stock.pctChange >= 0 ? "text-up" : "text-down",
            )}
          >
            {changeLabel(stock.pctChange)}
          </strong>
          {history.length >= 2 ? (
            <span className="w-[88px]">
              <ReturnTrendSparkline history={history} />
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground">历史不足</span>
          )}
          {stock.changeRank != null && (
            <span className="text-[10px] leading-none text-muted-foreground tabular">
              {stock.pctChange >= 0 ? "涨幅" : "跌幅"}第{stock.changeRank}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-w-[300px] text-xs leading-relaxed"
      >
        <p className="font-medium">近一月涨幅轨迹</p>
        {history.length >= 2 ? (
          <>
            <p className="mt-1 text-muted-foreground">
              实线为最近 {history.length} 个交易日按日涨跌幅复利计算的累计涨幅：
              <span
                className={cn(
                  "ml-1 font-medium tabular",
                  cumulative >= 0 ? "text-up" : "text-down",
                )}
              >
                {changeLabel(cumulative)}
              </span>
              。
            </p>
            <p className="mt-1 text-muted-foreground">
              虚线为这段历史涨幅的线性统计延长线，仅用于观察既有斜率，不是未来价格预测或投资建议。
            </p>
          </>
        ) : (
          <p className="mt-1 text-muted-foreground">
            本地数据库的历史交易日不足，暂不绘制趋势线。
          </p>
        )}
      </TooltipContent>
    </Tooltip>
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

function IndustryCell({
  stock,
  compact = false,
}: {
  stock: StockSnapshot;
  compact?: boolean;
}) {
  const industry = stock.industry;
  const pulse = stock.industryPulse;
  const attribution = stock.industryAttribution;
  if (!industry) {
    return (
      <span
        className="text-xs text-muted-foreground"
        title="当前行情快照没有保存行业归属，系统不会用今天的分类回填历史。"
      >
        行业未分类
      </span>
    );
  }

  const relationClass =
    pulse?.relation === "舆情交易双热"
      ? "border-up/30 bg-up-soft text-up"
      : pulse?.relation === "舆情升温、价格未确认"
        ? "border-warning/40 bg-warning-soft text-warning"
        : pulse?.relation === "交易驱动"
          ? "border-border bg-muted text-muted-foreground"
          : "border-border text-muted-foreground";
  const attributionLabel = attribution
    ? `行业同行部分 ${attribution.industryPart >= 0 ? "+" : ""}${attribution.industryPart.toFixed(2)}个百分点；个股相对行业 ${attribution.stockSpecificPart >= 0 ? "+" : ""}${attribution.stockSpecificPart.toFixed(2)}个百分点`
    : "当前暂无行业收益归因";

  return (
    <div
      className={cn("min-w-0", compact ? "space-y-1" : "space-y-1.5")}
      title={`${industry.name} · ${pulse?.relation ?? "行业信息已保存"} · ${attributionLabel}`}
      aria-label={`${industry.name}${pulse ? `，${pulse.relation}` : ""}`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-xs font-medium">
          {industry.name}
        </span>
        {pulse && (
          <span
            className={cn(
              "shrink-0 rounded border px-1 py-0.5 text-[10px] leading-none",
              relationClass,
            )}
          >
            {pulse.relation === "舆情交易双热"
              ? "双热"
              : pulse.relation === "舆情升温、价格未确认"
                ? "舆情热"
                : pulse.relation === "交易驱动"
                  ? "行情热"
                  : "常态"}
          </span>
        )}
      </div>
      {pulse ? (
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground tabular">
          <span>舆情 {pulse.textHeat}</span>
          <span>行情 {pulse.marketStrength}</span>
          {!compact && <span className="truncate">{pulse.stage}</span>}
        </div>
      ) : (
        <span className="block text-[10px] text-muted-foreground">
          行业热度待聚合
        </span>
      )}
    </div>
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
      <TableCell className="px-2 py-2">
        <IndustryCell stock={stock} />
      </TableCell>
      <TableCell className="w-[92px] px-1 py-2 text-center">
        <SparklineCell stock={stock} />
      </TableCell>
      <TableCell className="px-1 py-2 text-center">
        <AlertScoreCell stock={stock} />
      </TableCell>
      <TableCell className="px-1 py-2 text-center">
        <DirectionScore score={stock.textDirectionScore ?? null} />
      </TableCell>
      <TableCell className="px-1 py-2 text-center">
        <MetricBar value={stock.factors.attention} />
      </TableCell>
      <TableCell className="px-1 py-2 text-center tabular">
        {stock.mentionCount}
      </TableCell>
      <TableCell className="px-1 py-2 text-center">
        <PctChangeCell stock={stock} />
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
        <PctChangeCell stock={stock} />
      </div>
      {stock.moverTags?.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {stock.moverTags.map((tag) => (
            <MoverTagBadge key={tag} tag={tag} />
          ))}
        </div>
      ) : null}
      <div className="mt-3 border-t pt-3">
        <IndustryCell stock={stock} compact />
      </div>
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
            <dt className="text-[10px] text-muted-foreground">情绪方向</dt>
            <dd className="text-sm font-semibold tabular">
              {stock.textDirectionScore ?? "—"}
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

function MetricBar({ value }: { value: number }) {
  return value ? (
    <span className="inline-grid grid-cols-[34px_20px] items-center gap-1">
      <i className="h-[3px] overflow-hidden rounded-full bg-muted">
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
