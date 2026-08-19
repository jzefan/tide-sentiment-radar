/**
 * 从本机已登录的浏览器（Chrome / Edge / Brave / Chromium）读取雪球会话并保存，
 * 供服务端建立真浏览器抓取会话。用法：
 *
 *   pnpm xueqiu:session                    自动检测浏览器与配置目录并导入
 *   pnpm xueqiu:session --browser chrome   指定浏览器
 *   pnpm xueqiu:session --profile "Profile 1"   指定浏览器配置目录
 *   pnpm xueqiu:session --quit             不询问，自动退出浏览器后继续
 *   pnpm xueqiu:session --no-reopen        读取后不重新打开浏览器
 *   pnpm xueqiu:session --dry-run          只检测目标浏览器与会话，不退出、不读取
 *
 * 前提：先用你的常用浏览器打开 https://xueqiu.com 并登录雪球。
 * 说明：读取会话需要浏览器完全退出（配置目录被占用时无法以调试方式启动），
 * 完成后会自动重新打开浏览器，恢复你的正常浏览状态。
 */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { probeXueqiuSessionInBrowser } from "../server/xueqiuBrowser.ts";

interface BrowserTarget {
  key: string;
  label: string;
  /** osascript 退出应用时使用的应用名。 */
  appName: string;
  executablePath: string;
  profileRoot: string;
}

const BROWSERS: BrowserTarget[] = [
  { key: "chrome", label: "Chrome", appName: "Google Chrome", executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", profileRoot: join(homedir(), "Library/Application Support/Google/Chrome") },
  { key: "edge", label: "Edge", appName: "Microsoft Edge", executablePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", profileRoot: join(homedir(), "Library/Application Support/Microsoft Edge") },
  { key: "brave", label: "Brave", appName: "Brave Browser", executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", profileRoot: join(homedir(), "Library/Application Support/BraveSoftware/Brave-Browser") },
  { key: "chromium", label: "Chromium", appName: "Chromium", executablePath: "/Applications/Chromium.app/Contents/MacOS/Chromium", profileRoot: join(homedir(), "Library/Application Support/Chromium") },
];

const SESSION_FILE = fileURLToPath(new URL("../data/xueqiu-cookie.txt", import.meta.url));

function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

/** 扫描浏览器各配置目录的 Cookie 数据库（host_key 为明文），找出含雪球会话的目录。 */
function profilesWithXueqiuCookies(profileRoot: string): string[] {
  if (!existsSync(profileRoot)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(profileRoot).filter((name) => name === "Default" || /^Profile \d+$/.test(name));
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    // 不同 Chrome 版本 Cookie 库位置不同：新版本在 Network/Cookies，旧版本直接在配置目录下。
    const dbPaths = [join(profileRoot, entry, "Network", "Cookies"), join(profileRoot, entry, "Cookies")];
    for (const dbPath of dbPaths) {
      if (!existsSync(dbPath)) continue;
      // 浏览器运行中数据库可能被占用：复制快照后只读查询，不碰原文件。
      const snapshot = join(tmpdir(), `xq-cookies-${process.pid}-${Date.now()}-${entry.replace(/\W/g, "")}.sqlite`);
      try {
        copyFileSync(dbPath, snapshot);
        const count = Number(
          execFileSync("/usr/bin/sqlite3", [snapshot, "SELECT count(*) FROM cookies WHERE host_key LIKE '%xueqiu.com';"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim() || "0",
        );
        if (count > 0) found.push(entry);
      } catch {
        // 读取失败：跳过该配置目录
      } finally {
        rmSync(snapshot, { force: true });
      }
      if (found.includes(entry)) break;
    }
  }
  return found;
}

function isBrowserRunning(target: BrowserTarget): boolean {
  const result = spawnSync("pgrep", ["-f", target.executablePath], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function quitBrowser(appName: string): Promise<void> {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", `tell application "${appName}" to quit`], () => resolve());
  });
}

async function waitUntilGone(target: BrowserTarget, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isBrowserRunning(target)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return !isBrowserRunning(target);
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

interface Hit {
  browser: BrowserTarget;
  profile: string;
}

function score(hit: Hit): number {
  const rank = hit.browser.key === "chrome" ? 0 : hit.browser.key === "edge" ? 1 : hit.browser.key === "brave" ? 2 : 3;
  return rank * 10 + (hit.profile === "Default" ? 0 : 1);
}

/** 页内校验会话；刚启动时 WAF 挑战可能尚未完成，最多轮询 3 次。 */
async function verifyInUserBrowser(page: Page): Promise<{ ok: boolean; message: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const probe = await probeXueqiuSessionInBrowser(page);
    if (probe.ok) return { ok: true, message: probe.message };
    if (probe.reason !== "challenge") return { ok: false, message: probe.message };
    await page.waitForTimeout(5_000);
  }
  return { ok: false, message: "雪球风控挑战未通过，请稍后重试" };
}

async function applyToRunningServer(cookie: string, apiPort: string): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/xueqiu/cookie/browser-verified`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie }),
      // 服务端首次建立真浏览器会话（含无头→有头重试）可能耗时较长。
      signal: AbortSignal.timeout(60_000),
    });
    if (response.ok) {
      const payload = await response.json() as { message?: string };
      console.log(`已应用到运行中的服务：${payload.message ?? "ok"}。`);
    } else {
      console.log("本地服务未返回成功（可能未启动）；会话已保存，服务启动时会自动加载。");
    }
  } catch {
    console.log("未检测到运行中的本地服务；会话已保存，服务启动时会自动加载。");
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (flag(args, "--help") || flag(args, "-h")) {
    console.log(`用法：pnpm xueqiu:session [选项]

从本机已登录雪球的浏览器读取会话并保存到 data/xueqiu-cookie.txt。

选项：
  --browser <chrome|edge|brave|chromium>  指定浏览器
  --profile <目录名>                       指定浏览器配置目录（如 "Profile 1"）
  --quit                                   自动退出浏览器后继续（不询问）
  --no-reopen                              读取后不重新打开浏览器
  --dry-run                                只检测目标浏览器与会话，不退出、不读取
  --port <端口>                            本地服务端口（默认 8787）
`);
    return;
  }
  const browserKey = value(args, "--browser");
  const profileArg = value(args, "--profile");
  const quitFlag = flag(args, "--quit");
  const noReopen = flag(args, "--no-reopen");
  const dryRun = flag(args, "--dry-run");
  const apiPort = value(args, "--port") ?? process.env.API_PORT ?? "8787";

  const installed = BROWSERS.filter((target) => existsSync(target.executablePath));
  if (browserKey && !installed.some((target) => target.key === browserKey)) {
    fail(`未找到 ${browserKey} 浏览器，请确认已安装`);
  }
  if (!installed.length) {
    fail("未检测到 Chrome / Edge / Brave / Chromium。请先用其中任意一个浏览器登录 https://xueqiu.com 再运行本命令。");
  }

  const hits: Hit[] = [];
  const scope = browserKey ? installed.filter((target) => target.key === browserKey) : installed;
  for (const target of scope) {
    for (const profile of profilesWithXueqiuCookies(target.profileRoot)) hits.push({ browser: target, profile });
  }

  let chosen: Hit;
  if (profileArg) {
    const match = hits.find((hit) => hit.profile === profileArg);
    if (!match) fail(`配置目录 ${profileArg} 中没有找到雪球会话${browserKey ? `（浏览器 ${browserKey}）` : ""}`);
    chosen = match;
  } else if (hits.length) {
    chosen = hits.sort((a, b) => score(a) - score(b))[0];
    if (hits.length > 1) {
      console.log(`检测到 ${hits.length} 个含雪球会话的浏览器配置，使用 ${chosen.browser.label} / ${chosen.profile}（可用 --browser / --profile 指定）。`);
    }
  } else {
    fail("未检测到已登录雪球的浏览器会话。请先用 Chrome / Edge / Brave 打开 https://xueqiu.com 并登录，再运行本命令。");
  }

  console.log(`目标：${chosen.browser.label} · 配置目录 ${chosen.profile}${dryRun ? "（--dry-run，不执行）" : ""}`);
  const running = isBrowserRunning(chosen.browser);
  if (dryRun) {
    console.log(`${chosen.browser.label} ${running ? "正在运行（读取前会先退出）" : "未运行"}；会话将保存到 data/xueqiu-cookie.txt。`);
    return;
  }

  if (running && !quitFlag) {
    console.log(`${chosen.browser.label} 正在运行。读取会话需要先完全退出浏览器（Cmd+Q），完成后会自动重新打开。`);
    if (!process.stdin.isTTY) {
      fail("无法交互确认。请手动退出浏览器后重试，或加 --quit 自动退出。");
    }
    const answer = await ask("是否自动退出浏览器并继续？（退出前请保存浏览器里的工作）[y/N] ");
    if (!/^y/i.test(answer)) {
      console.log("已取消。请退出浏览器后重新运行 pnpm xueqiu:session。");
      return;
    }
  }
  if (running) {
    console.log(`正在退出 ${chosen.browser.label} …`);
    await quitBrowser(chosen.browser.appName);
    if (!(await waitUntilGone(chosen.browser, 15_000))) {
      fail(`${chosen.browser.label} 未能完全退出，请手动 Cmd+Q 后重试。`);
    }
  }

  console.log(`启动 ${chosen.browser.label} 读取雪球会话…（会打开一个窗口，完成后自动关闭）`);
  const launchArgs = ["--no-first-run", "--disable-blink-features=AutomationControlled"];
  if (chosen.profile !== "Default") launchArgs.push(`--profile-directory=${chosen.profile}`);
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(chosen.browser.profileRoot, {
      executablePath: chosen.browser.executablePath,
      headless: false,
      viewport: null,
      args: launchArgs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`启动浏览器失败：${message}。请确认浏览器已完全退出后重试。`);
  }

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://xueqiu.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(4_000);
    const cookies = await context.cookies("https://xueqiu.com");
    const token = cookies.find((cookie) => cookie.name === "xq_a_token" && cookie.value);
    if (!token) fail("该浏览器当前未登录雪球，请先打开 https://xueqiu.com 登录后重试。");

    const verified = await verifyInUserBrowser(page);
    if (!verified.ok) fail(`会话校验未通过：${verified.message}`);

    const cookieString = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    mkdirSync(dirname(SESSION_FILE), { recursive: true });
    writeFileSync(SESSION_FILE, cookieString, "utf8");
    console.log(`✅ 雪球会话已保存到 data/xueqiu-cookie.txt（${cookies.length} 个 Cookie），校验通过。`);

    await applyToRunningServer(cookieString, apiPort);
  } finally {
    // 有界关闭：浏览器迟迟不退（如页面卡死）则强杀进程，避免命令挂起、
    // 也避免给用户真实配置目录留下僵尸进程占用锁。
    let proc: import("node:child_process").ChildProcess | null = null;
    try {
      const browser = context.browser();
      const withProcess = browser as unknown as { process?: () => import("node:child_process").ChildProcess | null };
      if (browser && typeof withProcess.process === "function") proc = withProcess.process();
    } catch {
      proc = null;
    }
    const closed = await Promise.race([
      context.close().then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);
    if (!closed && proc && proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // 进程已退出
      }
    }
  }

  if (!noReopen) {
    console.log(`重新打开 ${chosen.browser.label}，恢复你的正常浏览状态…`);
    spawnSync("open", ["-a", chosen.browser.appName]);
  }
  console.log("完成。若服务已运行，雪球讨论会在下一轮刷新（默认 5 分钟内）接入；也可在页面点击“重新连接全部来源”。");
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
