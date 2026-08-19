/**
 * 情绪分类自检：验证“准则”在关键样例上的表现。
 * 运行：pnpm sentiment:check
 */
import { classifyText } from "../server/sentiment.ts";

const cases: Array<{ text: string; expect: string; note?: string }> = [
  { text: "天收他们", expect: "negative", note: "咒骂" },
  { text: "政策是问谁服务呢？王侯将相哎！出国了", expect: "negative", note: "反问 + 反讽" },
  { text: "业绩超预期，订单增长，盈利改善", expect: "positive" },
  { text: "公司公告拟回购并增持", expect: "positive" },
  { text: "减持套现，股价大跌，散户被割韭菜", expect: "negative" },
  { text: "不看好后市", expect: "negative", note: "否定翻转" },
  { text: "非常看好，订单放量增长", expect: "positive", note: "强调词" },
  { text: "利好与利空并存", expect: "mixed", note: "多空分歧" },
  { text: "今天没什么新消息", expect: "neutral" },
  { text: "哎呀，涨停了", expect: "positive", note: "“哎”不误伤“哎呀”" },
];

let failed = 0;
for (const { text, expect, note } of cases) {
  const { tone, score, keywords } = classifyText(text);
  const ok = tone === expect;
  if (!ok) failed += 1;
  console.log(
    `${ok ? "✓" : "✗"} [${tone.padEnd(8)}] ${expect === tone ? "" : `期望 ${expect} · `}${text}${note ? `（${note}）` : ""} | score=${score} | 关键词=${keywords.join("、") || "—"}`,
  );
}

if (failed) {
  console.error(`\n${failed} 个样例未通过。`);
  process.exit(1);
}
console.log("\n全部样例通过。");
