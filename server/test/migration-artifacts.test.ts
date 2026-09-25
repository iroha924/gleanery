// Applies the migrations (0002 and 0003) that remove the requirements and design kinds to a revision 1 database.
// 0003 rebuilds tables, so with foreign keys on, cascade would delete child rows that should stay.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { applyMigrations, dbInit } from "../src/admin.ts";
import { SCHEMA_REVISION } from "../src/db.ts";
import { connectWriter } from "../src/db-write.ts";
import { at, hash } from "./temp-db.ts";

const ROOT = path.join(import.meta.dirname, "..", "..");
const MIGRATIONS = path.join(ROOT, "db", "migrations");
const R1 = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "schema-r1.sql"), "utf8");

function r1Db(): { raw: DatabaseSync; file: string } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-r1-")), "gleanery.db");
  const raw = connectWriter("owner", file, true);
  raw.exec(R1);
  return { raw, file };
}

const one = (raw: DatabaseSync, sql: string, ...args: (string | number)[]) =>
  raw.prepare(sql).get(...args) as Record<string, number | string> | undefined;
const count = (raw: DatabaseSync, sql: string) => Number(one(raw, sql)?.n);
const matches = (raw: DatabaseSync, word: string) =>
  raw
    .prepare("select rowid from knowledge_fts where knowledge_fts match ?")
    .all(`"${word}"`)
    .map((r) => Number((r as { rowid: number }).rowid));

function source(raw: DatabaseSync, connector: number, kind: string, extra: Record<string, string | null>) {
  const cols = ["connector_id", "external_id", "kind", "title", "content_hash", ...Object.keys(extra)];
  const vals = [
    connector,
    `${kind}-${Object.values(extra).join("")}`,
    kind,
    `${kind} の題`,
    hash(),
    ...Object.values(extra),
  ];
  return Number(
    one(
      raw,
      `insert into source_item (${cols.join(", ")}) values (${cols.map(() => "?").join(", ")}) returning id`,
      ...(vals as (string | number)[]),
    )?.id,
  );
}

function section(raw: DatabaseSync, projectId: number, sourceId: number, word: string): number {
  return Number(
    one(
      raw,
      `insert into knowledge (project_id, source_item_id, source_key, kind, heading, body, occurred_at, content_hash)
       values (?, ?, ?, 'document', ?, ?, ?, ?) returning id`,
      projectId,
      sourceId,
      `doc-${word}`,
      `${word} の節`,
      `${word} を書いた本文`,
      at("2026-09-10T00:00:00Z"),
      hash() as unknown as string,
    )?.id,
  );
}

test("only requirements and design rows and their descendants go, the rest stays, and the schema matches a new database", () => {
  const { raw } = r1Db();
  const p = Number(
    one(raw, "insert into project (key, name) values ('git:github.com/o/r', 'o/r') returning id")?.id,
  );
  const docs = Number(
    one(raw, "insert into connector (project_id, provider) values (?, 'docs') returning id", p)?.id,
  );
  const gh = Number(
    one(raw, "insert into connector (project_id, provider) values (?, 'github') returning id", p)?.id,
  );
  const doc = source(raw, docs, "document", { path: "docs/a.md", body: "本文" });
  const req = source(raw, docs, "requirements", {
    path: ".gleanery/changes/x/requirements.md",
    body: "要件",
  });
  const des = source(raw, docs, "design", { path: ".gleanery/changes/x/design.md", body: "設計" });
  const pr = source(raw, gh, "pull_request", { state: "open" });
  const keepDoc = section(raw, p, doc, "keepword");
  const reqSec = section(raw, p, req, "reqword");
  const desSec = section(raw, p, des, "desword");
  raw
    .prepare("insert into knowledge_file (knowledge_id, path, role) values (?, 'a.ts', 'evidence')")
    .run(reqSec);
  raw
    .prepare("insert into knowledge_file (knowledge_id, path, role) values (?, 'b.ts', 'evidence')")
    .run(keepDoc);
  raw
    .prepare(
      "insert into conversation (id, project_id, source_item_id, origin, external_id, started_at) values ('gh-1', ?, ?, 'github', 'o/r#1', ?)",
    )
    .run(p, pr, at("2026-09-01T00:00:00Z"));
  const body = "PR の発言 prword";
  raw
    .prepare(
      `insert into message (id, conversation_id, external_id, speaker_kind, body, original_bytes, sent_at, content_hash, indexed)
       values ('m-1', 'gh-1', 'e1', 'person', ?, ?, ?, ?, 1)`,
    )
    .run(body, Buffer.byteLength(body), at("2026-09-02T00:00:00Z"), hash());
  raw
    .prepare(
      "insert into message_file (message_id, path, action) values ('m-1', '.gleanery/changes/x/requirements.md', 'read')",
    )
    .run();
  const seqBefore = Number(one(raw, "select seq from sqlite_sequence where name = 'source_item'")?.seq);

  const applied = applyMigrations(raw, fs.readdirSync(MIGRATIONS), MIGRATIONS);
  assert.deepEqual(
    applied.map((m) => m.revision),
    [2, 3, 4],
  );
  assert.equal(Number(one(raw, "pragma user_version")?.user_version), SCHEMA_REVISION);
  assert.equal(Number(one(raw, "pragma foreign_keys")?.foreign_keys), 1);
  assert.deepEqual(raw.prepare("pragma foreign_key_check").all(), []);

  assert.deepEqual(
    raw
      .prepare("select id from source_item order by id")
      .all()
      .map((r) => Number((r as { id: number }).id)),
    [doc, pr],
  );
  assert.deepEqual(
    raw
      .prepare("select id from knowledge order by id")
      .all()
      .map((r) => Number((r as { id: number }).id)),
    [keepDoc],
  );
  assert.equal(
    count(raw, "select count(*) as n from knowledge_file"),
    1,
    "only the files of deleted sections go",
  );
  assert.equal(count(raw, "select count(*) as n from conversation"), 1);
  assert.equal(count(raw, "select count(*) as n from message"), 1);
  assert.equal(
    count(raw, "select count(*) as n from message_file where action = 'read'"),
    1,
    "read records stay as history",
  );
  assert.deepEqual(matches(raw, "keepword"), [keepDoc]);
  assert.deepEqual(matches(raw, "reqword"), []);
  assert.deepEqual(matches(raw, "desword"), []);
  assert.equal(desSec > 0, true);

  // Deleted ids are not reused
  const next = source(raw, docs, "document", { path: "docs/b.md", body: "次" });
  assert.ok(next > seqBefore, `next id ${next} is above the pre-migration max ${seqBefore}`);
  assert.throws(
    () => source(raw, docs, "requirements", { path: "r.md", body: "x" }),
    /CHECK constraint failed/,
  );

  // The schema equals that of a new database, apart from SQL comments (SQLite stores comments inside CREATE statements,
  // and databases created from the r1 schema keep its Japanese comments)
  const fresh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-fresh-")), "gleanery.db");
  dbInit(fresh);
  const schemaOf = (db: DatabaseSync) =>
    (
      db
        .prepare(
          "select type, name, tbl_name, sql from sqlite_schema where name not like 'sqlite_%' order by type, name",
        )
        .all() as { type: string; name: string; tbl_name: string; sql: string | null }[]
    ).map((r) => ({ ...r, sql: r.sql === null ? null : sqlShape(r.sql) }));
  const freshRaw = connectWriter("owner", fresh);
  assert.deepEqual(schemaOf(raw), schemaOf(freshRaw));
  freshRaw.close();
  raw.close();
});

/**
 * SQL without comments and with whitespace collapsed, for comparing schema text. Quoted spans ('…', "…", `…`, […]) stay byte for byte,
 * so comments and whitespace inside a value still count as a difference.
 */
function sqlShape(sql: string): string {
  let out = "";
  let space = false;
  const closers: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i] ?? "";
    const close = closers[c];
    if (close) {
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (sql[j] !== close) continue;
        if (close !== "]" && sql[j + 1] === close) j++;
        else break;
      }
      if (space && out) out += " ";
      space = false;
      out += sql.slice(i, j + 1);
      i = j;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end - 1;
      space = true;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 1;
      space = true;
    } else if (/\s/.test(c)) space = true;
    else {
      if (space && out) out += " ";
      space = false;
      out += c;
    }
  }
  return out;
}

test("the schema comparison ignores comments and layout but not changes to SQL or to quoted values", () => {
  const base = "create table t (\n  -- a comment\n  k text not null check (k in ('a', 'b'))\n) strict";
  assert.equal(
    sqlShape(base),
    sqlShape("create table t ( /* other */ k text not null\n check (k in ('a', 'b')) ) strict"),
  );
  assert.notEqual(sqlShape(base), sqlShape(base.replace("'b'", "'c'")), "a changed CHECK list");
  assert.notEqual(sqlShape(base), sqlShape(base.replace("'a'", "'a  '")), "whitespace inside a quoted value");
  assert.notEqual(sqlShape(base), sqlShape(base.replace("'a'", "'a -- x'")), "-- inside a quoted value");
  assert.notEqual(
    sqlShape(base),
    sqlShape(base.replace("'a'", "'a /* x */'")),
    "/* */ inside a quoted value",
  );
  assert.notEqual(
    sqlShape("select 'it''s'"),
    sqlShape("select 'its'"),
    "doubled quotes stay inside the value",
  );
});

test("deleted ids are not reused even when no source_item remains", () => {
  const { raw } = r1Db();
  const p = Number(
    one(raw, "insert into project (key, name) values ('git:github.com/o/r', 'o/r') returning id")?.id,
  );
  const docs = Number(
    one(raw, "insert into connector (project_id, provider) values (?, 'docs') returning id", p)?.id,
  );
  source(raw, docs, "requirements", { path: ".gleanery/changes/x/requirements.md", body: "要件" });
  const last = source(raw, docs, "design", { path: ".gleanery/changes/x/design.md", body: "設計" });
  applyMigrations(raw, fs.readdirSync(MIGRATIONS), MIGRATIONS);
  assert.equal(count(raw, "select count(*) as n from source_item"), 0);
  const next = source(raw, docs, "document", { path: "docs/a.md", body: "本文" });
  assert.ok(next > last, `next id ${next} is above the deleted ${last}`);
  raw.close();
});

// Without the declaration, 0003 would rebuild tables with foreign keys on and delete child rows. Pin the declaration.
test("0003, which rebuilds tables, declares foreign keys off", () => {
  const file = fs.readdirSync(MIGRATIONS).find((f) => f.startsWith("0003_"));
  assert.ok(file, "0003 exists");
  assert.equal(
    fs.readFileSync(path.join(MIGRATIONS, file), "utf8").split("\n")[0],
    "-- gleanery: foreign_keys=off",
  );
});
