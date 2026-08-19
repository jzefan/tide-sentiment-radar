import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CheckCircle2, CircleAlert, Database, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import type { DataSourceStatus, SystemStatus } from "../domain/types";
import { scoreFormula } from "../domain/scoring";
import { api } from "../lib/api";
import { formatDateTime, formatNumber } from "../lib/format";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { XueqiuIcon } from "@/components/XueqiuIcon";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingState } from "@/components/LoadingState";
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
  const [xueqiuDialogOpen, setXueqiuDialogOpen] = useState(false);
  /** 地址栏导入代码需要直达后端端口：dev 为 8787，生产同端口。 */
  const apiPort = import.meta.env.DEV ? "8787" : window.location.port || "8787";
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
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b pb-3">
        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">数据来源与新鲜度</p>
        <div className="flex flex-col items-end gap-1.5">
          <Button variant="outline" size="sm" type="button" disabled={refreshing} onClick={() => void load(true)}><RefreshCw className={refreshing ? "animate-spin" : ""} size={15} />{refreshing ? "正在重新连接" : "重新连接全部来源"}</Button>
          <span role="status" aria-live="polite" className="text-[11px] text-muted-foreground">
            {refreshing
              ? "正在完整同步（行情 + 股吧 + 微博）… 可能需要 1-2 分钟，期间保留上次结果"
              : checkedAt
                ? `检测完成 · ${checkedAt}`
                : ""}
          </span>
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
              {system.sources.map((source) => <SourceRow source={source} key={source.id} onOpenXueqiu={() => setXueqiuDialogOpen(true)} />)}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-5 py-10">
              <LoadingState label="正在检测全部数据源" />
              <div className="w-full space-y-4 px-6">
                {Array.from({ length: 3 }, (_, index) => <Skeleton className="h-16 w-full" key={index} />)}
              </div>
            </div>
          )}
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

      <XueqiuConnectDialog
        open={xueqiuDialogOpen}
        apiPort={apiPort}
        onOpenChange={setXueqiuDialogOpen}
        onConnected={() => void load(true)}
      />
    </div>
  );
}

function SourceRow({ source, onOpenXueqiu }: { source: DataSourceStatus; onOpenXueqiu?: () => void }) {
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
        <div><dt className="text-[11px] text-muted-foreground">最后同步</dt><dd className="mt-0.5 text-xs">{String(source.lastSync ?? "").includes("T") ? formatDateTime(source.lastSync) : source.lastSync}</dd></div>
        <div><dt className="text-[11px] text-muted-foreground">数据量</dt><dd className="mt-0.5 text-xs">{source.records}</dd></div>
      </dl>
      {source.id === "xueqiu" ? (
        <Button
          type="button"
          variant={source.state === "connected" ? "default" : "outline"}
          size="sm"
          onClick={onOpenXueqiu}
          className={cn("h-9 gap-2 px-3", source.state !== "connected" && "hover:border-[#E02130]/50 hover:text-[#E02130]")}
        >
          <XueqiuIcon className={cn("size-4 shrink-0 rounded-full", source.state === "connected" && "ring-1 ring-white/60")} />
          {source.state === "connected" ? "会话已连接" : "连接雪球"}
        </Button>
      ) : link ? (
        <a href={link} target="_blank" rel="noreferrer" className="inline-flex size-9 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:border-foreground hover:text-foreground" aria-label={`打开 ${source.name}${source.termsUrl ? "许可条款" : "文档"}`} title={source.termsUrl ? "查看许可条款" : "查看来源文档"}><ArrowUpRight size={15} /></a>
      ) : <span className="hidden size-9 sm:block" />}
      <dl className="col-span-2 grid grid-cols-2 gap-4 border-t pt-2 sm:hidden">
        <div><dt className="text-[11px] text-muted-foreground">最后同步</dt><dd className="mt-0.5 text-xs">{String(source.lastSync ?? "").includes("T") ? formatDateTime(source.lastSync) : source.lastSync}</dd></div>
        <div><dt className="text-[11px] text-muted-foreground">数据量</dt><dd className="mt-0.5 text-xs">{source.records}</dd></div>
      </dl>
    </article>
  );
}

function XueqiuConnectDialog({
  open,
  apiPort,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  apiPort: string;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState("");
  const [manualCookie, setManualCookie] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [manualResult, setManualResult] = useState("");
  const [browserLogin, setBrowserLogin] = useState<"" | "waiting" | "failed">("");
  const [browserMessage, setBrowserMessage] = useState("");
  const [showBookmark, setShowBookmark] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const startBrowserLogin = async () => {
    setBrowserLogin("waiting");
    setBrowserMessage("");
    try {
      const response = await fetch("/api/xueqiu/browser-login", { method: "POST" });
      const payload = await response.json() as { ok?: boolean; message?: string };
      if (payload.ok) {
        setBrowserLogin("");
        onOpenChange(false);
        onConnected();
      } else {
        setBrowserLogin("failed");
        setBrowserMessage(payload.message ?? "自动登录失败");
      }
    } catch {
      setBrowserLogin("failed");
      setBrowserMessage("浏览器登录请求失败，请使用下方手动粘贴方式");
    }
  };
  const submitManual = async () => {
    setSubmitting(true);
    setManualResult("");
    try {
      const response = await fetch("/api/xueqiu/cookie", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cookie: manualCookie.trim() }),
      });
      const payload = await response.json() as { ok?: boolean; message?: string };
      if (payload.ok) {
        setManualResult("✅ 已保存并生效，雪球讨论已连接。");
        setManualCookie("");
        onOpenChange(false);
        onConnected();
      } else {
        setManualResult(`❌ ${payload.message ?? "保存失败"}`);
      }
    } catch {
      setManualResult("❌ 提交失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };
  // 书签方式：把下面的链接拖到书签栏，然后在雪球页面点击书签执行（地址栏粘贴 javascript: 会被浏览器拦截）。
  const fetchCode = `fetch('http://127.0.0.1:${apiPort}/api/xueqiu/cookie',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cookie:document.cookie})}).then(r=>r.json()).then(j=>alert(j.message))`;
  const bookmarkSnippet = `javascript:${fetchCode}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fetchCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setResult("复制失败，请手动选中代码复制。");
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>连接雪球讨论</DialogTitle>
          <DialogDescription>使用你自己的雪球账号会话，一键导入，无需手动复制 Cookie。</DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            如果你已在自己常用的浏览器（Chrome / Edge / Brave）里登录了雪球，最快的方式是在项目目录运行
            <code className="mx-1 rounded bg-muted px-1 font-mono text-[10px]">pnpm xueqiu:session</code>
            直接读取该浏览器的会话（会短暂退出浏览器并自动重开，可用
            <code className="mx-1 rounded bg-muted px-1 font-mono text-[10px]">--dry-run</code>
            先预演）。
          </p>
        </div>
        <div className="rounded-md border p-4">
          <p className="text-sm font-medium">方式一：浏览器自动登录（推荐，本机）</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            点击后本机弹出浏览器窗口打开雪球，用<b className="font-medium text-foreground">雪球 App 扫码</b>或账号密码登录
            （真实浏览器可正常通过验证码与风控），登录成功后程序自动保存会话，并保持该浏览器登录状态用于数据抓取（窗口可最小化，请勿关闭；关闭后将自动回退到本地 Cookie 直连）。
          </p>
          <div className="mt-3 flex items-center gap-3">
            <Button type="button" size="sm" disabled={browserLogin === "waiting"} onClick={() => void startBrowserLogin()}>
              {browserLogin === "waiting" ? "等待登录中…（浏览器窗口已打开）" : "打开浏览器登录"}
            </Button>
            {browserLogin === "failed" && <span className="text-xs text-muted-foreground">{browserMessage}</span>}
          </div>
        </div>
        <div className="rounded-md border border-dashed p-4">
          <button type="button" className="flex w-full items-center justify-between text-sm font-medium" onClick={() => setShowBookmark((value) => !value)}>
            方式二：手动创建书签（备选）
            <span className="text-xs text-muted-foreground">{showBookmark ? "收起 ▲" : "展开 ▼"}</span>
          </button>
          {showBookmark && (
        <ol className="mt-3 space-y-4 text-sm">
          <li className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">1</span>
            <div>
              <p className="font-medium">手动创建书签</p>
              <p className="mt-1 text-xs text-muted-foreground">在新窗口登录你的雪球账号（若已登录可跳过）。</p>
              <a href="https://xueqiu.com/" target="_blank" rel="noreferrer" className="mt-2 inline-flex text-xs font-medium text-up underline underline-offset-4">打开 xueqiu.com ↗</a>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">2</span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">把「雪球一键导入」收藏为书签（手动创建）</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                浏览器会拦截拖拽 javascript: 链接，请<b className="font-medium text-foreground">手动创建</b>：右键书签栏 → 添加网页 →
                名称填「雪球一键导入」，地址栏粘贴下面的代码 → 保存。
              </p>
              <div className="mt-2 flex items-center gap-2">
                <input readOnly value={bookmarkSnippet} onFocus={(event) => event.currentTarget.select()} className="h-9 w-full min-w-0 flex-1 rounded-md border bg-muted px-2 font-mono text-[10px] text-muted-foreground" />
              </div>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">3</span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">在雪球页面点击书签执行</p>
              <p className="mt-1 text-xs text-muted-foreground">回到已登录的雪球页面，点击刚才的书签，弹出“雪球会话已保存并生效”即成功。</p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                备选：F12 打开<b className="font-medium text-foreground"> Sources（源代码）</b>面板，点击顶部 ⏸「禁用断点」按钮（或按 Ctrl+\）解除雪球的反调试，
                再切到<b className="font-medium text-foreground"> Console（控制台）</b>粘贴下面代码回车。
              </p>
              <div className="mt-2 flex items-center gap-2">
                <input readOnly value={fetchCode} onFocus={(event) => event.currentTarget.select()} className="h-9 w-full min-w-0 flex-1 rounded-md border bg-muted px-2 font-mono text-[10px] text-muted-foreground" />
                <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>{copied ? "已复制" : "复制代码"}</Button>
              </div>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">4</span>
            <div>
              <p className="font-medium">回到本页刷新状态</p>
              <p className="mt-1 text-xs text-muted-foreground">关闭本窗口，点击页面右上角“重新连接全部来源”，雪球讨论将显示为已连接。</p>
            </div>
          </li>
        </ol>
          )}
        </div>
        <div className="rounded-md border border-dashed p-4">
          <button type="button" className="flex w-full items-center justify-between text-sm font-medium" onClick={() => setShowManual((value) => !value)}>
            方式三：手动粘贴 Cookie（兜底，服务器部署时用）
            <span className="text-xs text-muted-foreground">{showManual ? "收起 ▲" : "展开 ▼"}</span>
          </button>
          {showManual && (
          <div className="mt-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            如果书签/控制台方式被浏览器或雪球的反调试拦截，用这个方法：F12 打开开发者工具 → <b className="font-medium text-foreground">Network（网络）</b>面板 →
            刷新雪球页面 → 点任意 xueqiu.com 请求 → 复制请求头里的完整 <code className="rounded bg-muted px-1 font-mono text-[10px]">Cookie</code> 值，粘贴到下面。
            Network 面板不受雪球反调试影响。
          </p>
          <textarea
            value={manualCookie}
            onChange={(event) => setManualCookie(event.target.value)}
            placeholder="粘贴完整 Cookie，例如：xq_a_token=xxx; xqat=xxx; ..."
            rows={3}
            className="mt-2 w-full rounded-md border bg-muted px-2 py-1.5 font-mono text-[11px] text-muted-foreground"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{manualResult}</span>
            <Button type="button" variant="outline" size="sm" disabled={submitting || !manualCookie.trim()} onClick={() => void submitManual()}>
              {submitting ? "校验中…" : "导入 Cookie"}
            </Button>
          </div>
          </div>
          )}
        </div>
        {result && <p className="text-xs text-muted-foreground">{result}</p>}
        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>关闭</Button>
          <Button size="sm" onClick={() => { onOpenChange(false); onConnected(); }}>我已导入，刷新状态</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
