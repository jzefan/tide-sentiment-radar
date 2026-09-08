/**
 * 本机雪球同步脚本（推送为主方案的核心）。
 *
 * 远程无头服务器无法稳定直连雪球（WAF / 机房 IP / 无 GUI），因此由「本机」这个
 * 已经能连通雪球的受信任浏览器负责抓取，再把讨论推送到部署服务器，服务器只接收、
 * 存储、展示，自身完全不碰雪球域名。脚本复用服务端同款 fetchXueqiu（含真浏览器会话）。
 *
 * 用法：
 *   pnpm xueqiu:sync                                      推送一次（目标取自 XUEQIU_SERVER_URL）
 *   XUEQIU_SERVER_URL=http://218.244.152.142:20085 pnpm xueqiu:sync
 *   XUEQIU_SYNC_CODES=600519,300750 pnpm xueqiu:sync      # 指定股票（覆盖自选股）
 *
 * 定时：用 cron / launchd 每 5 分钟跑一次即可保持服务器雪球数据新鲜。
 *   macOS launchd 示例（每 5 分钟）：见脚本底部说明。
 *
 * 凭据：
 *   本机 .env 需设置 XUEQIU_SYNC_TOKEN（与服务器 .env 中 XUEQIU_SYNC_TOKEN 一致）。
 *   本机还需已通过 pnpm xueqiu:session 或页面「连接雪球」建立本地会话（data/xueqiu-cookie.txt）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchXueqiu } from "../server/userPosts.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** 读取本机 .env（仅填充尚未在环境中存在的键），避免在本地也装 dotenv 依赖。 */
function loadLocalEnv(): void {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!match) continue;
      const key = match[1];
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // 读取失败不阻断
  }
}

const DEFAULT_CODES = ["300308", "688256", "601138", "600519", "002594"];

function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

async function resolveCodes(serverUrl: string): Promise<string[]> {
  const override = (process.env.XUEQIU_SYNC_CODES ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter((code) => /^\d{6}$/.test(code));
  if (override.length) return override.slice(0, 20);

  // 优先用服务器上的自选股作为抓取范围；不可达则退回默认列表。
  try {
    const response = await fetch(`${serverUrl}/api/watchlist`, { signal: AbortSignal.timeout(8_000) });
    if (response.ok) {
      const data = await response.json() as { codes?: unknown };
      const codes = Array.isArray(data.codes) ? (data.codes as unknown[]).map(String).filter((code) => /^\d{6}$/.test(code)) : [];
      if (codes.length) return codes.slice(0, 20);
    }
  } catch {
    // 服务器不可达，退回默认列表
  }
  return DEFAULT_CODES;
}

async function main() {
  loadLocalEnv();

  const serverUrl = (process.env.XUEQIU_SERVER_URL || "http://127.0.0.1:8788").replace(/\/+$/, "");
  const token = process.env.XUEQIU_SYNC_TOKEN?.trim();
  if (!token) {
    fail("未设置 XUEQIU_SYNC_TOKEN。请将其设为与服务器 .env 中 XUEQIU_SYNC_TOKEN 相同的值（deploy.sh 部署后会回显该令牌）。");
  }

  const codes = await resolveCodes(serverUrl);
  console.log(`抓取雪球讨论（${codes.length} 只）：`, codes.join(", "));

  let items;
  try {
    items = await fetchXueqiu(codes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`本机抓取失败：${message}。请确认已运行 pnpm xueqiu:session 或页面「连接雪球」建立本地会话。`);
  }
  if (!items.length) {
    console.log("本次未抓到雪球讨论（可能会话过期或未登录）。可重新运行 pnpm xueqiu:session 后重试。");
    return;
  }

  console.log(`抓到 ${items.length} 条，推送到 ${serverUrl} …`);
  const response = await fetch(`${serverUrl}/api/xueqiu/push`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sync-token": token },
    body: JSON.stringify({ items }),
    signal: AbortSignal.timeout(20_000),
  }).catch((error) => {
    fail(`推送请求失败：${error instanceof Error ? error.message : String(error)}`);
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    fail(`推送被拒绝（${response.status}）：${JSON.stringify(payload)}`);
  }
  const payload = await response.json() as { accepted?: number; saved?: number };
  console.log(`✅ 已推送 ${payload.accepted ?? items.length} 条雪球讨论到服务器（入库 ${payload.saved ?? 0} 条）。`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));

/*
 * macOS 定时（launchd）示例：每 5 分钟推送一次。
 * 1) 写 ~/Library/LaunchAgents/com.tide.xueqiu-sync.plist，ProgramArguments 为：
 *      /usr/bin/env XUEQIU_SERVER_URL=http://218.244.152.142:20085 XUEQIU_SYNC_TOKEN=<令牌> \
 *      <项目根>/node_modules/.bin/tsx <项目根>/scripts/sync-xueqiu.ts
 *    并设 StartInterval 为 300。
 * 2) launchctl load ~/Library/LaunchAgents/com.tide.xueqiu-sync.plist
 */
