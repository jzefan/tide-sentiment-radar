/**
 * 雪球真浏览器会话（最终方案）。
 *
 * 实测结论：雪球数据接口由阿里云 WAF 保护，服务端 Node 直连（即使携带完整 Cookie）
 * 必然命中挑战页；每次新开的无痕/临时浏览器也会因为无历史、无 WAF 放行记录而被反复挑战。
 *
 * 因此所有校验与数据抓取统一走同一个【真实 Chrome + 持久化档案】会话：
 *  - 二进制用本机安装的 Google Chrome（不是 Playwright 自带 Chromium），指纹可信；
 *  - 档案目录固定为 data/xueqiu-chrome-profile：登录态、WAF 放行 Cookie（acw_sc__v2 等）
 *    会跨进程、跨重启保留——挑战只要在可见窗口里通过一次，之后长期免挑战；
 *  - 数据请求在该会话页面内 fetch（真实 TLS + 全量 Cookie），服务端不直连雪球；
 *  - 建立会话时先试无头（不打扰用户），失败再开可见窗口（用户可手动滑验证）。
 *
 * 会话来源三个入口都能殊途同归到这个会话：
 *  1. 页面按钮「连接雪球」（launchXueqiuBrowserLogin，可见窗口登录）；
 *  2. 手动粘贴 Cookie（verifyAndSaveXueqiuCookie，注入后会话内校验）；
 *  3. 一条命令 pnpm xueqiu:session（importXueqiuCookieVerified，日常浏览器已校验）。
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { diagLog } from "./diagLog.ts";
import { persistXueqiuCookie } from "./xueqiuSession.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const PROFILE_DIR = join(root, "data", "xueqiu-chrome-profile");
/** 档案占用锁：记录持有者 PID，防止服务器与同步脚本等进程互相抢杀浏览器。 */
const PROFILE_LOCK = join(root, "data", "xueqiu-chrome-profile.lock");
const REAL_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** Playwright 浏览器缓存目录（按平台）：macOS 在 ~/Library/Caches，Linux 在 ~/.cache。 */
const PLAYWRIGHT_CACHE_ROOTS = process.platform === "darwin"
  ? [join(homedir(), "Library", "Caches", "ms-playwright")]
  : [join(homedir(), ".cache", "ms-playwright")];
/** Linux 上常见 Chrome/Chromium 安装路径（无头服务器多走这些）。 */
const LINUX_CHROME_PATHS = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
];
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** 建立会话连续失败后，多长时间内不再重试开窗（避免每个刷新周期都弹窗打扰）。 */
const ENSURE_COOLDOWN_MS = 10 * 60_000;
/** 建立常驻会话的整体硬上限：到点即强杀所有新建浏览器，绝不让 API 请求无限挂起。 */
const SESSION_OP_TIMEOUT_MS = 120_000;
/** context.close() 的宽限：浏览器迟迟不退（如 WAF 挑战页死循环）时强杀进程。 */
const CLOSE_GRACE_MS = 8_000;

export interface XueqiuSessionResult {
  ok: boolean;
  message: string;
}

interface LiveSession {
  context: BrowserContext;
}

let liveSession: LiveSession | null = null;
/** 所有建立会话的操作共用一把锁，避免并发开窗。 */
let sessionOp: Promise<unknown> | null = null;
let lastEnsureFailureAt = 0;

function findChromiumExecutable(): string | null {
  for (const rootDir of PLAYWRIGHT_CACHE_ROOTS) {
    if (!existsSync(rootDir)) continue;
    try {
      const versions = readdirSync(rootDir)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
      for (const version of versions) {
        const versionDir = join(rootDir, version);
        const layouts = readdirSync(versionDir).filter((name) => name.startsWith("chrome-mac") || name.startsWith("chrome-linux"));
        for (const layout of layouts) {
          const layoutDir = join(versionDir, layout);
          try {
            for (const entry of readdirSync(layoutDir)) {
              // macOS：Google Chrome.app/Contents/MacOS/Google Chrome
              // Linux：chrome-linux/chrome
              const executable = entry.endsWith(".app")
                ? join(layoutDir, entry, "Contents", "MacOS", entry.slice(0, -4))
                : (entry === "chrome" ? join(layoutDir, entry) : null);
              if (executable && existsSync(executable)) return executable;
            }
          } catch {
            continue;
          }
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** 档案锁的持有者 PID（无锁或损坏返回 null）。 */
function lockOwner(): number | null {
  try {
    const pid = Number(readFileSync(PROFILE_LOCK, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writeLock(): void {
  try {
    mkdirSync(dirname(PROFILE_LOCK), { recursive: true });
    writeFileSync(PROFILE_LOCK, String(process.pid), "utf8");
  } catch {
    // 锁写失败不阻断
  }
}

function releaseLock(): void {
  try {
    rmSync(PROFILE_LOCK, { force: true });
  } catch {
    // 忽略
  }
}

/**
 * 清掉占用持久化档案的残留浏览器进程与锁文件。
 * 只清理“孤儿”进程（父进程已退出，例如 tsx watch 热重载后遗留的浏览器）；
 * 如果档案正被另一个存活进程使用（如本机同步脚本与服务器同时运行），
 * 不主动杀对方进程，由调用方以明确报错收场，避免互相 pkill 抖动。
 */
function releaseProfileLock(): void {
  try {
    const out = spawnSync("pgrep", ["-f", "xueqiu-chrome-profile"], { encoding: "utf8" });
    for (const line of out.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      let ppid = -1;
      try {
        const parent = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
        ppid = Number(parent.stdout.trim());
      } catch {
        // ps 不可用：按孤儿处理，直接清理
      }
      if (ppid === process.pid) continue; // 自己的子进程（正在使用的会话），不动
      const parentAlive = ppid > 0 && (() => {
        try {
          process.kill(ppid, 0);
          return true;
        } catch {
          return false;
        }
      })();
      if (!parentAlive) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // 进程已退出
        }
      }
    }
  } catch {
    // pgrep 不可用时忽略
  }
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      rmSync(join(PROFILE_DIR, name), { force: true });
    } catch {
      // 锁文件不存在时忽略
    }
  }
  // 档案占用锁的持有者已退出时一并清理；持有者存活则保留（由调用方报错）。
  const owner = lockOwner();
  if (owner !== null && owner !== process.pid) {
    try {
      process.kill(owner, 0);
    } catch {
      releaseLock();
    }
  }
}

/** 取浏览器子进程（persistent context 同样适用）；连接已断或不可用时返回 null。 */
function browserProcessOf(context: BrowserContext): import("node:child_process").ChildProcess | null {
  try {
    const browser = context.browser();
    if (!browser) return null;
    // Browser 的公开类型未暴露 process()，但实现类提供该方法。
    const withProcess = browser as unknown as { process?: () => import("node:child_process").ChildProcess | null };
    return typeof withProcess.process === "function" ? withProcess.process() : null;
  } catch {
    return null;
  }
}

/**
 * 有界关闭浏览器上下文：先正常 close，宽限期内不退则强杀进程。
 * context.close() 本身没有超时——WAF 挑战页死循环、渲染进程卡死都会让它永久挂起，
 * 而它一旦挂起，调用链（会话建立 → 讨论抓取 → 快照 → API）就会全线卡死。
 */
async function forceCloseContext(context: BrowserContext): Promise<void> {
  const proc = browserProcessOf(context);
  const closed = await Promise.race([
    context.close().then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CLOSE_GRACE_MS)),
  ]);
  if (!closed && proc && proc.exitCode === null) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // 进程已退出
    }
    await context.close().catch(() => undefined);
  }
  releaseLock();
  diagLog("xueqiu", "forceClose: 完成", closed ? "正常关闭" : "超时强杀", proc?.pid ?? "");
}

/**
 * 启动真实 Chrome（持久化档案）。优先本机 Google Chrome，缺失时回退 Playwright Chromium。
 * headless=true 时不弹窗（用于后台抓取）；false 时开可见窗口（用户可登录/过验证）。
 */
async function launchRealChrome(headless: boolean): Promise<BrowserContext> {
  mkdirSync(PROFILE_DIR, { recursive: true });
  // 档案占用锁：另一存活进程正持有档案（如同步脚本与服务端同时运行）时直接报错，
  // 不做任何强杀，避免两个进程互相干扰彼此正在使用的浏览器。
  const owner = lockOwner();
  if (owner !== null && owner !== process.pid) {
    let ownerAlive = false;
    try {
      process.kill(owner, 0);
      ownerAlive = true;
    } catch {
      // 持有者已退出：可回收
    }
    if (ownerAlive) {
      throw new Error(`雪球浏览器档案正被另一个进程（PID ${owner}）使用：请先停止它（如同步脚本或旧服务进程）再重试`);
    }
    releaseLock();
  }
  writeLock();
  const args = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    // XUEQIU_DIRECT=1 时强制直连，绕过系统代理（机房 IP 代理是雪球风控高发诱因）。
    ...(process.env.XUEQIU_DIRECT === "1" ? ["--no-proxy-server"] : []),
  ];
  // Linux 无头服务器必须关闭沙箱并限制共享内存，否则 Chrome 起不来。
  if (process.platform === "linux") {
    args.push("--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu");
  }
  const options = { headless, viewport: null, locale: "zh-CN", timezoneId: "Asia/Shanghai", args };
  const candidates: Array<Record<string, unknown>> = [];
  if (process.platform === "darwin" && existsSync(REAL_CHROME)) candidates.push({ executablePath: REAL_CHROME });
  if (process.platform === "linux") {
    for (const path of LINUX_CHROME_PATHS) if (existsSync(path)) candidates.push({ executablePath: path });
  }
  const fallback = findChromiumExecutable();
  if (fallback) candidates.push({ executablePath: fallback });
  if (!candidates.length) throw new Error("本机未安装 Google Chrome，且未找到 Playwright 浏览器");

  let lastError: Error | null = null;
  for (let round = 0; round < 2; round++) {
    for (const candidate of candidates) {
      try {
        return await chromium.launchPersistentContext(PROFILE_DIR, { ...options, ...candidate });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (!/already in use|ProcessSingleton|user data directory|Singleton/i.test(lastError.message)) throw lastError;
        // 档案被占用：清残留进程与锁文件后整体重试一轮
      }
    }
    releaseProfileLock();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw lastError ?? new Error("雪球专用浏览器档案被占用，请先关闭相关窗口后重试");
}

async function applyAntiDetect(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
}

/**
 * WAF/统计类 Cookie 绑定生成它们的浏览器实例，原样注入到新实例反而会让
 * WAF 挑战 JS 死循环（实测：注入 acw_tc 后页面主线程被挑战脚本卡死）。
 * 跳过它们，让新浏览器自行完成一次 WAF 挑战（实测约 5 秒内，无头亦可）。
 */
const WAF_COOKIE_PATTERN = /^(acw_|ssxmod|\.?thumbcache|Hm_|HMACCOUNT|aliyungf_tc)/;

/** 注入登录与身份 Cookie（跳过 WAF/统计类），并清掉档案里可能残留的旧 WAF 令牌。 */
async function seedXueqiuCookies(context: BrowserContext, cookie: string): Promise<void> {
  try {
    // 清理档案里残留的旧 WAF 令牌（它们绑定旧的浏览器实例，会让新实例被挑战死循环）。
    await context.clearCookies({ name: WAF_COOKIE_PATTERN });
  } catch {
    // 清理失败不阻断
  }
  const cookies = cookie
    .split(/;\s*/)
    .map((pair) => {
      const index = pair.indexOf("=");
      if (index <= 0) return null;
      const name = pair.slice(0, index).trim();
      return { name, value: pair.slice(index + 1).trim(), domain: ".xueqiu.com", path: "/" };
    })
    .filter((item): item is { name: string; value: string; domain: string; path: string } => Boolean(item?.name && !WAF_COOKIE_PATTERN.test(item.name)));
  if (cookies.length) await context.addCookies(cookies);
}

/**
 * 在页面内发起同源 fetch 取雪球 JSON；命中挑战页抛 CHALLENGE_PAGE。
 * 注意：playwright 的 page.evaluate 没有超时——页面主线程一旦被 WAF 挑战脚本
 * 卡死，evaluate 会永远挂起，因此这里必须用 Promise.race 做硬超时兜底。
 */
async function fetchJsonInPage(page: Page, url: string): Promise<Record<string, unknown>> {
  const result = await Promise.race([
    page.evaluate(async (targetUrl) => {
      const resp = await fetch(targetUrl, {
        headers: { accept: "application/json, text/plain, */*", "x-requested-with": "XMLHttpRequest" },
        signal: AbortSignal.timeout(10_000),
      });
      const text = await resp.text();
      if (!text.trimStart().startsWith("{")) throw new Error("CHALLENGE_PAGE");
      return JSON.parse(text) as Record<string, unknown>;
    }, url),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("PAGE_EVALUATE_TIMEOUT：页面无响应（可能被风控挑战卡死）")), 15_000);
    }),
  ]);
  return result as Record<string, unknown>;
}

export interface XueqiuTimelinePayload {
  code?: number;
  list?: Array<Record<string, unknown>>;
  statuses?: Array<Record<string, unknown>>;
  error_description?: string;
  message?: string;
}

/**
 * 在给定页面内探测雪球会话是否可用（贵州茅台时间线）。
 * reason === "challenge" 表示命中 WAF 挑战页（可等待浏览器自动过挑战后重试）。
 */
export async function probeXueqiuSessionInBrowser(page: Page): Promise<{ ok: boolean; message: string; reason?: "challenge" }> {
  try {
    // 实测（2026-08）：stock_timeline 对当前会话返回 error_code 10020，
    // 网页实际使用的讨论搜索接口 query/v1/symbol/search/status.json 可用，用作探针。
    const params = new URLSearchParams({ count: "1", comment: "0", symbol: "SH600519", hl: "0", source: "all", sort: "time", q: "", type: "11" });
    const payload = (await fetchJsonInPage(page, `https://xueqiu.com/query/v1/symbol/search/status.json?${params}`)) as XueqiuTimelinePayload;
    if (payload.error_description || (payload.code !== undefined && payload.code !== 0)) {
      return { ok: false, message: payload.error_description ?? payload.message ?? "雪球会话无效" };
    }
    const rows = payload.list ?? payload.statuses ?? [];
    if (rows.length === 0) return { ok: false, message: "未返回讨论数据，会话可能未登录" };
    return { ok: true, message: "会话有效" };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    if (raw.includes("CHALLENGE_PAGE")) return { ok: false, message: "命中雪球风控挑战页", reason: "challenge" };
    return { ok: false, message: "探测请求失败，请稍后重试" };
  }
}

/** 等待 WAF 的 JS 挑战在页面内自动完成：挑战类失败可多等几轮，其余立即返回。 */
async function waitForSessionReady(page: Page, attempts = 3, intervalMs = 5_000): Promise<{ ok: boolean; message: string }> {
  let lastMessage = "会话校验未通过";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const probe = await probeXueqiuSessionInBrowser(page);
    if (probe.ok) return { ok: true, message: probe.message };
    lastMessage = probe.message;
    if (probe.reason !== "challenge") return { ok: false, message: probe.message };
    await page.waitForTimeout(intervalMs);
  }
  return { ok: false, message: `${lastMessage}（若在可见窗口中，请手动完成滑块/验证后重试）` };
}

/** 常驻浏览器会话是否可用。 */
export function isXueqiuLiveReady(): boolean {
  return Boolean(liveSession);
}

/** 本机是否存在可用的 Chrome/Chromium（用于判断服务端是否能自主抓取雪球）。 */
export function isXueqiuBrowserAvailable(): boolean {
  if (process.platform === "darwin" && existsSync(REAL_CHROME)) return true;
  if (process.platform === "linux" && LINUX_CHROME_PATHS.some((path) => existsSync(path))) return true;
  return Boolean(findChromiumExecutable());
}

/** 主动关闭常驻浏览器会话（有界：超时强杀，不会挂起）。 */
export async function stopXueqiuLiveSession(): Promise<void> {
  const session = liveSession;
  liveSession = null;
  if (session) await forceCloseContext(session.context);
}

function adoptSession(context: BrowserContext): void {
  liveSession = { context };
  context.on("close", () => {
    liveSession = null;
  });
}

/** 读取常驻会话的完整 Cookie 串（含 xqat），失效时返回 null。 */
async function readLiveCookieString(): Promise<string | null> {
  if (!liveSession) return null;
  try {
    const cookies = await liveSession.context.cookies("https://xueqiu.com");
    const token = cookies.find((cookie) => cookie.name === "xq_a_token" && cookie.value);
    if (!token) return null;
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  } catch {
    return null;
  }
}

/** 在常驻会话里挑一个停留在 xueqiu.com 的页面；没有则新开一个并回到雪球首页。 */
async function pickXueqiuPage(): Promise<Page> {
  if (!liveSession) throw new Error("雪球浏览器会话不可用");
  const existing = liveSession.context.pages().find((page) => page.url().startsWith("https://xueqiu.com"));
  if (existing) return existing;
  const page = await liveSession.context.newPage();
  await page.goto("https://xueqiu.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  return page;
}

/**
 * 用已保存的 Cookie 建立常驻真浏览器会话：先试无头（不打扰用户），
 * 挑战未过再开可见窗口重试一次。带冷却，连续失败 10 分钟内不再开窗。
 * 全程有界（总超时 + 强杀兜底），任何情况下都不会让调用方无限等待。
 */
export function ensureXueqiuLiveSession(cookie: string): Promise<boolean> {
  if (isXueqiuLiveReady()) return Promise.resolve(true);
  if (sessionOp) {
    diagLog("xueqiu", "ensure: 已有会话操作进行中，等待");
    return sessionOp.then(() => isXueqiuLiveReady());
  }
  if (Date.now() - lastEnsureFailureAt < ENSURE_COOLDOWN_MS) {
    diagLog("xueqiu", "ensure: 冷却期内，跳过");
    return Promise.resolve(false);
  }
  diagLog("xueqiu", "ensure: 开始建立会话");

  sessionOp = establishLiveSession(cookie)
    .then(() => {
      if (!isXueqiuLiveReady()) lastEnsureFailureAt = Date.now();
    })
    .catch(() => {
      lastEnsureFailureAt = Date.now();
    })
    .finally(() => {
      sessionOp = null;
    });
  return sessionOp.then(() => isXueqiuLiveReady());
}

/** 建立常驻会话的完整流程：无头 → 有头兜底，全程有界。 */
async function establishLiveSession(cookie: string): Promise<void> {
  const opened: BrowserContext[] = [];
  let timeoutHit = false;
  // 看门狗：到点强杀所有新建浏览器并结束等待，绝不让会话操作阻塞服务。
  const watchdog = new Promise<void>((resolve) => {
    setTimeout(() => {
      timeoutHit = true;
      for (const context of opened) void forceCloseContext(context);
      resolve();
    }, SESSION_OP_TIMEOUT_MS);
  });

  const work = (async () => {
    // 第一轮：无头，静默建立。
    diagLog("xueqiu", "establish: 启动无头 Chrome…");
    const headlessContext = await launchRealChrome(true);
    opened.push(headlessContext);
    diagLog("xueqiu", "establish: 无头 Chrome 已启动");
    await applyAntiDetect(headlessContext);
    await seedXueqiuCookies(headlessContext, cookie);
    const headlessPage = headlessContext.pages()[0] ?? (await headlessContext.newPage());
    try {
      await headlessPage.goto("https://xueqiu.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
      diagLog("xueqiu", "establish: goto 完成", headlessPage.url().slice(0, 60));
    } catch (error) {
      diagLog("xueqiu", "establish: goto 失败", error instanceof Error ? error.message : String(error));
    }
    const headlessReady = await waitForSessionReady(headlessPage, 3, 4_000);
    diagLog("xueqiu", "establish: 无头探针结果", headlessReady.message);
    if (headlessReady.ok && !timeoutHit) {
      adoptSession(headlessContext);
      opened.length = 0;
      diagLog("xueqiu", "establish: 无头会话已接管");
      return;
    }
    await forceCloseContext(headlessContext);
    diagLog("xueqiu", "establish: 无头已关闭，timeoutHit =", timeoutHit);
    if (timeoutHit) return; // 看门狗已触发：不再开新窗口，直接收尾

    // 第二轮：可见窗口（用户可手动完成滑块/验证），多等一会儿。
    diagLog("xueqiu", "establish: 启动有头 Chrome…");
    const headedContext = await launchRealChrome(false);
    opened.push(headedContext);
    diagLog("xueqiu", "establish: 有头 Chrome 已启动");
    await applyAntiDetect(headedContext);
    const headedPage = headedContext.pages()[0] ?? (await headedContext.newPage());
    try {
      await headedPage.goto("https://xueqiu.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
      diagLog("xueqiu", "establish: 有头 goto 完成", headedPage.url().slice(0, 60));
    } catch (error) {
      diagLog("xueqiu", "establish: 有头 goto 失败", error instanceof Error ? error.message : String(error));
    }
    const headedReady = await waitForSessionReady(headedPage, 6, 10_000);
    diagLog("xueqiu", "establish: 有头探针结果", headedReady.message);
    if (headedReady.ok && !timeoutHit) {
      adoptSession(headedContext);
      opened.length = 0;
      diagLog("xueqiu", "establish: 有头会话已接管");
      return;
    }
    await forceCloseContext(headedContext);
    throw new Error(headedReady.message);
  })();

  await Promise.race([work, watchdog]);
  diagLog("xueqiu", "establish: 结束，已接管 =", isXueqiuLiveReady());
  // 若看门狗已触发而 work 仍在后台收尾，它会自己强关所有已开上下文。
}

/**
 * 数据抓取入口：在常驻真浏览器会话的页面内 fetch 雪球接口。
 * 自带真实 TLS + 全量 Cookie（含 xqat、WAF 放行 Cookie），服务端不直连雪球。
 */
export async function fetchXueqiuTimelineInBrowser(url: string, _referer?: string): Promise<XueqiuTimelinePayload> {
  const page = await pickXueqiuPage();
  return (await fetchJsonInPage(page, url)) as XueqiuTimelinePayload;
}

/**
 * 页面按钮「连接雪球」：开可见的真实 Chrome 窗口，用户在窗口里登录/过验证，
 * 程序轮询直到页内探针通过，随后持久化 Cookie 并保持窗口常驻用于抓取。
 */
export function launchXueqiuBrowserLogin(): Promise<XueqiuSessionResult> {
  if (sessionOp) return Promise.resolve({ ok: false, message: "已有一个雪球会话操作在进行中，请稍候" });
  sessionOp = (async (): Promise<XueqiuSessionResult> => {
    // 已有常驻会话：直接重新校验并刷新持久化 Cookie。
    if (isXueqiuLiveReady()) {
      const page = await pickXueqiuPage();
      const probe = await waitForSessionReady(page, 2, 3_000);
      if (probe.ok) {
        const cookie = await readLiveCookieString();
        if (cookie) persistXueqiuCookie(cookie);
        return { ok: true, message: "雪球会话已连接（复用已打开的浏览器）" };
      }
      await stopXueqiuLiveSession();
    }

    const context = await launchRealChrome(false);
    await applyAntiDetect(context);
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      try {
        await page.goto("https://xueqiu.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch {
        // 首页打开失败不阻断，继续轮询（用户可能正在通过验证）
      }
      // 轮询等待：用户登录 / WAF 自动过挑战 / 用户手动过验证，任一满足后探针即通过。
      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const cookies = await context.cookies("https://xueqiu.com");
        const token = cookies.find((cookie) => cookie.name === "xq_a_token" && cookie.value);
        if (token) {
          const probe = await probeXueqiuSessionInBrowser(page);
          if (probe.ok) {
            adoptSession(context);
            const cookieString = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
            persistXueqiuCookie(cookieString);
            return { ok: true, message: "雪球会话已连接，数据抓取走真浏览器（窗口请保持打开，可最小化）" };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      await forceCloseContext(context);
      return { ok: false, message: "等待超时：请在打开的窗口中登录雪球（若弹出滑块/安全验证请先完成），然后再点一次连接" };
    } catch (error) {
      await forceCloseContext(context);
      throw error;
    }
  })().finally(() => {
    sessionOp = null;
  });
  return sessionOp as Promise<XueqiuSessionResult>;
}

/**
 * 手动粘贴 Cookie 入口：注入真浏览器会话并在会话内校验（服务端直连必被 WAF 拦，
 * 不再做 Node 校验），通过后持久化。
 */
export async function verifyAndSaveXueqiuCookie(cookie: string): Promise<XueqiuSessionResult> {
  const trimmed = cookie.trim();
  if (!trimmed) return { ok: false, message: "Cookie 为空" };
  if (!trimmed.includes("xq_a_token")) return { ok: false, message: "Cookie 中未找到 xq_a_token，请复制登录后的完整 Cookie" };
  await stopXueqiuLiveSession();
  persistXueqiuCookie(trimmed);
  const established = await ensureXueqiuLiveSession(trimmed);
  if (!established) {
    return { ok: false, message: "Cookie 已保存，但真浏览器校验未通过（可能已过期或触发风控），请重新获取后重试" };
  }
  return { ok: true, message: "雪球会话已保存并生效" };
}

/**
 * 独立校验入口（scripts/verify-xueqiu-cookie.ts）：把 Cookie 注入真浏览器做页内校验，
 * 校验完即关闭，不影响常驻会话，也不做服务端 Node 直连（直连必被 WAF 拦）。
 */
export async function verifyXueqiuCookieStandalone(cookie: string): Promise<XueqiuSessionResult> {
  const trimmed = cookie.trim();
  if (!trimmed) return { ok: false, message: "Cookie 为空" };
  if (!trimmed.includes("xq_a_token")) return { ok: false, message: "Cookie 中未找到 xq_a_token，请复制登录后的完整 Cookie" };
  const context = await launchRealChrome(true);
  try {
    await applyAntiDetect(context);
    await seedXueqiuCookies(context, trimmed);
    const page = context.pages()[0] ?? (await context.newPage());
    try {
      await page.goto("https://xueqiu.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch {
      // 首页打开失败也继续探测
    }
    const ready = await waitForSessionReady(page, 3, 4_000);
    if (!ready.ok) return { ok: false, message: ready.message };
    return { ok: true, message: "会话有效（真浏览器校验通过）" };
  } finally {
    await forceCloseContext(context);
  }
}

/**
 * 一条命令（pnpm xueqiu:session）导入：会话已在用户日常浏览器里校验通过，
 * 直接持久化，并尽力在后台建立真浏览器抓取会话（无头优先，失败不阻塞导入结果）。
 */
export async function importXueqiuCookieVerified(cookie: string): Promise<XueqiuSessionResult> {
  const trimmed = cookie.trim();
  if (!trimmed) return { ok: false, message: "Cookie 为空" };
  persistXueqiuCookie(trimmed);
  const established = await ensureXueqiuLiveSession(trimmed);
  if (established) return { ok: true, message: "雪球会话已导入，真浏览器抓取会话已建立" };
  return { ok: true, message: "雪球会话已导入；真浏览器抓取会话暂未建立，下一轮刷新会自动重试" };
}
