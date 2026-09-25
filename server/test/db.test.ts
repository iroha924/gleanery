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

/** Opens a connection, runs one SQL statement, and returns the failure message (null on success). */
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

// Writing with mismatched versions silently shifts column meanings. The code and schema versions must be equal.
test("the schema version the code expects equals user_version in db/schema.sql", () => {
  const text = fs.readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");
  assert.equal(Number(text.match(/pragma user_version = (\d+);/)?.[1]), SCHEMA_REVISION);
});

test("with a different database version, neither read nor write connections open, and the next step is shown", () => {
  const old = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-old-")), "old.db");
  const raw = new DatabaseSync(old);
  raw.exec(`pragma user_version = ${SCHEMA_REVISION + 1}`);
  raw.close();
  assert.throws(() => connectReader(old), /Update sphica/);
  assert.throws(() => connectWriter("ingest", old), /revision/);
  const empty = path.join(path.dirname(old), "empty.db");
  new DatabaseSync(empty).close();
  assert.throws(() => connectReader(empty), /sphica init/);
});

// An empty file would look like zero records. Only `sphica init` creates the database.
test("a missing database is not created, and it stops", () => {
  const missing = path.join(os.tmpdir(), `sphica-missing-${process.pid}.db`);
  assert.throws(() => connectReader(missing), /sphica init/);
  assert.throws(() => connectWriter("capture", missing), /sphica init/);
  assert.equal(fs.existsSync(missing), false);
});

test("the MCP and terminal screen connection can read but not write", async () => {
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

test("the ingest connection can write rows but cannot change the schema", () => {
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

// The capture connection cannot read or modify existing rows, even if a recorded conversation tries to steer it.
test("the capture connection writes only to the 3 views, and FTS is filled by the same statement", async () => {
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
  // Files with nothing to link to are silently dropped (a session that moved to another project midway)
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
    assert.equal(hit.rows[0]?.n, 1, "stored in FTS");
    assert.equal(
      (await r.selectFrom("message_file").selectAll().where("message_id", "=", "無い").execute()).length,
      0,
    );
  } finally {
    await r.destroy();
  }
});

test("the capture connection cannot touch base tables, knowledge, others' messages, identities, or FTS, and cannot read bodies", () => {
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
    // FTS internal tables hold index terms as is. Reads by FTS5 itself are allowed; reads from statements this connection builds are denied
    // (_config holds no terms and is read in the prepare that opens the virtual table, so it is allowed)
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
  // The views have no columns that claim an identity
  assert.match(
    attempt(capture, "insert into capture_message (id, identity_id) values ('x', 1)") ?? "",
    /has no column named identity_id/,
  );
  // GitHub conversations cannot be created (source_item_id is not in the view, so CHECK rejects it)
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

// The ingest and owner authorizers cannot tell writes to FTS5 shadow tables from FTS5's own writes. defensive mode stops them.
test("no write connection can modify FTS internal tables directly", () => {
  for (const open of [ingest, capture, () => connectWriter("owner", db.file)])
    for (const text of [
      "insert into message_fts_docsize (id, sz) values (999, x'00')",
      "delete from message_fts_data",
      "update message_fts_config set v = 0",
    ])
      assert.match(attempt(open, text) ?? "", /may not be modified|not authorized/, text);
});

// A connection without the registration (such as the sqlite3 CLI) would silently leave rows missing from the index.
test("a connection without the tokenizer function cannot write knowledge or messages", () => {
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
      /no such function: sphica_terms/,
    );
  } finally {
    raw.close();
  }
});
