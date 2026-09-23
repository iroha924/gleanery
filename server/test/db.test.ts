import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { sql } from "kysely";
import { openReader, SCHEMA_REVISION } from "../src/db.ts";
import { connectWriter } from "../src/db-write.ts";
import { connectReader } from "../src/sqlite.ts";
import { at, hash, insert, knowledge, message, project, type TempDb, tempDb } from "./temp-db.ts";

let db: TempDb;
let p: number;
before(() => {
  db = tempDb();
  p = project(db);
  message(db, p, { id: "m-1", body: "持ち主の秘密の本文" });
  knowledge(db, p, { source_key: "s#k", body: "知識の本文" });
});
after(() => db.done());

/** 接続を開いて SQL を 1 本流し、失敗の文を返す（通れば null）。 */
function attempt(
  open: () => DatabaseSync,
  text: string,
  ...args: (string | number | Buffer | null)[]
): string | null {
  const raw = open();
  try {
    raw.prepare(text).run(...args);
    return null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    raw.close();
  }
}

const reader = () => connectReader(db.file);
const ingest = () => connectWriter("ingest", db.file);
const capture = () => connectWriter("capture", db.file);

// バージョンが食い違ったまま書くと、列の意味が黙ってずれる。コードと schema のバージョンは同じ数でなければならない。
test("コードが期待する schema のバージョンは db/schema.sql の user_version と同じ", () => {
  const text = fs.readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");
  assert.equal(Number(text.match(/pragma user_version = (\d+);/)?.[1]), SCHEMA_REVISION);
});

test("DB のバージョンが違えば、読む接続も書く接続も開かずに止まり、進め方を案内する", () => {
  const old = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-old-")), "old.db");
  const raw = new DatabaseSync(old);
  raw.exec(`pragma user_version = ${SCHEMA_REVISION + 1}`);
  raw.close();
  assert.throws(() => connectReader(old), /gleanery を更新する/);
  assert.throws(() => connectWriter("ingest", old), /revision/);
  const empty = path.join(path.dirname(old), "empty.db");
  new DatabaseSync(empty).close();
  assert.throws(() => connectReader(empty), /gleanery init/);
});

// 空のファイルが「記録が 0 件」に見える。作るのは `gleanery init` だけ。
test("無い DB は作らずに止まる", () => {
  const missing = path.join(os.tmpdir(), `gleanery-missing-${process.pid}.db`);
  assert.throws(() => connectReader(missing), /gleanery init/);
  assert.throws(() => connectWriter("capture", missing), /gleanery init/);
  assert.equal(fs.existsSync(missing), false);
});

test("MCP・端末の画面の接続は読めて、書けない", async () => {
  const r = openReader(db.file);
  try {
    assert.equal((await r.selectFrom("message").select("body").execute())[0]?.body, "持ち主の秘密の本文");
  } finally {
    await r.destroy();
  }
  assert.match(attempt(reader, "delete from message") ?? "", /readonly|not authorized/);
  assert.match(attempt(reader, "create table x (a)") ?? "", /readonly|not authorized/);
  assert.match(attempt(reader, "attach database ':memory:' as x") ?? "", /not authorized/);
  assert.match(attempt(reader, "select load_extension('x')") ?? "", /not authorized/);
});

test("取り込みの接続は行を書けて、schema を変えられない", () => {
  assert.equal(attempt(ingest, "update project set name = 'o/r2' where id = ?", p), null);
  for (const ddl of [
    "create table x (a)",
    "drop table knowledge_file",
    "alter table project add column x text",
    "create index x on project (name)",
    "attach database ':memory:' as x",
    "create virtual table x using fts5(a)",
    "pragma user_version = 99",
    "pragma foreign_keys = off",
  ])
    assert.match(attempt(ingest, ddl) ?? "", /not authorized/, ddl);
});

// 自動記録の接続は、読んだ文章（会話）に唆されても既存の行を読めも書き換えもしない。
test("自動記録の接続は 3 つの view にだけ書け、FTS も同じ文で入る", async () => {
  const c = `c-${p}-cap`;
  assert.equal(
    attempt(
      capture,
      "insert into capture_conversation (id, project_id, origin, external_id, branch, started_at) values (?, ?, 'codex', 'cap', null, ?)",
      c,
      p,
      at("2026-09-12T00:00:00Z"),
    ),
    null,
  );
  const body = "自動記録で入れた発言";
  assert.equal(
    attempt(
      capture,
      `insert into capture_message (id, conversation_id, external_id, turn_id, speaker_kind, body, truncated,
         original_bytes, sent_at, content_hash, indexed) values ('m-cap', ?, 'e', null, 'self', ?, 0, ?, ?, ?, 1)`,
      c,
      body,
      Buffer.byteLength(body),
      at("2026-09-12T00:00:00Z"),
      hash(),
    ),
    null,
  );
  assert.equal(
    attempt(
      capture,
      "insert into capture_message_file (message_id, path, action) values ('m-cap', 'a.ts', 'edit')",
    ),
    null,
  );
  // 結ぶ先の無いファイルは黙って捨てる（途中で別のプロジェクトへ移った session）
  assert.equal(
    attempt(
      capture,
      "insert into capture_message_file (message_id, path, action) values ('無い', 'a.ts', 'edit')",
    ),
    null,
  );
  const r = openReader(db.file);
  try {
    const hit = await sql<{
      n: number;
    }>`select count(*) as n from message_fts where message_fts match '"自動"'`.execute(r);
    assert.equal(hit.rows[0]?.n, 1, "FTS へ入っている");
    assert.equal(
      (await r.selectFrom("message_file").selectAll().where("message_id", "=", "無い").execute()).length,
      0,
    );
  } finally {
    await r.destroy();
  }
});

test("自動記録の接続は、base table・知識・他人の発言・身元・FTS を触れず、本文を読めない", () => {
  const denied: [string, ...(string | number | Buffer | null)[]][] = [
    [
      "insert into message (id, conversation_id, external_id, speaker_kind, body, original_bytes, sent_at, content_hash, indexed) values ('x', 'c', 'e', 'self', 'b', 1, ?, ?, 1)",
      at("2026-09-12T00:00:00Z"),
      hash(),
    ],
    ["update message set body = 'x'"],
    ["delete from message"],
    [
      "insert into knowledge (project_id, conversation_id, source_key, kind, body, occurred_at, content_hash) values (1, 'c', 'k', 'finding', 'b', ?, ?)",
      at("2026-09-12T00:00:00Z"),
      hash(),
    ],
    ["select body from message"],
    ["select body from knowledge"],
    ["select lexemes from message_fts"],
    // FTS の内部の表には索引の語がそのまま入る。FTS5 自身の読みは許し、この接続が組み立てた文からの読みは拒む
    // （語の入らない _config は、仮想表を開く prepare の中で読まれるので許す）
    ["select id, block from message_fts_data"],
    ["select id, block from knowledge_fts_data"],
    ["select * from message_fts_idx"],
    ["select * from knowledge_fts_docsize"],
    ["delete from message_fts"],
    ["insert into message_fts (rowid, lexemes) values (999, 'x')"],
    ["attach database ':memory:' as x"],
    ["create virtual table x using fts5(a)"],
    ["pragma foreign_keys = off"],
  ];
  for (const [text, ...args] of denied)
    assert.match(attempt(capture, text, ...args) ?? "", /not authorized|prohibited/, text);
  // 身元を名乗る列は view に無い
  assert.match(
    attempt(capture, "insert into capture_message (id, identity_id) values ('x', 1)") ?? "",
    /has no column named identity_id/,
  );
  // GitHub の会話は作れない（source_item_id が view に無いので CHECK で拒まれる）
  assert.match(
    attempt(
      capture,
      "insert into capture_conversation (id, project_id, origin, external_id, started_at) values ('gh', ?, 'github', 'o/r#1', ?)",
      p,
      at("2026-09-12T00:00:00Z"),
    ) ?? "",
    /CHECK constraint failed/,
  );
});

// ingest と owner の authorizer は FTS5 の shadow table への書き込みを FTS5 自身の書き込みと区別できない。defensive が止める。
test("どの書く接続も FTS の内部の表を直接書き換えられない", () => {
  for (const open of [ingest, capture, () => connectWriter("owner", db.file)])
    for (const text of [
      "insert into message_fts_docsize (id, sz) values (999, x'00')",
      "delete from message_fts_data",
      "update message_fts_config set v = 0",
    ])
      assert.match(attempt(open, text) ?? "", /may not be modified|not authorized/, text);
});

// 登録しない接続（sqlite3 の CLI など）が書くと、索引の欠けた行が黙って残る。
test("語切りの関数を登録していない接続は、知識と発言を書けない", () => {
  const raw = new DatabaseSync(db.file);
  try {
    raw.exec("pragma foreign_keys = on");
    assert.throws(
      () =>
        insert({ ...db, owner: raw }, "knowledge", {
          project_id: p,
          conversation_id: `00000000-0000-8000-8000-${String(p).padStart(12, "0")}`,
          source_key: "s#nofn",
          kind: "finding",
          body: "b",
          occurred_at: at("2026-09-12T00:00:00Z"),
          content_hash: hash(),
        }),
      /no such function: gleanery_terms/,
    );
  } finally {
    raw.close();
  }
});
