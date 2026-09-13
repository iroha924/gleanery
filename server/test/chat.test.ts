import assert from "node:assert/strict";
import { test } from "node:test";
import { expandNames, type Person, runTool, SYSTEM } from "../src/chat.ts";

const people: Person[] = [
  { display: "◯◯さん", handles: ["reviewer-a", "レビュアー A"], isSelf: false },
  { display: "平田", handles: ["iroha924"], isSelf: true },
];

// 呼び名は記録に書かれていない。書かれているのは `@reviewer-a` なので、展開しないと語彙でも意味でも当たらない。
test("呼び名で聞かれたらハンドルを添え、関係ない人は足さない", () => {
  const out = expandNames("◯◯さんはbillingについて何て言ってた？", people);
  assert.match(out, /reviewer-a/);
  assert.doesNotMatch(out, /iroha924/);
  assert.equal(expandNames("billing で気をつけることは？", people), "billing で気をつけることは？");
  assert.equal(expandNames("◯◯さんは？", []), "◯◯さんは？");
});

// 「私」が誰かは推論できない。名乗りを渡さないと、他人の PR を「あなたの最新」として挙げる。
test("質問者本人と、表に無い名前の扱いを渡す", () => {
  const s = SYSTEM(people);
  assert.match(s, /平田（質問者本人） = iroha924/);
  assert.match(s, /この表に無い名前は別人/);
  assert.match(SYSTEM([]), /who: me/);
});

const recorder = () => {
  const sql: string[] = [];
  const query = async (s: string) => {
    sql.push(s);
    return { rows: s.includes("count(*)") ? [{ n: "0" }] : [] };
  };
  return { sql, db: { query } as never };
};

// AI 向けの出口を直接叩く。関数が正しくても、ここで組み立てる引数が違えばモデルには届かない。
test("「私はなんて言った？」は持ち主の発言を引き、作業場所は呼び出し側が決める", async () => {
  const r = recorder();
  await runTool(
    r.db,
    {},
    [3],
    { name: "recall", arguments: JSON.stringify({ mode: "said", who: "me" }) },
    [],
  );
  assert.match(r.sql[0] ?? "", /m\.speaker_kind = 'self'/);
  assert.match(r.sql[0] ?? "", /c\.project_id = any/);
});

test("PR の一覧は総数も返し、読めない引数は理由を返す", async () => {
  const r = recorder();
  const out = JSON.parse(
    await runTool(
      r.db,
      {},
      [3],
      { name: "list_items", arguments: JSON.stringify({ author: "私", state: "merged" }) },
      [],
    ),
  );
  assert.equal(out.total, 0);
  assert.match(r.sql[0] ?? "", /count\(\*\)/);
  assert.match(
    await runTool(r.db, {}, [3], { name: "recall", arguments: "{" }, []),
    /JSON として読めなかった/,
  );
  assert.match(await runTool(r.db, {}, [3], { name: "grep_code", arguments: "{}" }, []), /知らない道具/);
});
