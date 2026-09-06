import assert from "node:assert/strict";
import { test } from "node:test";
import { expandNames, type Person } from "../src/chat.ts";

const people: Person[] = [
  { display: "◯◯さん", handles: ["reviewer-a", "レビュアー A"], is_me: false },
  { display: "平田", handles: ["iroha924", "Hirata Shunichi"], is_me: true },
];

// **呼び名は記録に書かれていない。**書かれているのは `@reviewer-a` なので、
// 展開しないと「◯◯さんはなんて言ってた？」がベクトルでもレキシカルでも当たらない。
test("呼び名で聞かれたらハンドル名を添える", () => {
  const out = expandNames("◯◯さんはbillingについて何て言ってた？", people);
  assert.match(out, /reviewer-a/);
  assert.match(out, /レビュアー A/);
  assert.doesNotMatch(out, /iroha924/, "関係ない人まで足さない");
});

test("ハンドル名で聞かれても呼び名側の別名を添える", () => {
  const out = expandNames("iroha924 のPRは？", people);
  assert.match(out, /Hirata Shunichi/);
});

test("誰の話でもなければ質問を変えない", () => {
  const q = "billing のデータで気をつけることは？";
  assert.equal(expandNames(q, people), q);
});

test("名簿が空なら質問を変えない", () => {
  const q = "◯◯さんはなんて言ってた？";
  assert.equal(expandNames(q, []), q);
});
