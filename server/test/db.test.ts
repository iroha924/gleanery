import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { rewriteEnv } from "../src/admin.ts";
import { connect, SCHEMA_REVISION, vec } from "../src/db.ts";

test("pgvector のリテラルへ落とす", () => {
  assert.equal(vec([1, 2.5, -3]), "[1,2.5,-3]");
});

// 版が食い違ったまま書くと、列の意味が黙ってずれる。コードと schema の版は同じ数でなければならない。
test("コードが期待する schema の版は db/schema.sql の版と同じ", () => {
  const sql = fs.readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");
  assert.equal(
    Number(sql.match(/comment on schema mitos is 'mitos schema revision (\d+)'/)?.[1]),
    SCHEMA_REVISION,
  );
});

// pg は接続文字列側を後勝ちで適用する。`?ssl=0` の 5 文字で TLS が消え、`?sslrootcert=` は CA を差し替える。
test("接続文字列で TLS を緩められない", async () => {
  for (const q of [
    "ssl=0",
    "sslmode=no-verify",
    "sslmode=require",
    "sslrootcert=/tmp/x.crt",
    "sslcert=/tmp/x",
    "sslkey=/tmp/x",
  ]) {
    await assert.rejects(
      connect({ KNOWLEDGE_DB_URL_RO: `postgres://u:p@h:5432/db?${q}` }, "reader"),
      /は使えない/,
      q,
    );
  }
});

test("壊れた接続文字列の例外に、接続文字列そのものを乗せない", async () => {
  const secret = "postgres://user:ghp_SUPERSECRET@[bad";
  await assert.rejects(connect({ KNOWLEDGE_DB_URL_INGEST: secret }, "ingest"), (e: unknown) => {
    const dump = `${e instanceof Error ? e.message : ""}${JSON.stringify(e, Object.getOwnPropertyNames(e))}`;
    assert.ok(!dump.includes("ghp_SUPERSECRET"), dump);
    return true;
  });
});

// 読むだけの出口が書き込みの鍵へ落ちると、読んだ文章に書かされる経路ができる。
test("どの鍵も別の鍵へ落とさず、無ければ何をどこへ入れるかを言う", async () => {
  await assert.rejects(
    connect({ KNOWLEDGE_DB_URL: "postgres://u:p@h/db" }, "reader"),
    /KNOWLEDGE_DB_URL_RO が無い.*knowledge\.env/,
  );
  await assert.rejects(
    connect({ KNOWLEDGE_DB_URL_RO: "postgres://u:p@h/db" }, "capture"),
    /KNOWLEDGE_DB_URL_CAPTURE が無い/,
  );
});

test("env ファイルは指定した鍵だけを書き換え、ほかの行とコメントを残す", () => {
  const before = [
    "# mitos",
    "KNOWLEDGE_DB_URL=owner",
    "export KNOWLEDGE_DB_URL_RO=old",
    "VOYAGE_API_KEY=v",
    "",
  ].join("\n");
  assert.equal(
    rewriteEnv(before, { KNOWLEDGE_DB_URL_RO: "new", KNOWLEDGE_DB_URL_INGEST: "i" }),
    [
      "# mitos",
      "KNOWLEDGE_DB_URL=owner",
      "VOYAGE_API_KEY=v",
      "KNOWLEDGE_DB_URL_RO=new",
      "KNOWLEDGE_DB_URL_INGEST=i",
      "",
    ].join("\n"),
  );
});
