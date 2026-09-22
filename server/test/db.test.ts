import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { rewriteEnv } from "../src/admin.ts";
import { checkSchema, connect, type Db, SCHEMA_REVISION, settings, vec } from "../src/db.ts";

test("pgvector のリテラルへ落とす", () => {
  assert.equal(vec([1, 2.5, -3]), "[1,2.5,-3]");
});

// 版が食い違ったまま書くと、列の意味が黙ってずれる。コードと schema の版は同じ数でなければならない。
test("コードが期待する schema の版は db/schema.sql の版と同じ", () => {
  const sql = fs.readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");
  assert.equal(
    Number(sql.match(/comment on schema gleanery is 'gleanery schema revision (\d+)'/)?.[1]),
    SCHEMA_REVISION,
  );
});

// どの query にも schema コメントの 1 行を返す（checkSchema が引くのはそれだけ）。
const dbAt = (revision: number): Db =>
  ({ query: async () => ({ rows: [{ comment: `gleanery schema revision ${revision}` }] }) }) as unknown as Db;

// 案内の文面は MCP の応答とフックで AI に届くので、実在する command だけを示す。
// **配った先には repository が無い。**npm と marketplace から入れた利用者は `bun run` を打てないので、
// 同梱の CLI（`gleanery db migrate`）を先に示す。revision を上げた回にだけ出る文面で、diff には現れない。
test("DB の schema が古ければ配った先でも打てる command を案内し、db:reset を案内しない", async () => {
  await assert.rejects(checkSchema(dbAt(SCHEMA_REVISION - 1)), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.match(e.message, /gleanery db migrate/);
    assert.match(e.message, /bun run db:migrate/);
    assert.doesNotMatch(e.message, /db:reset/);
    return true;
  });
});

test("DB の schema が古いときに案内する command は root の package.json にある", async () => {
  const { scripts } = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  await assert.rejects(checkSchema(dbAt(SCHEMA_REVISION - 1)), (e: unknown) => {
    const command = String(e).match(/bun run ([\w:-]+)/)?.[1];
    assert.ok(command && Object.hasOwn(scripts, command), String(e));
    return true;
  });
});

// migration は版を戻せないので、DB のほうが新しいときに当てる手順は無い。
test("DB の schema がコードより新しければ gleanery の更新を案内し、db:migrate を案内しない", async () => {
  await assert.rejects(checkSchema(dbAt(SCHEMA_REVISION + 1)), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.match(e.message, /gleanery を更新/);
    assert.doesNotMatch(e.message, /db:migrate/);
    return true;
  });
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
      connect({ GLEANERY_DB_URL_RO: `postgres://u:p@h:5432/db?${q}` }, "reader"),
      /は使えない/,
      q,
    );
  }
});

// 手元の DB は TLS を張らない（公式イメージの既定が ssl = off）。他所へ繋ぐときは検証を切らない。
test("loopback は平文、それ以外は検証付き TLS", () => {
  for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "[::1]"]) {
    const c = settings({ GLEANERY_DB_URL_RO: `postgres://u:p@${host}:5432/db` }, "reader");
    assert.equal(c.ssl, false, host);
  }
  for (const host of ["db.example.com", "10.0.0.1", "[2001:db8::1]"]) {
    const c = settings({ GLEANERY_DB_URL_RO: `postgres://u:p@${host}:5432/db` }, "reader");
    assert.deepEqual(c.ssl, { rejectUnauthorized: true }, host);
  }
});

// URL パーサは host を正規化しない。綴りが違うものを loopback と認めると、
// loopback でない相手へ平文で繋ぐ側へ倒れる。取りこぼすのは接続に失敗するだけで安全。
test("loopback に見える別の綴りは平文にしない", () => {
  for (const host of ["127.1", "0x7f.1", "127.0.0.2", "localhost.example.com", "notlocalhost"]) {
    const c = settings({ GLEANERY_DB_URL_RO: `postgres://u:p@${host}:5432/db` }, "reader");
    assert.deepEqual(c.ssl, { rejectUnauthorized: true }, host);
  }
});

// net.connect は角括弧付きの IPv6 を受け付けない。
test("IPv6 の角括弧を外して渡す", () => {
  assert.equal(settings({ GLEANERY_DB_URL_RO: "postgres://u:p@[::1]:5432/db" }, "reader").host, "::1");
  assert.equal(
    settings({ GLEANERY_DB_URL_RO: "postgres://u:p@[2001:db8::1]:5432/db" }, "reader").host,
    "2001:db8::1",
  );
});

test("壊れた接続文字列の例外に、接続文字列そのものを乗せない", async () => {
  const secret = "postgres://user:ghp_SUPERSECRET@[bad";
  await assert.rejects(connect({ GLEANERY_DB_URL_INGEST: secret }, "ingest"), (e: unknown) => {
    const dump = `${e instanceof Error ? e.message : ""}${JSON.stringify(e, Object.getOwnPropertyNames(e))}`;
    assert.ok(!dump.includes("ghp_SUPERSECRET"), dump);
    return true;
  });
});

// 読むだけの出口が書き込みの鍵へ落ちると、読んだ文章に書かされる経路ができる。
test("どの鍵も別の鍵へ落とさず、無ければ何をどこへ入れるかを言う", async () => {
  await assert.rejects(
    connect({ GLEANERY_DB_URL: "postgres://u:p@h/db" }, "reader"),
    /GLEANERY_DB_URL_RO が無い.*\.gleanery\/env/,
  );
  await assert.rejects(
    connect({ GLEANERY_DB_URL_RO: "postgres://u:p@h/db" }, "capture"),
    /GLEANERY_DB_URL_CAPTURE が無い/,
  );
});

test("env ファイルは指定した鍵だけを書き換え、ほかの行とコメントを残す", () => {
  const before = [
    "# gleanery",
    "GLEANERY_DB_URL=owner",
    "export GLEANERY_DB_URL_RO=old",
    "VOYAGE_API_KEY=v",
    "",
  ].join("\n");
  assert.equal(
    rewriteEnv(before, { GLEANERY_DB_URL_RO: "new", GLEANERY_DB_URL_INGEST: "i" }),
    [
      "# gleanery",
      "GLEANERY_DB_URL=owner",
      "VOYAGE_API_KEY=v",
      "GLEANERY_DB_URL_RO=new",
      "GLEANERY_DB_URL_INGEST=i",
      "",
    ].join("\n"),
  );
});
