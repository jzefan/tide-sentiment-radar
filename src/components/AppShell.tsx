import { useEffect, useState } from "react";
import { Activity, Database, ListFilter, Radio, Search, Star } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import type { SystemStatus } from "../domain/types";
import { api } from "../lib/api";
import { marketPhaseAt } from "../lib/marketCalendar";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";

const navItems = [
  { to: "/", label: "舆情雷达", icon: Radio, end: true },
  { to: "/watchlist", label: "我的自选", icon: Star, end: false },
  { to: "/screener", label: "异动候选", icon: ListFilter, end: false },
  { to: "/sources", label: "数据源", icon: Database, end: false },
];

export function AppShell() {
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [systemError, setSystemError] = useState("");
  const [now, setNow] = useState(() => new Date());
  const location = useLocation();
  const phase = marketPhaseAt(now);

  useEffect(() => {
    let controller: AbortController | null = null;
    const loadSystem = () => {
      controller?.abort();
      controller = new AbortController();
      api.system(controller.signal)
        .then((next) => { setSystem(next); setSystemError(""); })
        .catch((cause) => {
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          setSystemError(cause instanceof Error ? cause.message : "顶部状态更新失败");
        });
    };
    const acceptUpdate = (event: Event) => { setSystem((event as CustomEvent<SystemStatus>).detail); setSystemError(""); };
    void loadSystem();
    const interval = window.setInterval(loadSystem, 60_000);
    window.addEventListener("system-status-updated", acceptUpdate);
    return () => { controller?.abort(); window.clearInterval(interval); window.removeEventListener("system-status-updated", acceptUpdate); };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const connectionLabel = systemError
    ? (system ? "实时更新暂时中断" : "真实数据连接失败")
    : system?.mode === "live" ? "实时数据完整"
    : system?.mode === "partial" ? "实时部分可用"
    : "正在连接真实数据";
  const connectionDetail = systemError && system
    ? `保留上次成功状态 · ${snapshotTime(system)}`
    : system?.marketStore.connected ? "东方财富行情已保存到本地" : "行情正在首次同步";
  const connectionLive = !systemError && system?.mode === "live";

  return (
    <TooltipProvider delayDuration={120}>
      <SidebarProvider>
        <AppSidebar
          connectionLabel={connectionLabel}
          connectionDetail={connectionDetail}
          connectionLive={connectionLive}
        />
        <SidebarInset>
          <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4 sm:px-6">
            <div className="flex items-center gap-3">
              <SidebarTrigger className="-ml-1" />
              <Separator orientation="vertical" className="mr-1 hidden h-4 sm:block" />
              <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
                <Activity size={14} aria-hidden="true" />
                <span>A股</span>
                <span
                  className="font-medium text-foreground"
                  title={phase.calendarVerified ? "依据上交所二〇二六年休市安排，按上海当前时间判断" : "当前年份的交易所休市日历尚未核验"}
                >
                  {phase.label}
                </span>
                <time className={systemError ? "tabular text-warning font-medium" : "tabular"}>
                  {system ? `${systemError ? "数据截至" : "抓取"} ${snapshotTime(system)}` : systemError ? "首次连接失败" : "连接中"}
                </time>
              </div>
            </div>
            <NavLink
              to="/screener"
              className="flex items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <Search size={14} aria-hidden="true" />
              <span className="hidden md:inline">搜索股票或主题</span>
              <span className="rounded border px-1.5 py-0.5 text-[10px]">快捷入口</span>
            </NavLink>
          </header>
          <main id="main-content" className="flex flex-1 flex-col">
            <div className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-4 sm:px-6 lg:px-8 lg:py-5">
              <Outlet />
            </div>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

function AppSidebar({
  connectionLabel,
  connectionDetail,
  connectionLive,
}: {
  connectionLabel: string;
  connectionDetail: string;
  connectionLive: boolean;
}) {
  const { pathname } = useLocation();
  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="潮汐 · A股舆情雷达">
              <NavLink to="/">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-primary text-sidebar-primary-foreground">
                  <Activity size={15} aria-hidden="true" />
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-semibold tracking-wider">潮汐</span>
                  <span className="truncate text-[11px] text-sidebar-foreground/60">A股舆情雷达</span>
                </div>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="mt-10">
          <SidebarGroupContent>
            <SidebarMenu className="gap-3">
              {navItems.map(({ to, label, icon: Icon, end }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton
                    asChild
                    tooltip={label}
                    isActive={end ? pathname === to : pathname === to || pathname.startsWith(`${to}/`)}
                    className="h-12 rounded-none border-b border-sidebar-border/70 px-1.5 text-[15px] tracking-wide group-data-[collapsible=icon]:border-b-0 group-data-[collapsible=icon]:rounded-md [&>svg]:size-[18px]"
                  >
                    <NavLink to={to} end={end}>
                      <Icon aria-hidden="true" />
                      <span>{label}</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-start gap-2.5 border-t border-sidebar-border px-2 pt-3">
          <span
            className={`mt-1 size-2 shrink-0 rounded-full ${connectionLive ? "bg-down" : "bg-warning"}`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-sidebar-foreground">{connectionLabel}</p>
            <p className="mt-0.5 truncate text-[11px] text-sidebar-foreground/55">{connectionDetail}</p>
            <p className="mt-3 text-[10px] uppercase tracking-widest text-sidebar-foreground/40">研究辅助 · 非投资建议</p>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function snapshotTime(system: SystemStatus) {
  return new Date(system.snapshotAsOf).toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
