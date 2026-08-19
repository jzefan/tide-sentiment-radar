/**
 * 雪球会话验证脚本：把 Cookie 注入真浏览器做页内校验。
 * 服务端 Node 直连会命中阿里云 WAF 挑战页，不能作为校验依据；此脚本与数据
 * 抓取共用同一套真浏览器校验路径，结果真实。
 *
 *   XUEQIU_COOKIE="你的Cookie" npx tsx scripts/verify-xueqiu-cookie.ts
 */
import { verifyXueqiuCookieStandalone } from "../server/xueqiuBrowser.ts";

const cookie = process.env.XUEQIU_COOKIE?.trim();
if (!cookie) {
  console.log("请先设置 XUEQIU_COOKIE 环境变量：");
  console.log("  XUEQIU_COOKIE=\"你的Cookie\" npx tsx scripts/verify-xueqiu-cookie.ts");
  console.log();
  console.log("Cookie 获取方法（任选）：");
  console.log("  1. 在已登录雪球的 Chrome/Edge/Brave 上运行 pnpm xueqiu:session 一键导入；");
  console.log("  2. 网页“连接雪球”对话框里点“打开浏览器登录”扫码登录；");
  console.log("  3. F12 → Network 面板 → 刷新页面 → 点击任意 xueqiu.com 请求 → 复制请求头里的完整 Cookie。");
  process.exit(1);
}

const result = await verifyXueqiuCookieStandalone(cookie);
if (result.ok) {
  console.log(`✅ ${result.message}。现在启动服务（pnpm dev），雪球讨论将自动进入数据源列表。`);
} else {
  console.log(`❌ ${result.message}`);
  console.log("   若提示挑战未通过，请稍后重试，或改用网页“连接雪球”的浏览器登录方式。");
}
process.exitCode = result.ok ? 0 : 1;
