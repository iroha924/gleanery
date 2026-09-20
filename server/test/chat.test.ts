import assert from "node:assert/strict";
import { test } from "node:test";
import { expandNames, runTool, SYSTEM } from "../src/chat.ts";
import type { Person } from "../src/search.ts";
import { fakeDb } from "./fake-db.ts";

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
  const { db, calls } = fakeDb((s) => (s.includes("count(*)") ? [{ n: "0" }] : []));
  return {
    db,
    get sql() {
      return calls.map((c) => c.sql);
    },
    get params() {
      return calls.map((c) => [...c.parameters]);
    },
  };
};

// 記録に紛れた命令文が read で別の作業場所を開かせても、選んだ作業場所の外は「無い」になる。
test("read は選んだ作業場所の外を読ませず、読んだ参照を 1 件ずつ根拠に載せる", async () => {
  const r = recorder();
  const sources: Parameters<typeof runTool>[4] = [];
  const out = JSON.parse(
    await runTool(
      r.db,
      {},
      [3],
      { name: "read", arguments: JSON.stringify({ refs: ["k:1", "k:2", "k:1"] }) },
      sources,
    ),
  );
  assert.deepEqual(
    out.rows.map((x: { n: number; ref: string }) => [x.n, x.ref]),
    [
      [1, "k:1"],
      [2, "k:2"],
    ],
  );
  assert.equal(sources.length, 2);
  assert.ok(
    r.params.every((p) => p.some((v) => Array.isArray(v) && v[0] === 3)),
    "どの問い合わせも範囲を持つ",
  );
});

test("暦にない日付は、モデルが直せる形で返す", async () => {
  const r = recorder();
  const out = JSON.parse(
    await runTool(
      r.db,
      {},
      [3],
      { name: "list_items", arguments: JSON.stringify({ since: "2026-02-30" }) },
      [],
    ),
  );
  assert.match(out.error, /実在する YYYY-MM-DD/);
  assert.equal(r.sql.length, 0);
});

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
