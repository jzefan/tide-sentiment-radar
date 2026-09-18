import assert from "node:assert/strict";
import test from "node:test";
import { MARKET_BOARDS, marketBoardOf } from "../domain/board";

test("classifies A-share codes into the four focus boards by prefix only", () => {
  assert.equal(marketBoardOf("600519"), "主板", "沪市主板");
  assert.equal(marketBoardOf("601138"), "主板");
  assert.equal(marketBoardOf("603318"), "主板");
  assert.equal(marketBoardOf("605577"), "主板");
  assert.equal(marketBoardOf("000001"), "主板", "深市主板");
  assert.equal(marketBoardOf("001299"), "主板");
  assert.equal(marketBoardOf("002594"), "中小板", "002 为原中小板");
  assert.equal(marketBoardOf("003816"), "中小板", "003 为原中小板");
  assert.equal(marketBoardOf("300308"), "创业板");
  assert.equal(marketBoardOf("301029"), "创业板");
  assert.equal(marketBoardOf("688256"), "科创板");
  assert.equal(marketBoardOf("689009"), "科创板");
});

test("returns null for boards and shapes the focus pool never balances", () => {
  assert.equal(marketBoardOf("430001"), null, "北交所在策略里已被排除，不猜板块");
  assert.equal(marketBoardOf("830001"), null);
  assert.equal(marketBoardOf("920001"), null);
  assert.equal(marketBoardOf("900901"), null, "B 股不参与板块配额");
  assert.equal(marketBoardOf("200011"), null);
  assert.equal(marketBoardOf("609999"), null, "未知前缀不猜测");
  assert.equal(marketBoardOf("60051"), null, "位数不足");
  assert.equal(marketBoardOf(600519), null, "非字符串输入");
  assert.equal(marketBoardOf(null), null);
  assert.equal(marketBoardOf(undefined), null);
});

test("exposes a stable board order for quotas and display", () => {
  assert.deepEqual([...MARKET_BOARDS], ["主板", "中小板", "创业板", "科创板"]);
});
