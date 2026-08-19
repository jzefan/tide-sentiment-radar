import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowUpRight, CheckCircle2, CircleAlert, Database, Info, Layers3, Star } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { FactorBars, KlineChart, PriceSentimentChart, ToneBadge } from "../components/Visuals";
import { LoadingState } from "@/components/LoadingState";
import type { ClueCategory, KlinePeriod, KlineResponse, SentimentEvent, StockDetailResponse } from "../domain/types";
import { ApiError, api } from "../lib/api";
import { changeLabel, formatDateTime } from "../lib/format";
import { useWatchlist } from "../lib/useWatchlist";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export function StockPage() {
  const { code = "" } = useParams();
  const [data, setData] = useState<StockDetailResponse | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [eventCategory, setEventCategory] = useState<"全部线索" | ClueCategory>("全部线索");
  const [klinePeriod, setKlinePeriod] = useState<KlinePeriod>("daily");
  const [klineData, setKlineData] = useState<KlineResponse | null>(null);
  const [klineError, setKlineError] = useState("");
  const watchlist = useWatchlist();
  // 必须保持在所有提前 return 之前调用，保证 hooks 数量一致。
  const filteredEvents = useMemo(
    () => (data?.events ?? []).filter((event) => eventCategory === "全部线索" || event.category === eventCategory),
    [data, eventCategory],
  );

  useEffect(() => {
    setData(null);
    setError("");
    setErrorStatus(null);
    let controller: AbortController | null = null;
    const load = () => {
      controller?.abort();
      controller = new AbortController();
      api.stock(code, controller.signal)
        .then((next) => { setData(next); setError(""); setErrorStatus(null); })
        .catch((cause) => {
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          setError(cause instanceof Error ? cause.message : "个股详情读取失败");
          setErrorStatus(cause instanceof ApiError ? cause.status : null);
        });
    };
    void load();
    const interval = window.setInterval(load, 60_000);
    return () => { controller?.abort(); window.clearInterval(interval); };
  }, [code, reloadKey]);

  // 日线复用详情接口的价格历史（含舆情叠加）；分时/周/月独立请求 K 线。
  useEffect(() => {
    if (klinePeriod === "daily") return;
    setKlineData(null);
    setKlineError("");
    let controller: AbortController | null = null;
    const load = () => {
      controller?.abort();
      controller = new AbortController();
      api.kline(code, klinePeriod, controller.signal)
        .then((next) => { setKlineData(next); setKlineError(""); })
        .catch((cause) => {
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          setKlineError(cause instanceof Error ? cause.message : "K线读取失败");
        });
    };
    void load();
    const interval = window.setInterval(load, klinePeriod === "minute" ? 15_000 : 60_000);
    return () => { controller?.abort(); window.clearInterval(interval); };
  }, [code, klinePeriod]);

  if (error && !data) return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <CircleAlert size={28} className="text-warning" />
      <div><h1 className="text-xl font-semibold">{errorStatus === 404 ? "没有找到这只股票" : "个股数据暂时不可用"}</h1><p className="mt-2 max-w-md text-sm text-muted-foreground">{error}</p></div>
      <div className="flex items-center gap-3">
        {errorStatus !== 404 && <Button type="button" onClick={() => setReloadKey((value) => value + 1)}>重新连接</Button>}
        <Button asChild variant="outline"><Link to="/screener"><ArrowLeft />返回全市场</Link></Button>
      </div>
    </div>
  );
  if (!data) return (
    <div className="flex flex-col gap-5" role="status" aria-label="正在加载个股详情">
      <div className="flex justify-center py-8"><LoadingState label="正在加载个股详情与K线" /></div>
      <Skeleton className="h-40" />
      <Skeleton className="h-96" />
    </div>
  );

  const { stock, events, marketSource } = data;
  const selected = watchlist.has(stock.code) || Boolean(stock.isWatchlisted);
  const toggle = async () => {
    try {
      setActionError("");
      await watchlist.toggle(stock.code);
      setData((current) => current ? { ...current, stock: { ...current.stock, isWatchlisted: !selected } } : current);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "自选股更新失败");
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {error && <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning-soft px-4 py-2.5 text-sm"><CircleAlert size={16} className="text-warning" /><span>自动更新暂时失败，当前仍显示上次成功数据：{error}</span></div>}
      <Link to="/screener" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft size={15} />全市场股票池</Link>

      <header className="grid gap-5 border-b pb-5 lg:grid-cols-[1fr_1.1fr_auto] lg:items-end">
        <div>
          <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{stock.market} · {stock.code} · 每分钟自动更新</p>
          <div className="mt-1 flex items-center gap-4">
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">{stock.name}</h1>
            <Button
              type="button"
              variant={selected ? "default" : "outline"}
              size="icon"
              className={cn(selected ? "bg-up text-up-foreground hover:bg-up/90" : "text-muted-foreground")}
              aria-pressed={selected}
              aria-label={`${selected ? "移出" : "加入"}自选股：${stock.name}`}
              onClick={() => void toggle()}
            ><Star fill={selected ? "currentColor" : "none"} /></Button>
          </div>
          <div className="mt-3 flex items-baseline gap-3">
            <strong className="text-2xl font-semibold tabular">{stock.price.toFixed(2)}</strong>
            <span className={cn("text-sm font-semibold tabular", stock.pctChange >= 0 ? "text-up" : "text-down")}>{changeLabel(stock.pctChange)}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">{stock.topics.length ? stock.topics.map((topic) => <Badge key={topic} variant="secondary">#{topic}</Badge>) : <span className="text-xs text-muted-foreground">当前窗口暂未形成主题</span>}</div>
        </div>
        <div>
          <Badge variant="outline" className={cn("border", stock.signal === "偏多共振" && "border-up/30 bg-up-soft text-up", stock.signal === "风险升温" && "border-down/30 bg-down-soft text-down", stock.signal === "高分歧" && "border-warning/30 bg-warning-soft text-warning")}>{stock.signal}</Badge>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{stock.summary}</p>
          {stock.quoteUrl ? (
            <a className="mt-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" href={stock.quoteUrl} target="_blank" rel="noreferrer"><Database size={13} />行情来源：{marketSource} · 每日保存到本地数据库<ArrowUpRight size={12} /></a>
          ) : <div className="mt-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Database size={13} />行情来源：{marketSource}</div>}
        </div>
        <div className="flex items-center gap-6">
          <div className="text-center"><p className="text-xs text-muted-foreground">异动分</p><strong className="mt-1 block text-4xl font-semibold tabular">{stock.alertScore ?? "—"}</strong><em className="mt-1 block text-[11px] not-italic text-muted-foreground">变化强度</em></div>
          <div className="h-16 w-px bg-border" />
          <div className="text-center"><p className="text-xs text-muted-foreground">方向分</p><strong className={cn("mt-1 block text-4xl font-semibold tabular", (stock.radarScore ?? 50) >= 50 ? "text-up" : "text-down")}>{stock.radarScore ?? "—"}</strong><em className="mt-1 block text-[11px] not-italic text-muted-foreground">{stock.radarScore === null ? "等待有效线索" : "50 为中性"}</em></div>
        </div>
      </header>

      {actionError && <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning-soft px-4 py-2.5 text-sm" role="alert"><CircleAlert size={16} className="text-warning" /><span>自选股更新失败：{actionError}</span><button type="button" className="ml-auto text-xs underline underline-offset-4" onClick={() => setActionError("")}>关闭提示</button></div>}

      <Card>
        <CardHeader className="grid-cols-[1fr_auto] grid-rows-1 items-center gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">价格走势与舆情</p>
            <CardTitle className="mt-1 text-lg">K线与舆情回溯</CardTitle>
          </div>
          <Tabs value={klinePeriod} onValueChange={(value) => setKlinePeriod(value as KlinePeriod)} className="min-w-0">
            <TabsList className="h-8">
              {([["minute", "分时"], ["daily", "日线"], ["weekly", "周线"], ["monthly", "月线"]] as const).map(([value, label]) => (
                <TabsTrigger value={value} key={value} className="px-3 text-xs">{label}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="px-4 pb-5 sm:px-6">
          {klinePeriod === "daily" ? (
            <>
              {data.historyState === "stale" && stock.priceHistory.length >= 2 && (
                <div className="mb-3 flex items-center gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs" role="status"><CircleAlert size={14} className="text-warning" /><span>历史日线更新失败，图表为本地缓存，不代表最新交易日。</span></div>
              )}
              {stock.priceHistory.length >= 2 ? (
                <>
                  <PriceSentimentChart prices={stock.priceHistory} sentiments={stock.sentimentTrend} events={events} />
                  {events.length > 0 && (
                    <div className="mt-4 grid grid-cols-1 divide-y rounded-md border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                      {events.slice(0, 3).map((event, index) => (
                        <div key={event.id} className="flex items-start gap-3 px-4 py-3">
                          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-warning text-[10px] font-bold text-card">{index + 1}</span>
                          <div className="min-w-0"><p className="truncate text-xs">{event.title}</p><time className="text-[10px] text-muted-foreground">{formatDateTime(event.publishedAt)}</time></div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-col items-center gap-3 py-14 text-center">
                  <Database size={22} className="text-muted-foreground" />
                  <div><h3 className="text-sm font-medium">历史价格暂不可用</h3><p className="mt-1 text-xs text-muted-foreground">{data.historyState === "stale" ? "东方财富暂时无法更新，当前没有足够的历史缓存。" : "东方财富历史日线连接失败，本地尚无足够的真实缓存。系统不会生成模拟曲线。"}</p></div>
                  <Button asChild variant="ghost" size="sm"><Link to="/sources">查看数据状态</Link></Button>
                </div>
              )}
            </>
          ) : klineError && !klineData ? (
            <div className="flex flex-col items-center gap-3 py-14 text-center">
              <CircleAlert size={22} className="text-warning" />
              <div><h3 className="text-sm font-medium">{klinePeriod === "minute" ? "分时" : klinePeriod === "weekly" ? "周线" : "月线"}暂不可用</h3><p className="mt-1 text-xs text-muted-foreground">{klineError}。系统不会生成模拟曲线。</p></div>
            </div>
          ) : !klineData || klineData.period !== klinePeriod ? (
            <Skeleton className="h-[320px] w-full" role="status" aria-label="正在加载K线" />
          ) : klineData.items.length < 2 ? (
            <div className="flex flex-col items-center gap-3 py-14 text-center">
              <Database size={22} className="text-muted-foreground" />
              <div><h3 className="text-sm font-medium">暂无{klinePeriod === "minute" ? "分时" : klinePeriod === "weekly" ? "周线" : "月线"}数据</h3><p className="mt-1 text-xs text-muted-foreground">该周期下当前没有足够的真实行情数据。</p></div>
            </div>
          ) : (
            <>
              <KlineChart points={klineData.items} variant={klinePeriod === "minute" ? "line" : "candle"} previousClose={klineData.previousClose} />
              <p className="mt-3 text-right text-[11px] text-muted-foreground">
                数据来源：{klineData.source === "eastmoney" ? (klinePeriod === "minute" ? "东方财富实时分时" : "东方财富历史行情") : klineData.source === "tencent-mirror" ? "腾讯行情镜像（东方财富历史主机不可达）" : "本地数据库"}
                {klinePeriod === "minute" && klineData.items.length > 0 ? ` · 分时截至 ${klineData.items.at(-1)!.time}（午休或收盘后自然静止）` : ""}
                {" "}· 每 {klinePeriod === "minute" ? "15" : "60"} 秒自动更新
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1fr_0.8fr]">
        <Card>
          <CardHeader className="grid-cols-[1fr_auto] grid-rows-1 items-center justify-between">
            <div><p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">评分依据</p><CardTitle className="mt-1 text-lg">因子拆解</CardTitle></div>
            <p className="hidden text-xs text-muted-foreground sm:block">只有存在有效线索时才计算方向分和异动分。</p>
          </CardHeader>
          <CardContent className="px-6 pb-6">
            {stock.analysisStatus === "scored" ? <FactorBars factors={stock.factors} /> : (
              <div className="flex flex-col items-center gap-2 py-8 text-center"><Layers3 size={20} className="text-muted-foreground" /><h3 className="text-sm font-medium">暂无可拆解因子</h3><p className="text-xs text-muted-foreground">当前真实线索窗口尚未直接关联这只股票。</p></div>
            )}
            <div className="mt-6 flex gap-2.5 border-t pt-4 text-muted-foreground"><Info size={14} className="mt-0.5 shrink-0" /><p className="text-xs leading-relaxed">情绪方向来自文本表达；价格确认来自实时涨跌。高分歧会单独标记，不强行给出方向。</p></div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="grid-cols-[1fr_auto] grid-rows-1 items-center justify-between">
            <div><p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">二十四小时来源</p><CardTitle className="mt-1 text-lg">来源构成</CardTitle></div>
            <p className="text-xs text-muted-foreground">{stock.mentionCount} 条去重线索</p>
          </CardHeader>
          <CardContent className="px-6 pb-6">
            {Object.keys(stock.sourceMix).length ? <SourceMix sourceMix={stock.sourceMix} /> : <div className="py-6 text-center text-xs text-muted-foreground">当前没有可统计的来源构成。</div>}
            <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 text-xs text-down">
              <span className="flex items-center gap-1.5"><CheckCircle2 size={14} />真实来源</span>
              <span className="flex items-center gap-1.5"><CheckCircle2 size={14} />按事件去重</span>
              <span className="flex items-center gap-1.5"><CheckCircle2 size={14} />关联理由可追溯</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="grid-cols-[1fr_auto] grid-rows-1 items-center gap-4">
          <CardTitle className="text-lg">全部关联事件</CardTitle>
          <Tabs value={eventCategory} onValueChange={(value) => setEventCategory(value as typeof eventCategory)} className="min-w-0">
            <TabsList className="h-8 overflow-x-auto">
              {(["全部线索", "新闻事件", "公司公告", "用户讨论"] as const).map((category) => {
                const count = category === "全部线索" ? events.length : events.filter((event) => event.category === category).length;
                return (
                  <TabsTrigger value={category} key={category} className="gap-1.5 px-2.5 text-xs">
                    {category === "全部线索" ? "全部" : category.replace("事件", "")}
                    <span className="text-[10px] opacity-70 tabular">{count}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {filteredEvents.length ? (
            <div className="divide-y border-t">
              {filteredEvents.map((event) => <EvidenceRow key={event.id} event={event} stockCode={stock.code} />)}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 border-t py-12 text-center">
              <Layers3 size={22} className="text-muted-foreground" />
              <h3 className="text-sm font-medium">{events.length ? "该分类下暂无关联事件" : "当前没有关联事件"}</h3>
              <p className="text-xs text-muted-foreground">{events.length ? "切换到其他分类查看，或稍后自动更新。" : "这不是中性判断，只表示当前真实线索窗口内没有直接证据。"}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="grid-cols-[1fr_auto] grid-rows-1 items-center gap-2">
          <div><p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">历史事件后验</p><CardTitle className="mt-1 text-lg">后续表现核验</CardTitle></div>
          <p className="hidden max-w-[360px] text-xs text-muted-foreground lg:block">只有真实同类事件样本达到要求后才计算，避免用少量案例制造“胜率”。</p>
        </CardHeader>
        <CardContent className="px-0 pb-6">
          <div className="grid divide-y border-t sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {["五日后", "三十日后", "六十日后"].map((period) => (
              <div className="px-6 py-4" key={period}><p className="font-mono text-xs text-muted-foreground">{period}</p><strong className="mt-3 block text-lg font-semibold">样本不足</strong><p className="mt-1 text-xs text-muted-foreground">需至少二十个同类去重事件</p></div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SourceMix({ sourceMix }: { sourceMix: Record<string, number> }) {
  const entries = useMemo(() => Object.entries(sourceMix), [sourceMix]);
  let offset = 0;
  return (
    <div>
      <div className="relative h-2.5 overflow-hidden rounded-full bg-muted" aria-label="来源占比">
        {entries.map(([name, value], index) => {
          const start = offset;
          offset += value;
          return <i key={name} className={cn("absolute inset-y-0 bg-chart-1", index === 1 && "bg-chart-2", index === 2 && "bg-chart-3", index === 3 && "bg-chart-4")} style={{ left: `${start}%`, width: `${value}%` }} title={`${name} ${value}%`} />;
        })}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2">
        {entries.map(([name, value], index) => (
          <div className="flex items-center justify-between border-b pb-2" key={name}>
            <dt className="flex items-center gap-2 text-xs text-muted-foreground"><i className={cn("size-2 rounded-full bg-chart-1", index === 1 && "bg-chart-2", index === 2 && "bg-chart-3", index === 3 && "bg-chart-4")} />{name}</dt>
            <dd className="font-mono text-xs tabular">{value}%</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function EvidenceRow({ event, stockCode }: { event: SentimentEvent; stockCode: string }) {
  const relation = event.relatedStocks.find((stock) => stock.code === stockCode);
  return (
    <article className="grid grid-cols-[64px_1fr_36px] items-start gap-4 px-6 py-5 sm:grid-cols-[72px_minmax(0,1fr)_minmax(160px,0.4fr)_36px]">
      <div>
        <time className="font-mono text-xs tabular">{formatDateTime(event.publishedAt).slice(-5)}</time>
        <span className="mt-1 block text-[11px] text-muted-foreground">{event.category}</span>
        <span className="block text-[11px] text-muted-foreground">{event.eventType}</span>
      </div>
      <div className="min-w-0">
        <ToneBadge tone={event.tone} />
        <h3 className="mt-2 text-sm font-medium">{event.title}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{event.summary}</p>
        <span className="mt-2 block text-[11px] text-muted-foreground">{event.source}</span>
      </div>
      <div className="hidden border-l pl-5 sm:block">
        <span className="text-[11px] text-muted-foreground">关联度</span>
        <strong className="mt-1 block text-xl font-semibold tabular">{relation?.relevance ?? "—"}</strong>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{relation?.reason ?? "等待补充关联理由"}</p>
      </div>
      {event.url ? (
        <a href={event.url} target="_blank" rel="noreferrer" className="inline-flex size-9 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:border-foreground hover:text-foreground" aria-label={`打开 ${event.source} 原始线索`}><ArrowUpRight size={16} /></a>
      ) : <span />}
      <div className="col-span-2 border-t pt-3 text-[11px] text-muted-foreground sm:hidden"><span className="text-muted-foreground">关联度</span> <strong className="ml-1 text-sm text-foreground tabular">{relation?.relevance ?? "—"}</strong><p className="mt-1">{relation?.reason ?? "等待补充关联理由"}</p></div>
    </article>
  );
}
