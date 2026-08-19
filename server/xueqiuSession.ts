/**
 * 雪球会话持久化：只负责内存缓存与本地文件（data/xueqiu-cookie.txt，本机，不入 git）。
 *
 * 有效性校验与数据抓取统一走真浏览器（见 xueqiuBrowser.ts）：实测雪球接口由
 * 阿里云 WAF 保护，服务端 Node 直连（即使携带完整 Cookie）必然命中挑战页，
 * 因此本文件不再做任何直连校验，只承载会话的加载与保存。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sessionFile = join(root, "data", "xueqiu-cookie.txt");

let sessionCookie: string | null = null;

/** 服务启动时调用：优先加载本地持久化的会话，其次环境变量。 */
export function loadXueqiuCookie(): string | null {
  if (sessionCookie) return sessionCookie;
  try {
    const stored = readFileSync(sessionFile, "utf8").trim();
    if (stored) {
      sessionCookie = stored;
      return sessionCookie;
    }
  } catch {
    // 文件不存在则回退环境变量
  }
  sessionCookie = process.env.XUEQIU_COOKIE?.trim() ?? null;
  return sessionCookie;
}

export function getXueqiuCookie(): string | null {
  return sessionCookie ?? loadXueqiuCookie();
}

/** 保存已通过真浏览器校验的会话（内存 + 本地文件，不入 git）。 */
export function persistXueqiuCookie(cookie: string): void {
  const trimmed = cookie.trim();
  if (!trimmed) return;
  sessionCookie = trimmed;
  try {
    mkdirSync(dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, trimmed, "utf8");
  } catch {
    // 持久化失败不阻断本次会话
  }
}
