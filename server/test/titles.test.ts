import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanTitle, describeTitles, fillTitles } from "../src/titles.ts";
import { fakeDb } from "./fake-db.ts";

test("題の飾りを落とす。鍵括弧・引用符・句点で囲まれても中身だけを残す", () => {
  assert.equal(
    cleanTitle("「セッション一覧の題を AI に付けさせる」"),
    "セッション一覧の題を AI に付けさせる",
  );
  assert.equal(cleanTitle('"chat の SSE が切れる不具合"'), "chat の SSE が切れる不具合");
  assert.equal(cleanTitle("  port を 4924 へ移す。  "), "port を 4924 へ移す");
});

test("題は 1 行にする。説明を続けて返されても最初の行だけを使う", () => {
  assert.equal(cleanTitle("配布物の版を揃える\n\nこの session では npm の版を…"), "配布物の版を揃える");
});

// 題は画面の 1 行に出る。文字数で切ると、日本語は 3 倍のバイトが入って列の幅を超え、
// 英数字だけの題は入る長さなのに切られる。
test("題は文字数ではなくバイトで切る", () => {
  assert.equal(cleanTitle("あ".repeat(100)), "あ".repeat(40));
  assert.equal(cleanTitle("a".repeat(100)), "a".repeat(100));
});

test("鍵が無ければ題を付けず、理由を返す", async () => {
  const { db } = fakeDb(() => {
    assert.fail("鍵が無いのに DB を引いた");
  });
  assert.deepEqual(await fillTitles(db, {}), { titled: 0, stopped: "OPENAI_API_KEY が無い" });
});

test("付けた題が無く、止めた理由も無ければ harvest は何も出さない", () => {
  assert.equal(describeTitles({ titled: 0 }), null);
  assert.equal(describeTitles({ titled: 3 }), "セッションの題 3 件");
  assert.match(describeTitles({ titled: 1, stopped: "429" }) ?? "", /次の同期で取り直す/);
});
