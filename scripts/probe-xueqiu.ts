/**
 * 雪球抓取探测脚本：实测「股票名全站关键词搜索」与「个股时间线」两种抓法各能返回多少条，
 * 用于在启用 XUEQIU_FETCH_ENABLED 之前评估雪球数据的覆盖量，并校验会话是否有效。
 *
 * 用法：
 *   pnpm xueqiu:probe
 * 前提：已运行 pnpm xueqiu:session（或页面「连接雪球」/ 配置 XUEQIU_COOKIE）。
 */
import { getXueqiuCookie } from "../server/xueqiuSession.ts";
import {
  ensureXueqiuLiveSession,
  fetchXueqiuTimelineInBrowser,
  isXueqiuLiveReady,
  stopXueqiuLiveSession,
} from "../server/xueqiuBrowser.ts";
import { toXueqiuSymbol, xueqiuEndpointsForKeyword } from "../server/userPosts.ts";

const SAMPLE: Array<{ code: string; name: string }> = [
  { code: "300750", name: "宁德时代" },
  { code: "600519", name: "贵州茅台" },
  { code: "002594", name: "比亚迪" },
  { code: "000938", name: "紫光股份" },
  { code: "601138", name: "工业富联" },
  { code: "688256", name: "寒武纪" },
];

function rowsOf(payload: { list?: unknown[]; statuses?: unknown[] }): unknown[] {
  if (Array.isArray(payload.list)) return payload.list;
  if (Array.isArray(payload.statuses)) return payload.statuses;
  return [];
}

async function main(): Promise<void> {
  const cookie = getXueqiuCookie();
  if (!cookie) {
    console.error("未找到雪球 Cookie：请先运行 pnpm xueqiu:session 或页面「连接雪球」。");
    process.exit(1);
  }
  if (!isXueqiuLiveReady() && !(await ensureXueqiuLiveSession(cookie))) {
    console.error("无法建立雪球浏览器会话（可能命中风控/未登录）。");
    process.exit(1);
  }
  console.log("雪球会话有效，开始探测……\n");

  let totalName = 0;
  let totalSymbol = 0;
  for (const { code, name } of SAMPLE) {
    const symbol = toXueqiuSymbol(code);
    const nameItem = { code, symbol, keyword: name, kind: "name" as const };
    const codeItem = { code, symbol, keyword: code, kind: "code" as const };
    const nameEp = xueqiuEndpointsForKeyword(nameItem)[0];
    const symbolEp = xueqiuEndpointsForKeyword(codeItem)[0];

    const nameResult = await fetchXueqiuTimelineInBrowser(nameEp.url, nameEp.referer);
    const symbolResult = await fetchXueqiuTimelineInBrowser(symbolEp.url, symbolEp.referer);

    const nameRows = rowsOf(nameResult);
    const symbolRows = rowsOf(symbolResult);
    totalName += nameRows.length;
    totalSymbol += symbolRows.length;

    const nameErr =
      nameResult.error_description ??
      (nameResult.code !== undefined && nameResult.code !== 0 ? nameResult.message ?? `code=${nameResult.code}` : "");
    const symbolErr =
      symbolResult.error_description ??
      (symbolResult.code !== undefined && symbolResult.code !== 0 ? symbolResult.message ?? `code=${symbolResult.code}` : "");

    console.log(`${name}(${code}) [${symbol}]`);
    console.log(`  名称全站搜索   ${nameRows.length} 条  ${nameErr ? "⚠ " + nameErr : ""}`);
    console.log(`  个股时间线     ${symbolRows.length} 条  ${symbolErr ? "⚠ " + symbolErr : ""}`);
    console.log(`    URL(name): ${nameEp.url}`);
  }

  await stopXueqiuLiveSession();
  process.exit(0);
}

main().catch((error) => {
  console.error("探测失败：", error);
  process.exit(1);
});
