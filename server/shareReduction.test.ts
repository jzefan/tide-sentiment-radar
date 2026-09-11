import assert from "node:assert/strict";
import test from "node:test";
import { MAJOR_REDUCTION_PERCENT, classifyShareReductionText } from "./shareReduction.ts";

test("treats controlling-shareholder reduction plans as major share reduction", () => {
  for (const title of [
    "戴维医疗:关于控股股东、实际控制人之一减持股份预披露公告",
    "乾照光电:持股5%以上股东减持股份预披露公告",
    "武汉天源:关于公司实际控制人的一致行动人减持股份预披露的公告",
    "华翔股份：控股股东拟减持不超3%公司股份",
    "章源钨业:控股股东减持股份预披露公告",
  ]) {
    const match = classifyShareReductionText(title);
    assert.equal(match?.level, "major", title);
    assert.ok(match!.matched.length > 0, `${title} 必须留档命中关键词`);
  }
});

test("keeps director and specific-shareholder reductions as exclusion-worthy but not major", () => {
  for (const title of [
    "国能日新:关于部分董事、高级管理人员减持股份的预披露公告",
    "透景生命:关于特定股东减持股份的预披露公告",
    "盛科通信关于股东减持计划时间届满暨减持股份结果公告",
  ]) {
    assert.deepEqual(classifyShareReductionText(title), { level: "minor", matched: [] }, title);
  }
});

test("never treats a plan that sold nothing, or a commitment statement, as reduction pressure", () => {
  for (const title of [
    "南王科技:关于董事减持计划期限届满未减持的公告",
    "新华都:关于股东股份减持计划时间届满未实施减持的公告",
    "德赛西威:关于股东提前终止股份减持计划的公告",
    "德艺文创:关于特定股东股份减持计划期限届满未减持公司股份的公告",
    "神宇股份:离任高级管理人员持股及减持承诺事项的说明",
    "贵州茅台:2026年半年度报告",
    "宁德时代:关于股东增持公司股份的公告",
  ]) {
    assert.equal(classifyShareReductionText(title), null, title);
  }
});

test("a terminated plan that already executed shares still counts as reduction", () => {
  assert.equal(classifyShareReductionText("东利机械:关于高级管理人员提前终止减持计划暨减持股份结果的公告")?.level, "minor");
});

test("ignores convertible-bond disposals that are not share reduction", () => {
  assert.equal(classifyShareReductionText("某某公司:关于股东减持公司可转换公司债券的公告"), null);
  assert.equal(classifyShareReductionText("某某公司:关于股东减持可转债及公司股份的公告")?.level, "minor");
});

test("reads the disclosed reduction percentage only when it follows the reduction verb", () => {
  assert.deepEqual(classifyShareReductionText("国科军工:关于持股5%以上股东拟减持不超3%股份的公告"), { level: "major", matched: ["5%以上股东", "减持比例 3%"] });
  assert.deepEqual(classifyShareReductionText("某某公司:关于股东拟减持不超过1.5%股份的预披露公告"), { level: "minor", matched: [] });
  // “持股5%以上”是持股比例，“减持至5%以下”是变动结果，都不能读成减持比例。
  assert.deepEqual(classifyShareReductionText("长芯博创:关于持股5%以上股东股份变动触及1%及减持至5%以下暨披露简式权益变动报告书的提示性公告"), { level: "major", matched: ["5%以上股东"] });
  assert.equal(MAJOR_REDUCTION_PERCENT, 2);
});

test("normalizes full-width spaces and refuses empty text", () => {
  assert.equal(classifyShareReductionText("　") , null);
  assert.equal(classifyShareReductionText("某某公司:关于控股股东　减持股份的预披露公告")?.level, "major");
});
