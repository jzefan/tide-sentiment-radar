import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CheckCircle2, CircleAlert, Database, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import type { DataSourceStatus, SystemStatus } from "../domain/types";
import { scoreFormula } from "../domain/scoring";
import { api } from "../lib/api";
import { formatDateTime, formatNumber } from "../lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const stateCopy = {
  connected: { label: "已连接", icon: CheckCircle2, className: "text-down" },
  degraded: { label: "连接受限", icon: CircleAlert, className: "text-warning" },
  disabled: { label: "未启用", icon: Unplug, className: "text-muted-foreground" },
};

export function SourcesPage() {
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [checkedAt, setCheckedAt] = useState("");
  const requestController = useRef<AbortController | null>(null);

  const load = async (refresh = false) => {
    setRefreshing(true);
    requestController.current?.abort();
    const activeController = new AbortController();
    requestController.current = activeController;
    try {
      const next = refresh ? await api.refreshSystem(activeController.signal) : await api.system(activeController.signal);
      setSystem(next);
      setError("");
      if (refresh) window.dispatchEvent(new CustomEvent("system-status-updated", { detail: next }));
      if (refresh) setCheckedAt(new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()));
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "无法读取数据源状态");
    } finally {
      if (requestController.current === activeController) setRefreshing(false);
    }
  };

  useEffect(() => { void load(); return () => requestController.current?.abort(); }, []);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b pb-4">
        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">数据来源与新鲜度</p>
        <div className="flex flex-col items-end gap-1.5">
          <Button variant="outline" size="sm" type="button" disabled={refreshing} onClick={() => void load(true)}><RefreshCw className={refreshing ? "animate-spin" : ""} size={15} />{refreshing ? "正在重新连接" : "重新连接全部来源"}</Button>
          <span role="status" aria-live="polite" className="text-[11px] text-muted-foreground">{checkedAt ? `检测完成 · ${checkedAt}` : ""}</span>
        </div>
      </header>

      {error && <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning-soft px-4 py-2.5 text-sm"><CircleAlert size={16} className="text-warning" />{error}</div>}

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-label="数据概况">
        <Card className="gap-2 py-4">
          <CardContent className="px-5">
            <p className="text-xs text-muted-foreground">系统状态</p>
            <p className="mt-2 text-lg font-semibold">{system?.mode === "live" ? "实时数据完整" : system?.mode === "partial" ? "实时部分可用" : "真实数据不可用"}</p>
          </CardContent>
        </Card>
        <Card className="gap-2 py-4">
          <CardContent className="px-5">
            <p className="text-xs text-muted-foreground">全市场股票</p>
            <p className="mt-2 text-2xl font-semibold tabular">{formatNumber(system?.universe.total ?? 0)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{system?.universe.provider ?? "连接中"}</p>
          </CardContent>
        </Card>
        <Card className="gap-2 py-4">
          <CardContent className="px-5">
            <p className="text-xs text-muted-foreground">已关联股票</p>
            <p className="mt-2 text-2xl font-semibold tabular">{formatNumber(system?.universe.analyzed ?? 0)}</p>
            <p className="mt-1 text-xs text-muted-foreground">当前线索窗口</p>
          </CardContent>
        </Card>
        <Card className="gap-2 py-4">
          <CardContent className="px-5">
            <p className="text-xs text-muted-foreground">累计线索</p>
            <p className="mt-2 text-2xl font-semibold tabular">{formatNumber(system?.clues.total ?? 0)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{system?.clues.lastSuccessAt ? formatDateTime(system.clues.lastSuccessAt) : "尚未同步"}</p>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardContent className="px-6 py-5">
          <div className="grid gap-5 lg:grid-cols-[auto_1fr_auto] lg:items-center">
            <div className="grid size-14 place-items-center rounded-md bg-primary text-primary-foreground"><Database size={24} aria-hidden="true" /></div>
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">行情主数据源</p>
              <h2 className="mt-1 text-xl font-semibold">东方财富行情 · 本地数据库</h2>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{system?.marketStore.detail ?? "正在同步东方财富全市场行情……"}</p>
            </div>
            <div className={cn("flex items-center gap-2.5", system?.marketStore.connected ? "text-down" : "text-warning")}>
              <i className="size-2 rounded-full bg-current" />
              <div><strong className="block text-xs font-medium">{system?.marketStore.connected ? "已保存" : "同步中"}</strong><span className="text-[11px] text-muted-foreground tabular">{system?.marketStore.tradeDate ?? "等待首个交易日"}</span></div>
            </div>
          </div>
          <dl className="mt-5 grid grid-cols-1 gap-x-4 gap-y-2 border-t pt-4 sm:grid-cols-3">
            <div className="flex justify-between sm:block"><dt className="text-xs text-muted-foreground">行情来源</dt><dd className="mt-0.5 text-xs">{system?.marketStore.provider ?? "东方财富"}</dd></div>
            <div className="flex justify-between sm:block"><dt className="text-xs text-muted-foreground">已保存股票</dt><dd className="mt-0.5 text-xs tabular">{formatNumber(system?.marketStore.rows ?? 0)} 只</dd></div>
            <div className="flex justify-between sm:block"><dt className="text-xs text-muted-foreground">失败处理</dt><dd className="mt-0.5 text-xs">保留上次完整真数据</dd></div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="grid-cols-[1fr_auto] grid-rows-1 items-center justify-between">
          <div><p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">采集器状态</p><CardTitle className="mt-1 text-lg">全部数据链路</CardTitle></div>
          <p className="hidden text-xs text-muted-foreground sm:block">“全部线索”指所有已配置来源成功返回的记录，不代表全网内容。</p>
        </CardHeader>
        <CardContent className="px-0 pb-0" aria-busy={!system} aria-label={!system ? "正在加载数据源状态" : "数据源状态列表"}>
          {system ? (
            <div className="divide-y border-t">
              {system.sources.map((source) => <SourceRow source={source} key={source.id} />)}
            </div>
          ) : Array.from({ length: 5 }, (_, index) => <Skeleton className="mx-6 mb-4 h-20" key={index} />)}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">行情保存流程</p>
            <CardTitle className="text-lg">每天自动沉淀行情</CardTitle>
            <p className="text-xs text-muted-foreground">不需要另装行情服务，接口完成校验后才会发布一批完整数据。</p>
          </CardHeader>
          <CardContent className="px-6 pb-6">
            <ol className="list-none space-y-4 border-t">
              {["获取全市场", "整批校验", "写入本地"].map((step, index) => (
                <li className="flex gap-4 border-b py-3.5" key={step}>
                  <span className="font-mono text-sm text-muted-foreground">{["一", "二", "三"][index]}</span>
                  <div><strong className="text-sm font-medium">{step}</strong><p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{["从东方财富获取沪深北股票价格、涨跌与成交信息。", "检查数量、代码唯一性和关键行情字段，避免半批数据覆盖旧结果。", "按股票和交易日保存到本地数据库，个股日线缺失时自动回填。"][index]}</p></div>
                </li>
              ))}
            </ol>
            <a className="mt-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" href="https://quote.eastmoney.com/" target="_blank" rel="noreferrer">查看东方财富行情页面 <ArrowUpRight size={13} /></a>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">异动评分公式</p>
            <CardTitle className="text-lg">异动分怎么来</CardTitle>
            <p className="text-xs text-muted-foreground">只有股票存在真实关联线索时才产生分数。</p>
          </CardHeader>
          <CardContent className="px-6 pb-6">
            <div className="space-y-3.5 border-t pt-4">
              {scoreFormula.map((factor) => (
                <div className="grid grid-cols-[84px_1fr_36px] items-center gap-3" key={factor.key}>
                  <span className="text-xs text-muted-foreground">{factor.label}</span>
                  <i className="h-1.5 overflow-hidden rounded-full bg-muted"><b className="block h-full origin-left rounded-full bg-foreground/70" style={{ transform: `scaleX(${factor.weight / 40})` }} /></i>
                  <strong className="text-right font-mono text-xs">{factor.weight}%</strong>
                </div>
              ))}
            </div>
            <div className="mt-6 border-t pt-4">
              <span className="text-xs font-medium text-up">方向分</span>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">以 50 为中性，结合情绪、共识、来源质量、实时涨跌确认与信息时效计算。暂无线索时显示空值。</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <section className="flex gap-4 border-y py-6">
        <ShieldCheck size={20} className="mt-0.5 shrink-0 text-down" />
        <div><h2 className="text-sm font-semibold">数据与产品边界</h2><p className="mt-1.5 max-w-4xl text-xs leading-relaxed text-muted-foreground">公开接口可能存在授权、限频和稳定性限制。当前版本仅保存必要元数据与原始链接；商业上线前必须完成来源书面授权。产品只做舆情汇总、异动检测与历史核验，不提供买卖建议、目标价或收益承诺。</p></div>
      </section>
    </div>
  );
}

function SourceRow({ source }: { source: DataSourceStatus }) {
  const copy = stateCopy[source.state];
  const Icon = copy.icon;
  const link = source.termsUrl ?? source.repository;
  return (
    <article className="grid min-h-[80px] grid-cols-[88px_1fr_auto] items-center gap-4 px-6 py-3.5 sm:grid-cols-[96px_minmax(0,1fr)_auto_36px]">
      <span className={cn("inline-flex w-max items-center gap-1.5 text-xs", copy.className)}><Icon size={14} />{copy.label}</span>
      <div className="min-w-0">
        <strong className="text-sm font-medium">{source.name}</strong>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{source.description}</p>
        {source.licenseId && <small className="text-[11px] text-muted-foreground">许可编号：{source.licenseId}</small>}
      </div>
      <dl className="hidden min-w-[240px] grid-cols-2 sm:grid">
        <div><dt className="text-[11px] text-muted-foreground">最后同步</dt><dd className="mt-0.5 text-xs">{source.lastSync.includes("T") ? formatDateTime(source.lastSync) : source.lastSync}</dd></div>
        <div><dt className="text-[11px] text-muted-foreground">数据量</dt><dd className="mt-0.5 text-xs">{source.records}</dd></div>
      </dl>
      {link ? (
        <a href={link} target="_blank" rel="noreferrer" className="inline-flex size-9 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:border-foreground hover:text-foreground" aria-label={`打开 ${source.name}${source.termsUrl ? "许可条款" : "文档"}`} title={source.termsUrl ? "查看许可条款" : "查看来源文档"}><ArrowUpRight size={15} /></a>
      ) : <span className="hidden size-9 sm:block" />}
      <dl className="col-span-2 grid grid-cols-2 gap-4 border-t pt-2 sm:hidden">
        <div><dt className="text-[11px] text-muted-foreground">最后同步</dt><dd className="mt-0.5 text-xs">{source.lastSync.includes("T") ? formatDateTime(source.lastSync) : source.lastSync}</dd></div>
        <div><dt className="text-[11px] text-muted-foreground">数据量</dt><dd className="mt-0.5 text-xs">{source.records}</dd></div>
      </dl>
    </article>
  );
}
