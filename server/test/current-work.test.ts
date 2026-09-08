import assert from "node:assert/strict";
import { test } from "node:test";
import { connect, loadEnv } from "../src/db.ts";
import { CURRENT_WORK_WHERE, IN_PROGRESS } from "../src/search.ts";

// **述語を Postgres に評価させる。**JavaScript で書き直すと写しが 2 つになり、
// SQL 側だけを直したときにテストが通ったまま残る。表は作らず `values` 句へ当てる。
//
// `phases` / `next` は `not null default '[]'`（20260905160457_record_and_node.sql）なので、
// null になる場合は測らない。**表に存在し得ない状態をテストしても、何も証明しない。**
const CASES: Array<[name: string, phases: string, next: string, want: boolean]> = [
  ["未完の工程があれば進行中", '[{"state":"doing"}]', "[]", true],
  ["工程が全部 done でも next が残っていれば進行中", '[{"state":"done"}]', '[{"text":"x"}]', true],
  ["工程が全部 done で next も空なら、進行中ではない", '[{"state":"done"}]', "[]", false],
  // 2026-09-09 に踏んだ欠陥。工程を書かず次の一手だけ書いた記録が現在地から丸ごと消えていた。
  ["工程が無くても next があれば進行中", "[]", '[{"text":"x"}]', true],
  ["工程も next も空なら、進行中ではない（取り込みが作る空の殻）", "[]", "[]", false],
];

// **読み取り用の鍵を自分で選ばない。**`connect` の `as` が、RO が無いときに管理側へ
// 落ちずに投げるガードを持っている。ここで接続文字列を組み立てると、そのガードを迂回する。
const hasRo = (() => {
  try {
    return Boolean(loadEnv().KNOWLEDGE_DB_URL_RO);
  } catch {
    return false;
  }
})();

test("進行中の判定を Postgres に評価させる", {
  skip: hasRo ? false : "KNOWLEDGE_DB_URL_RO が無い",
}, async () => {
  const c = await connect(loadEnv(), { as: "read" });
  try {
    for (const [name, phases, next, want] of CASES) {
      const r = await c.query<{ ok: boolean }>(
        `select ${IN_PROGRESS} as ok from (values ($1::jsonb, $2::jsonb)) as r(phases, next)`,
        [phases, next],
      );
      assert.equal(r.rows[0]?.ok, want, name);
    }
  } finally {
    await c.end();
  }
});

// **条件が増えたことを捕まえる。**元の欠陥は `IN_PROGRESS` の中ではなく外に足された
// 1 行で、述語だけを見る上のテストは緑のまま通る（実測 2026-09-09 で再現した）。
// ここで where を丸ごと突き合わせるので、条件を足せば落ちる。
// **落ちたときに直すのはこの期待値ではない。**足した条件を `IN_PROGRESS` の中へ入れるか、
// 入れられない理由（作業場所の絞り込みのような、record の状態と無関係なもの）を確かめる。
test("record を絞る条件は、作業場所と IN_PROGRESS だけ", () => {
  assert.equal(CURRENT_WORK_WHERE, `($1::int[] is null or r.scope_id = any($1)) and ${IN_PROGRESS}`);
});
