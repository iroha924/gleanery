import assert from "node:assert/strict";
import { test } from "node:test";
import { connect, vec } from "../src/db.ts";

test("pgvector のリテラルへ落とす", () => {
  assert.equal(vec([1, 2.5, -3]), "[1,2.5,-3]");
  assert.equal(vec(null), null);
  assert.equal(vec(undefined), null);
});

test("接続文字列の sslmode で TLS 検証を緩められない", async () => {
  // sslmode は ssl オプションより後に効くので、1 語入るだけで固定した CA が無視される。
  await assert.rejects(
    connect({ SUPABASE_DB_URL: "postgres://u:p@h:5432/db?sslmode=no-verify" }),
    /sslmode=no-verify は使えない/,
  );
  await assert.rejects(
    connect({ SUPABASE_DB_URL: "postgres://u:p@h:5432/db?sslmode=require" }),
    /sslmode=require/,
  );
});

test("資格情報が無ければ何をどこへ入れるかを言う", async () => {
  await assert.rejects(connect({}), /knowledge\.env/);
});
