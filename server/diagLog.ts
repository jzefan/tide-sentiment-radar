/**
 * 轻量诊断日志：同时输出到控制台与 data/server-diag.log。
 * 用于排查行情/讨论/雪球管线卡点（每个阶段的进入与完成时间都落盘）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const FILE = join(root, "data", "server-diag.log");

export function diagLog(scope: string, ...parts: unknown[]): void {
  const line = `[${scope}] ${new Date().toISOString().slice(11, 19)} ${parts
    .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
    .join(" ")}`;
  console.log(line);
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    appendFileSync(FILE, `${line}\n`);
  } catch {
    // 日志写入失败不阻断
  }
}
