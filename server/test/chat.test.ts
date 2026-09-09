import assert from "node:assert/strict";
import { test } from "node:test";
import { jstMonth } from "../src/chat.ts";

// **UTC で切ると、月初 9 時間の利用が前月に落ちる。**
// 同じ取り違えを日付の集計で踏んでいる（chat.ts の JST_FROM の上に実測がある）。
test("月の境目は日本時間で切る", () => {
  assert.equal(jstMonth(Date.parse("2026-08-31T15:00:00Z")), "2026-09", "9/1 00:00 JST は 9 月");
  assert.equal(jstMonth(Date.parse("2026-08-31T14:59:59Z")), "2026-08", "8/31 23:59 JST は 8 月");
  assert.equal(jstMonth(Date.parse("2026-09-30T15:00:00Z")), "2026-10");
});
