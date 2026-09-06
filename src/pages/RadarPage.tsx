import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, ChevronRight, CircleAlert, Radio, RotateCcw, Star } from "lucide-react";
import { Link } from "react-router-dom";
import type { ClueCategory, DashboardData, SentimentEvent } from "../domain/types";
import { api } from "../lib/api";
import { changeLabel, formatDateTime, formatNumber } from "../lib/format";
import { MoodFlowChart, ScoreDial, Sparkline, ToneBadge } from "../components/Visuals";
import { LoadingState } from "@/components/LoadingState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export function RadarPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [visibleEvents, setVisibleEvents] = useState(80);
  const [categoryFilter, setCategoryFilter] = useState<"全部线索" | ClueCategory>("全部线索");
  const requestController = useRef<AbortController | null>(null);

  const load = () => {
    requestController.current?.abort();
    requestController.current = new AbortController();
    api.dashboard(requestController.current.signal)
      .then((payload) => {
        setData(payload);
        setError("");
        setSelectedId((current) => payload.events.some((event) => event.id === current) ? current : payload.events[0]?.id || "");
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "无法读取实时舆情雷达");
      });
  };

  useEffect(() => {
    load();
    const interval = window.setInterval(load, 60_000);
    return () => { requestController.current?.abort(); window.clearInterval(interval); };
  }, []);

  const filteredEvents = useMemo(() => data?.events.filter((event) => categoryFilter === "全部线索" || event.category === categoryFilter) ?? [], [data, categoryFilter]);
  const selectedEvent = useMemo(() => filteredEvents.find((event) => event.id === selectedId) ?? filteredEvents[0], [filteredEvents, selectedId]);
  const selectCategory = (category: "全部线索" | ClueCategory) => {
    setCategoryFilter(category);
    setVisibleEvents(80);
    const next = category === "全部线索" ? data?.events[0] : data?.events.find((event) => event.category === category);
    setSelectedId(next?.id ?? "");
  };

  if (error && !data) return <PageError message={error} onRetry={load} />;
  if (!data) return <RadarSkeleton />;

  return (
    <div className="flex flex-col gap-5">
      {error && <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning-soft px-4 py-2.5 text-sm text-foreground"><CircleAlert size={16} className="text-warning" /><span>自动更新暂时失败，当前仍显示上次成功数据：{error}</span></div>}

      <header className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">实时舆情 · {formatDateTime(data.asOf)} · 每分钟自动更新</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">让所有线索，汇成一张图。</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">持续聚合所有已配置来源，把每条真实线索关联到全市场股票，再优先呈现自选股变化。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Badge variant="outline" className={cn("gap-1.5 border-transparent", data.dataMode === "live" ? "bg-down-soft text-down" : "bg-warning-soft text-warning")}>
            <i className={cn("size-1.5 rounded-full", data.dataMode === "live" ? "bg-down" : "bg-warning")} />
            {data.dataMode === "live" ? "实时数据完整" : "实时数据部分可用"}
          </Badge>
          <Button asChild size="sm"><Link to="/watchlist"><Star />管理自选股</Link></Button>
          <Button asChild variant="outline" size="sm"><Link to="/screener">查看全市场 <ArrowRight /></Link></Button>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-label="实时覆盖情况">
        {[
          ["全市场股票", formatNumber(data.universeTotal), "实时股票池"],
          ["已关联股票", formatNumber(data.analyzedStocks), "当前窗口存在有效线索"],
          ["已聚合线索", formatNumber(data.totalMentions), "去重后的全部来源线索"],
          ["有效来源", data.sourceCount, "当前成功返回的来源"],
        ].map(([label, value, hint]) => (
          <Card key={label} className="gap-2 py-4">
            <CardContent className="px-5">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-2 text-3xl font-semibold tabular">{value}</p>
              <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <Card>
          <CardContent className="px-6 py-6">
            <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center">
              <ScoreDial score={data.moodIndex} />
              <div className="w-full min-w-0 sm:w-auto">
                <p className="text-xs text-muted-foreground">股票覆盖率 <strong className="tabular text-foreground">{data.breadth}%</strong></p>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{data.dataMessage}。情绪指数只描述当前已关联线索，不代表全市场未来方向。</p>
                <dl className="mt-5 grid grid-cols-3 gap-4 border-t pt-4">
                  <div><dt className="text-xs text-muted-foreground">覆盖广度</dt><dd className="mt-1 text-xl font-semibold tabular">{data.breadth}<span className="text-sm">%</span></dd></div>
                  <div><dt className="text-xs text-muted-foreground">观点分歧</dt><dd className="mt-1 text-xl font-semibold tabular">{data.divergence}<span className="text-sm">%</span></dd></div>
                  <div><dt className="text-xs text-muted-foreground">自选数量</dt><dd className="mt-1 text-xl font-semibold tabular">{data.watchlist.length}</dd></div>
                </dl>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="grid-cols-[1fr_auto] grid-rows-1 items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">二十四小时舆情流</p>
              <CardTitle className="mt-1 text-lg">情绪潮位</CardTitle>
            </div>
            <p className="hidden text-xs text-muted-foreground sm:block">按真实线索发布时间聚合正面与负面声量。</p>
          </CardHeader>
          <CardContent className="px-6 pb-6">
            <MoodFlowChart points={data.moodSeries} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="grid-cols-[1fr_auto] grid-rows-1 items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">正在升温</p>
            <CardTitle className="mt-1 text-lg">主题脉冲</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="px-2 pb-4 sm:px-4">
          {data.themes.length ? (
            <div className="grid gap-px overflow-x-auto sm:grid-cols-2 lg:grid-cols-4">
              {data.themes.map((theme, index) => (
                <div className="flex min-w-[240px] items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-muted/60" key={theme.name}>
                  <span className="font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{theme.name}</p>
                    <p className="text-xs text-muted-foreground">{formatNumber(theme.mentions)} 条关联线索</p>
                  </div>
                  <div className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-muted sm:block">
                    <i className="block h-full rounded-full bg-up" style={{ transform: `scaleX(${theme.heat / 100})` }} />
                  </div>
                  <span className={cn("text-sm font-semibold tabular", theme.change >= 0 ? "text-up" : "text-down")}>{changeLabel(theme.change, "")}</span>
                </div>
              ))}
            </div>
          ) : <p className="px-4 py-6 text-sm text-muted-foreground">当前线索尚未形成稳定主题。</p>}
        </CardContent>
      </Card>

      {data.hotIndustries?.length ? (
        <Card>
          <CardHeader className="grid-cols-[1fr_auto] grid-rows-1 items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">行业信息分类</p>
              <CardTitle className="mt-1 text-lg">当前热点行业</CardTitle>
            </div>
            <p className="hidden text-xs text-muted-foreground sm:block">舆情热度与行情强度分开计算，再展示两者关系。</p>
          </CardHeader>
          <CardContent className="px-4 pb-5 sm:px-6">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {data.hotIndustries.slice(0, 8).map((industry) => {
                const relationTone = industry.relation === "舆情交易双热" ? "border-up/30 bg-up-soft" : industry.relation === "舆情升温、价格未确认" ? "border-warning/30 bg-warning-soft" : industry.relation === "交易驱动" ? "border-primary/20 bg-accent" : "border-border bg-card";
                return (
                  <Link
                    key={industry.profile.code}
                    to={`/screener?industry=${encodeURIComponent(industry.profile.code)}`}
                    className={cn("rounded-lg border p-4 transition-colors hover:border-primary/40 hover:bg-accent/60", relationTone)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{industry.profile.name}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">{industry.stage} · {industry.driver}</p>
                      </div>
                      <span className="shrink-0 rounded-full border bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">{industry.relation}</span>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-[11px] text-muted-foreground">舆情热度</p>
                        <p className="mt-1 text-xl font-semibold tabular">{industry.textHeat}</p>
                        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-background/80"><i className="block h-full rounded-full bg-primary" style={{ width: `${industry.textHeat}%` }} /></div>
                      </div>
                      <div>
                        <p className="text-[11px] text-muted-foreground">行情强度</p>
                        <p className={cn("mt-1 text-xl font-semibold tabular", industry.marketStrength >= 60 ? "text-up" : industry.marketStrength <= 40 ? "text-down" : "text-foreground")}>{industry.marketStrength}</p>
                        <p className={cn("mt-1 text-[11px] tabular", industry.industryReturn >= 0 ? "text-up" : "text-down")}>{changeLabel(industry.industryReturn)} · 超额 {changeLabel(industry.marketExcess)}</p>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center justify-between border-t border-current/10 pt-3 text-[11px] text-muted-foreground">
                      <span>{industry.independentEvents} 个独立事件 · {industry.stockCoverage} 只股票</span>
                      <ArrowUpRight size={13} aria-hidden="true" />
                    </div>
                    {industry.informationCategories.length ? <p className="mt-2 truncate text-[11px] text-muted-foreground">信息分类：{industry.informationCategories.join(" · ")}</p> : null}
                  </Link>
                );
              })}
            </div>
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">行业热度只使用新闻、公告和用户讨论等文本线索；行情强度来自行业成分股相对全市场的当日表现。两者同向时标记“舆情交易双热”，这是当前交易日的同期描述，不是历史后验或未来收益预测；历史关系需完成未来5个交易日的样本观察。</p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="grid-cols-[1fr_auto] grid-rows-1 items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">默认优先分析</p>
            <CardTitle className="mt-1 text-lg">我的自选股</CardTitle>
          </div>
          <Button asChild variant="ghost" size="sm"><Link to="/watchlist">增删自选股 <ArrowUpRight /></Link></Button>
        </CardHeader>
        <CardContent className="px-2 pb-4 sm:px-4">
          {data.watchlist.length ? (
            <div className="grid gap-px md:grid-cols-2">
              {data.watchlist.map((stock, index) => (
                <Link to={`/stocks/${stock.code}`} className="grid grid-cols-[26px_1fr_90px_52px_70px_18px] items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-muted/60" key={stock.code}>
                  <span className="font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                  <div className="min-w-0"><p className="truncate text-sm font-medium">{stock.name}</p><p className="truncate text-xs text-muted-foreground">{stock.code} · {stock.market}</p></div>
                  <div className="hidden sm:block"><Sparkline values={stock.sparkline} tone={stock.factors.sentiment >= 0 ? "positive" : "negative"} /></div>
                  <div className="text-right"><p className="text-[10px] text-muted-foreground">异动</p><p className="text-lg font-semibold tabular leading-tight">{stock.alertScore ?? "—"}</p></div>
                  <span className={cn("text-right text-sm font-semibold tabular", stock.pctChange >= 0 ? "text-up" : "text-down")}>{changeLabel(stock.pctChange)}</span>
                  <ChevronRight size={16} className="text-muted-foreground" aria-hidden="true" />
                </Link>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <Star size={22} className="text-muted-foreground" />
              <div><h3 className="text-sm font-medium">还没有自选股</h3><p className="mt-1 text-xs text-muted-foreground">添加自选股后，首页会默认优先展示它们的舆情变化。</p></div>
              <Button asChild size="sm"><Link to="/watchlist">添加自选股</Link></Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="grid-cols-[1fr_auto] grid-rows-1 items-center gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">全部实时线索</p>
            <CardTitle className="mt-1 text-lg">事件雷达</CardTitle>
          </div>
          <p className="hidden text-xs text-muted-foreground lg:block">已获取的线索全部进入聚合；选择事件可核验股票关联与原始来源。</p>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <div className="px-6">
            <Tabs value={categoryFilter} onValueChange={(value) => selectCategory(value as typeof categoryFilter)}>
              <TabsList className="h-auto flex-wrap justify-start gap-1 bg-transparent p-0">
                {(["全部线索", "新闻事件", "公司公告", "用户讨论"] as const).map((category) => {
                  const count = category === "全部线索" ? data.events.length : data.events.filter((event) => event.category === category).length;
                  return (
                    <TabsTrigger value={category} key={category} className="gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                      {category}<span className="text-xs opacity-70">{count}</span>
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </Tabs>
          </div>
          {filteredEvents.length ? (
            <div className="mt-4 grid border-t lg:grid-cols-[1fr_minmax(340px,0.72fr)]">
              <div className="max-h-[560px] overflow-y-auto border-b lg:border-b-0 lg:border-r" aria-label="舆情事件列表">
                {filteredEvents.slice(0, visibleEvents).map((event, index) => (
                  <button
                    type="button"
                    key={event.id}
                    onClick={() => setSelectedId(event.id)}
                    className={cn(
                      "block w-full border-b px-5 py-4 text-left transition-colors last:border-b-0 hover:bg-muted/60",
                      event.id === selectedEvent?.id && "border-l-2 border-l-primary bg-accent",
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <time className="font-mono text-xs text-muted-foreground tabular">{formatDateTime(event.publishedAt).slice(-5)}</time>
                      <ToneBadge tone={event.tone} />
                      <span className="text-xs text-muted-foreground">{event.category} · {event.eventType} · 热度 {event.heat}</span>
                    </div>
                    <h3 className="mt-1.5 truncate text-sm font-medium">{event.title}</h3>
                    <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{event.summary}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {event.relatedStocks.slice(0, 4).map((stock) => (
                        <span key={stock.code} className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">{stock.name} <b className="font-medium text-foreground">{stock.relevance}</b></span>
                      ))}
                    </div>
                  </button>
                ))}
                {visibleEvents < filteredEvents.length && (
                  <div className="flex items-center justify-between gap-3 px-5 py-4">
                    <span className="text-xs text-muted-foreground">已显示 {visibleEvents} / {filteredEvents.length} 条</span>
                    <Button variant="outline" size="sm" onClick={() => setVisibleEvents((count) => Math.min(filteredEvents.length, count + 80))}>继续显示八十条</Button>
                  </div>
                )}
              </div>
              <div className="p-6">{selectedEvent ? <EventDetail event={selectedEvent} /> : <p className="text-sm text-muted-foreground">选择左侧事件查看详情。</p>}</div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 border-t py-12 text-center">
              <Radio size={22} className="text-muted-foreground" />
              <div><h3 className="text-sm font-medium">当前没有可用线索</h3><p className="mt-1 text-xs text-muted-foreground">系统不会用模拟线索填充；请到数据源页检查连接状态。</p></div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EventDetail({ event }: { event: SentimentEvent }) {
  return (
    <article className="flex flex-col gap-4">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{event.category} · {event.eventType}</span>
        <time className="tabular">{formatDateTime(event.publishedAt)}</time>
      </div>
      <div><ToneBadge tone={event.tone} /><h3 className="mt-3 text-lg font-semibold leading-snug">{event.title}</h3></div>
      <p className="text-sm leading-relaxed text-muted-foreground">{event.summary}</p>
      <dl className="grid grid-cols-3 gap-3 border-y py-3">
        <div><dt className="text-xs text-muted-foreground">分析置信</dt><dd className="mt-1 text-lg font-semibold tabular">{event.confidence}</dd></div>
        <div><dt className="text-xs text-muted-foreground">关联股票</dt><dd className="mt-1 text-lg font-semibold tabular">{event.relatedStocks.length}</dd></div>
        <div><dt className="text-xs text-muted-foreground">舆情热度</dt><dd className="mt-1 text-lg font-semibold tabular">{event.heat}</dd></div>
      </dl>
      <div className="flex flex-wrap gap-1.5">{event.topics.map((topic) => <Badge key={topic} variant="secondary">#{topic}</Badge>)}</div>
      <div>
        <h4 className="text-xs font-medium text-muted-foreground">关联股票与理由</h4>
        <div className="mt-2 divide-y rounded-md border">
          {event.relatedStocks.length ? event.relatedStocks.map((stock) => (
            <Link to={`/stocks/${stock.code}`} className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/60" key={stock.code}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{stock.name} <span className="text-xs text-muted-foreground">{stock.code}</span></p>
                <p className="truncate text-xs text-muted-foreground">{stock.reason}</p>
              </div>
              <span className="font-mono text-xs">{stock.relevance}%</span>
            </Link>
          )) : <p className="px-3 py-3 text-xs text-muted-foreground">该条宏观线索暂未直接关联具体股票。</p>}
        </div>
      </div>
      {event.url && <a className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" href={event.url} target="_blank" rel="noreferrer">核验原始来源 <ArrowUpRight size={14} /></a>}
      <div className="flex items-start gap-2 text-xs text-muted-foreground"><i className="mt-1 size-1.5 shrink-0 rounded-full bg-warning" />来源：{event.source}。展示内容为必要摘要，评分可追溯到原始链接。</div>
    </article>
  );
}

function RadarSkeleton() {
  return (
    <div className="flex flex-col gap-5" role="status" aria-label="正在加载实时舆情">
      <div className="flex justify-center py-8"><LoadingState label="正在聚合全市场行情与舆情" /></div>
      <Skeleton className="h-28 w-full max-w-xl" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <Skeleton className="h-28" key={index} />)}</div>
      <div className="grid gap-4 lg:grid-cols-2">{Array.from({ length: 2 }, (_, index) => <Skeleton className="h-72" key={index} />)}</div>
    </div>
  );
}

function PageError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <CircleAlert size={28} className="text-warning" />
      <div><h1 className="text-xl font-semibold">实时舆情暂时不可用</h1><p className="mt-2 max-w-md text-sm text-muted-foreground">{message}</p></div>
      <div className="flex items-center gap-3">
        <Button type="button" onClick={onRetry}><RotateCcw />重新连接真实数据</Button>
        <Button asChild variant="ghost"><Link to="/sources">检查数据源</Link></Button>
      </div>
    </div>
  );
}
