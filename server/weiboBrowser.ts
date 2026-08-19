/**
 * 微博讨论抓取的浏览器会话（匿名即可，无需登录）。
 *
 * 实测结论（本机验证）：
 *  - m.weibo.cn 的搜索接口（container/getIndex，containerid=100103type=1&q=关键词）
 *    在真实 Chromium 页面内同源 fetch 即可访问：页面首次加载会写入匿名访客
 *    SUB / XSRF-TOKEN Cookie，带上 x-xsrf-token 请求头即返回 ok:1 + 结果卡片；
 *  - 并发批量搜索不触发限流，但偶发 total:0 空结果，需对空结果重试一次；
 *  - 每页约 2 条结果，按综合排序，约半数在 72 小时窗口内（由调用方过滤）。
 *
 * 会话管理沿用雪球的成熟模式：真实 Chrome + 持久化档案（data/weibo-chrome-profile，
 * 匿名令牌跨进程/重启保留）、无头优先 + 有头兜底、全程有界（关闭超时强杀、
 * 建会话看门狗、失败冷却），任何情况下都不会让调用方无限等待。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { diagLog } from "./diagLog.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const WEIBO_PROFILE_DIR = join(root, "data", "weibo-chrome-profile");
/** 档案占用锁：记录持有者 PID，防止服务器与同步脚本等进程互相抢杀浏览器。 */
const WEIBO_PROFILE_LOCK = join(root, "data", "weibo-chrome-profile.lock");
const REAL_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PLAYWRIGHT_CACHE_ROOTS = process.platform === "darwin"
  ? [join(homedir(), "Library", "Caches", "ms-playwright")]
  : [join(homedir(), ".cache", "ms-playwright")];
const LINUX_CHROME_PATHS = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
];
/** 建立会话的整体硬上限：到点即强杀所有新建浏览器。 */
const SESSION_OP_TIMEOUT_MS = 120_000;
/** context.close() 的宽限：浏览器迟迟不退时强杀进程。 */
const CLOSE_GRACE_MS = 8_000;
/** 连续失败冷却：10 分钟内不再开窗重试。 */
const ENSURE_COOLDOWN_MS = 10 * 60_000;
/** 页面加载后给 JS 写入访客令牌的宽限时间。 */
const PAGE_SETTLE_MS = 4_000;

const SEARCH_BASE = "https://m.weibo.cn/api/container/getIndex";
/** 探针关键词：验证搜索接口可用。 */
const PROBE_KEYWORD = "贵州茅台";

interface LiveSession {
  context: BrowserContext;
  page: Page;
  startedAt: number;
}

let liveSession: LiveSession | null = null;
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

function lockOwner(): number | null {
  try {
    const pid = Number(readFileSync(WEIBO_PROFILE_LOCK, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writeLock(): void {
  try {
    mkdirSync(dirname(WEIBO_PROFILE_LOCK), { recursive: true });
    writeFileSync(WEIBO_PROFILE_LOCK, String(process.pid), "utf8");
  } catch {
    // 锁写失败不阻断
  }
}

function releaseLock(): void {
  try {
    rmSync(WEIBO_PROFILE_LOCK, { force: true });
  } catch {
    // 忽略
  }
}

/** 只清理孤儿进程（父进程已退出）；另一个存活进程持档时由调用方报错。 */
function releaseProfileLock(): void {
  try {
    const out = spawnSync("pgrep", ["-f", "weibo-chrome-profile"], { encoding: "utf8" });
    for (const line of out.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      let ppid = -1;
      try {
        const parent = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
        ppid = Number(parent.stdout.trim());
      } catch {
        // ps 不可用：按孤儿处理
      }
      if (ppid === process.pid) continue;
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
      rmSync(join(WEIBO_PROFILE_DIR, name), { force: true });
    } catch {
      // 锁文件不存在时忽略
    }
  }
  const owner = lockOwner();
  if (owner !== null && owner !== process.pid) {
    try {
      process.kill(owner, 0);
    } catch {
      releaseLock();
    }
  }
}

function browserProcessOf(context: BrowserContext): import("node:child_process").ChildProcess | null {
  try {
    const browser = context.browser();
    if (!browser) return null;
    const withProcess = browser as unknown as { process?: () => import("node:child_process").ChildProcess | null };
    return typeof withProcess.process === "function" ? withProcess.process() : null;
  } catch {
    return null;
  }
}

/** 有界关闭：宽限期内不退则强杀进程（playwright 的 close 没有超时）。 */
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
  diagLog("weibo", "forceClose 完成", closed ? "正常关闭" : "超时强杀", proc?.pid ?? "");
}

/** 启动真实 Chrome（微博持久化档案）。headless=false 时开可见窗口供用户手动过验证。 */
async function launchWeiboChrome(headless: boolean): Promise<BrowserContext> {
  mkdirSync(WEIBO_PROFILE_DIR, { recursive: true });
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
      throw new Error(`微博浏览器档案正被另一个进程（PID ${owner}）使用：请先停止它再重试`);
    }
    releaseLock();
  }
  writeLock();
  const args = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    ...(process.env.XUEQIU_DIRECT === "1" ? ["--no-proxy-server"] : []),
  ];
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
        return await chromium.launchPersistentContext(WEIBO_PROFILE_DIR, { ...options, ...candidate });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (!/already in use|ProcessSingleton|user data directory|Singleton/i.test(lastError.message)) throw lastError;
      }
    }
    releaseProfileLock();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw lastError ?? new Error("微博专用浏览器档案被占用，请先关闭相关窗口后重试");
}

async function applyAntiDetect(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
}

/** 微博是否可抓（本机有可用浏览器）。 */
export function isWeiboBrowserAvailable(): boolean {
  if (process.platform === "darwin" && existsSync(REAL_CHROME)) return true;
  if (process.platform === "linux" && LINUX_CHROME_PATHS.some((path) => existsSync(path))) return true;
  return Boolean(findChromiumExecutable());
}

/** 常驻微博浏览器会话是否可用。 */
export function isWeiboLiveReady(): boolean {
  return Boolean(liveSession);
}

/** 主动关闭常驻会话（有界）。 */
export async function stopWeiboLiveSession(): Promise<void> {
  const session = liveSession;
  liveSession = null;
  if (session) await forceCloseContext(session.context);
}

/**
 * 重置微博档案：访客 SUB 令牌被风控标记后，整个档案（含令牌）作废，
 * 删除后下一轮会以全新档案重建（新访客令牌）。实测被标记后重导航无法恢复。
 */
export async function wipeWeiboProfile(): Promise<void> {
  await stopWeiboLiveSession();
  try {
    rmSync(WEIBO_PROFILE_DIR, { recursive: true, force: true });
  } catch {
    // 删除失败不阻断
  }
  releaseLock();
  diagLog("weibo", "档案已重置（访客令牌被风控，下一轮将重建新档案）");
}

async function adoptSession(context: BrowserContext): Promise<void> {
  const page = context.pages()[0] ?? (await context.newPage());
  liveSession = { context, page, startedAt: Date.now() };
  context.on("close", () => {
    liveSession = null;
  });
}

async function pickWeiboPage(): Promise<Page> {
  if (!liveSession) throw new Error("微博浏览器会话不可用");
  const existing = liveSession.context.pages().find((page) => page.url().startsWith("https://m.weibo.cn"));
  if (existing) return existing;
  const page = liveSession.context.pages()[0];
  if (page) {
    await gotoWeiboHome(page);
    return page;
  }
  const fresh = await liveSession.context.newPage();
  await gotoWeiboHome(fresh);
  return fresh;
}

export interface WeiboMblog {
  id: string;
  bid: string;
  text: string;
  created_at: string;
  user_id: number;
  screen_name: string;
  reposts_count: number;
  comments_count: number;
  attitudes_count: number;
}

export interface WeiboSearchResult {
  keyword: string;
  ok: boolean;
  total: number;
  mblogs: WeiboMblog[];
  error?: string;
}

/**
 * 在页面内批量搜索关键词（并发），返回每个关键词的结果。
 * 注意：playwright 的 page.evaluate 没有超时，必须用 Promise.race 硬超时兜底。
 */
async function searchInPage(page: Page, keywords: string[]): Promise<WeiboSearchResult[]> {
  const results = (await Promise.race([
    page.evaluate(async (kws) => {
      let xsrf = "";
      try {
        xsrf = document.cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("XSRF-TOKEN="))
          ?.split("=").slice(1).join("=") ?? "";
      } catch {
        // 页面不在微博域（如错误页）：cookie 不可读，按请求失败处理，由调用方恢复页面后重试。
      }
      const out: Array<Record<string, unknown>> = [];
      await Promise.all(kws.map(async (kw) => {
        try {
          const q = encodeURIComponent(kw);
          const resp = await fetch(`https://m.weibo.cn/api/container/getIndex?containerid=100103type%3D1%26q%3D${q}&page_type=searchall`, {
            headers: { "x-xsrf-token": xsrf, accept: "application/json, text/plain, */*", "mweibo-pwa": "1" },
            signal: AbortSignal.timeout(10_000),
          });
          const data = (await resp.json()) as {
            ok?: number;
            data?: { cards?: Array<Record<string, unknown>>; cardlistInfo?: { total?: number } };
          };
          const cards = (data?.data?.cards ?? []) as Array<Record<string, unknown>>;
          const mblogs = cards
            .filter((card) => card?.card_type === 9 && card?.mblog)
            .map((card) => {
              const mblog = card.mblog as Record<string, unknown>;
              const user = (mblog.user ?? {}) as Record<string, unknown>;
              return {
                id: String(mblog.id ?? ""),
                bid: String(mblog.bid ?? ""),
                text: String(mblog.text ?? ""),
                created_at: String(mblog.created_at ?? ""),
                user_id: Number(user.id ?? 0),
                screen_name: String(user.screen_name ?? ""),
                reposts_count: Number(mblog.reposts_count ?? 0),
                comments_count: Number(mblog.comments_count ?? 0),
                attitudes_count: Number(mblog.attitudes_count ?? 0),
              };
            });
          out.push({ keyword: kw, ok: data?.ok === 1, total: Number(data?.data?.cardlistInfo?.total ?? 0), mblogs });
        } catch (error) {
          out.push({ keyword: kw, ok: false, total: 0, mblogs: [], error: error instanceof Error ? error.message.slice(0, 80) : String(error) });
        }
      }));
      return out;
    }, keywords),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("PAGE_EVALUATE_TIMEOUT：微博页面无响应")), 20_000);
    }),
  ])) as Array<Record<string, unknown>>;
  return results as unknown as WeiboSearchResult[];
}

/** 探针：验证当前会话的搜索接口可用。 */
async function probeWeiboSession(page: Page): Promise<{ ok: boolean; message: string }> {
  try {
    const results = await searchInPage(page, [PROBE_KEYWORD]);
    const result = results[0];
    if (result.ok && result.mblogs.length > 0) return { ok: true, message: "微博搜索接口可用" };
    if (result.error) return { ok: false, message: `微博搜索失败：${result.error}` };
    return { ok: false, message: "微博搜索未返回结果" };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    if (raw.includes("PAGE_EVALUATE_TIMEOUT")) return { ok: false, message: "微博页面无响应" };
    return { ok: false, message: "微博探针失败，请稍后重试" };
  }
}

/** 等待访客令牌就绪并完成探针；失败时重新导航（走完访客验证流程）后重试。 */
async function waitForWeiboReady(page: Page, attempts = 3, intervalMs = 4_000): Promise<{ ok: boolean; message: string }> {
  let last = "会话校验未通过";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const probe = await probeWeiboSession(page);
    if (probe.ok) return { ok: true, message: probe.message };
    last = probe.message;
    diagLog("weibo", `探针第 ${attempt + 1} 次失败:`, probe.message, "url =", page.url().slice(0, 70));
    // 页面可能还停在访客验证页/被导航走：重新导航一次，让它走完验证流程。
    await gotoWeiboHome(page);
    await page.waitForTimeout(intervalMs);
  }
  return { ok: false, message: last };
}

/** 建立常驻微博浏览器会话：无头优先，失败开可见窗口兜底；全程有界。 */
export function ensureWeiboLiveSession(): Promise<boolean> {
  if (isWeiboLiveReady()) return Promise.resolve(true);
  if (sessionOp) return sessionOp.then(() => isWeiboLiveReady());
  if (Date.now() - lastEnsureFailureAt < ENSURE_COOLDOWN_MS) {
    diagLog("weibo", "ensure: 冷却期内，跳过");
    return Promise.resolve(false);
  }
  diagLog("weibo", "ensure: 开始建立会话");
  sessionOp = establishSession()
    .then(() => {
      if (!isWeiboLiveReady()) lastEnsureFailureAt = Date.now();
    })
    .catch(() => {
      lastEnsureFailureAt = Date.now();
    })
    .finally(() => {
      sessionOp = null;
    });
  return sessionOp.then(() => isWeiboLiveReady());
}

async function establishSession(): Promise<void> {
  const opened: BrowserContext[] = [];
  let timeoutHit = false;
  const watchdog = new Promise<void>((resolve) => {
    setTimeout(() => {
      timeoutHit = true;
      for (const context of opened) void forceCloseContext(context);
      resolve();
    }, SESSION_OP_TIMEOUT_MS);
  });

  const work = (async () => {
    diagLog("weibo", "establish: 启动无头 Chrome…");
    const headlessContext = await launchWeiboChrome(true);
    opened.push(headlessContext);
    diagLog("weibo", "establish: 无头 Chrome 已启动");
    await applyAntiDetect(headlessContext);
    const headlessPage = headlessContext.pages()[0] ?? (await headlessContext.newPage());
    await gotoWeiboHome(headlessPage);
    await headlessPage.waitForTimeout(PAGE_SETTLE_MS);
    const headlessReady = await waitForWeiboReady(headlessPage, 3, 4_000);
    diagLog("weibo", "establish: 无头探针", headlessReady.message);
    if (headlessReady.ok && !timeoutHit) {
      await adoptSession(headlessContext);
      diagLog("weibo", "establish: 无头会话已接管");
      return;
    }
    await forceCloseContext(headlessContext);
    if (timeoutHit) return;

    diagLog("weibo", "establish: 启动有头 Chrome…");
    const headedContext = await launchWeiboChrome(false);
    opened.push(headedContext);
    await applyAntiDetect(headedContext);
    const headedPage = headedContext.pages()[0] ?? (await headedContext.newPage());
    await gotoWeiboHome(headedPage);
    await headedPage.waitForTimeout(PAGE_SETTLE_MS);
    const headedReady = await waitForWeiboReady(headedPage, 5, 8_000);
    diagLog("weibo", "establish: 有头探针", headedReady.message);
    if (headedReady.ok && !timeoutHit) {
      await adoptSession(headedContext);
      diagLog("weibo", "establish: 有头会话已接管");
      return;
    }
    await forceCloseContext(headedContext);
    throw new Error(headedReady.message);
  })();

  await Promise.race([work, watchdog]);
  diagLog("weibo", "establish: 结束，已接管 =", isWeiboLiveReady());
}

/** 打开微博首页并确认停留在 m.weibo.cn 域；失败自动重试最多 3 次（页面加载偶发错误码）。 */
async function gotoWeiboHome(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto("https://m.weibo.cn/", { waitUntil: "domcontentloaded", timeout: 20_000 });
      if (page.url().startsWith("https://m.weibo.cn")) return;
    } catch {
      // 网络或站点偶发错误：稍等后重试
    }
    await page.waitForTimeout(2_000);
  }
}

/** 确保页面停留在 m.weibo.cn 域（页面可能被导航到登录/错误页，此时 cookie 不可读）。 */
async function ensureWeiboOrigin(page: Page): Promise<void> {
  if (page.url().startsWith("https://m.weibo.cn")) return;
  await gotoWeiboHome(page);
}

/**
 * 批量搜索微博讨论（一批关键词，并发执行）。返回每个关键词的结果；
 * 调用方负责按预算分批次调用与 72 小时窗口过滤。容错：
 *  - 页面被导航走/卡死导致整批失败时，回到微博首页后整批重试一次；
 *  - 空结果（total:0）是搜索接口的已知抖动，对空结果自动重试一次。
 */
export async function fetchWeiboSearch(keywords: string[]): Promise<WeiboSearchResult[]> {
  if (!liveSession) throw new Error("微博浏览器会话不可用");
  const startedAt = Date.now();
  const page = await pickWeiboPage();
  await ensureWeiboOrigin(page);
  let results = await searchInPage(page, keywords).catch(() => null);
  if (!results) {
    // 页面无响应/被导航走：回首页后整批重试一次。
    diagLog("weibo", "批次失败，回到首页重试", keywords[0] ?? "");
    await ensureWeiboOrigin(page);
    results = await searchInPage(page, keywords).catch(() => null);
  }
  const elapsed = Date.now() - startedAt;
  // 只记录异常慢的批次（>5 秒），正常批次不刷屏。
  if (elapsed > 5_000) {
    diagLog("weibo", "批内耗时", `${elapsed}ms`, "关键词:", keywords.join("、"));
  }
  if (!results) {
    // 页面持续无响应：多半是访客令牌已被风控标记（重导航也无法恢复），
    // 让调用方重置档案、换新令牌。
    throw new Error("WEIBO_SESSION_BLOCKED：微博会话被风控拦截，请重置档案");
  }

  // 空结果重试一次（避开搜索接口偶发的 total:0 抖动）。
  const empty = results.filter((result) => result.ok && result.mblogs.length === 0);
  if (empty.length) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const retried = await searchInPage(page, empty.map((result) => result.keyword)).catch(() => []);
    const retryMap = new Map(retried.map((result) => [result.keyword, result]));
    for (const result of results) {
      if (result.ok && result.mblogs.length === 0) {
        const replacement = retryMap.get(result.keyword);
        if (replacement && replacement.ok && replacement.mblogs.length > 0) {
          result.total = replacement.total;
          result.mblogs = replacement.mblogs;
        }
      }
    }
  }
  return results;
}
