import assert from "node:assert/strict";
import { test } from "node:test";
import { connect, loadEnv } from "../src/db.ts";
import { ILIKE_PATTERN, lexicalTerms } from "../src/search.ts";

// **式を Postgres に評価させる。**JavaScript で `ilike` を書き直すと写しが 2 つになり、
// SQL 側だけを直したときにテストが通ったまま残る。
//
// `_` は `ilike` で任意の 1 文字として効く。`lexicalTerms` は `search_path` や
// `content_hash` のような語を返すので、潰さないと別の行まで拾う。
const CASES: Array<[語: string, 本文: string, want: boolean]> = [
  ["search_path", "set search_path = public, extensions", true],
  ["search_path", "searchXpath を設定する", false],
  ["content_hash", "content-hash が一致したら埋め込みを取り直さない", false],
  ["voyage", "埋め込みは voyage-4-large", true],
  ["ABC-123", "PR ABC-123 を取り込む", true],
  ["ABC-123", "PR ABC-124 を取り込む", false],
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

test("ilike のパターンで `_` がワイルドカードにならない", {
  skip: hasRo ? false : "KNOWLEDGE_DB_URL_RO が無い",
}, async () => {
  const c = await connect(loadEnv(), { as: "read" });
  try {
    for (const [word, text, want] of CASES) {
      const r = await c.query<{ ok: boolean }>(
        `select $2::text ilike ${ILIKE_PATTERN} as ok from (values ($1::text)) as v(t)`,
        [word, text],
      );
      assert.equal(r.rows[0]?.ok, want, `${word} / ${text}`);
    }
  } finally {
    await c.end();
  }
});

// **エスケープが到達する入力しか作らない。**`lexicalTerms` が返し得る文字集合が
// 広がると、`_` だけを潰す式では足りなくなる。ここが落ちたら式のほうを見直す。
test("lexicalTerms が返す語に `%` は入らない", () => {
  const q = "100% の再現率と search_path と ABC-123 について";
  assert.equal(
    lexicalTerms(q).some((t) => t.includes("%")),
    false,
  );
});
