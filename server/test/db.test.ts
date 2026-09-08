import assert from "node:assert/strict";
import { test } from "node:test";
import { connect, vec } from "../src/db.ts";

test("pgvector のリテラルへ落とす", () => {
  assert.equal(vec([1, 2.5, -3]), "[1,2.5,-3]");
  assert.equal(vec(null), null);
  assert.equal(vec(undefined), null);
});

test("接続文字列で TLS を緩められない", async () => {
  // pg は接続文字列側を後勝ちで適用する。sslmode だけを弾いても、`?ssl=0` の 5 文字で
  // TLS が丸ごと消え、`?sslrootcert=` は固定した CA を差し替える（実測で再現した）。
  for (const q of [
    "ssl=0",
    "sslmode=no-verify",
    "sslmode=require",
    "sslrootcert=/tmp/x.crt",
    "sslcert=/tmp/x",
    "sslkey=/tmp/x",
  ]) {
    await assert.rejects(
      connect({ KNOWLEDGE_DB_URL: `postgres://u:p@h:5432/db?${q}` }),
      /は使えない/,
      `${q} が素通りした`,
    );
  }
});

test("壊れた接続文字列の例外に、接続文字列そのものを乗せない", async () => {
  // URL の TypeError は err.input に入力全体を持ち、Node は未捕捉例外でそれも印字する。
  const secret = "postgres://user:ghp_SUPERSECRET@[bad";
  await assert.rejects(connect({ KNOWLEDGE_DB_URL: secret }), (e: unknown) => {
    const dump = `${e instanceof Error ? e.message : ""}${JSON.stringify(e, Object.getOwnPropertyNames(e))}`;
    assert.ok(!dump.includes("ghp_SUPERSECRET"), `例外に資格情報が乗っている: ${dump}`);
    return true;
  });
});

test("資格情報が無ければ何をどこへ入れるかを言う", async () => {
  await assert.rejects(connect({}), /knowledge\.env/);
});
