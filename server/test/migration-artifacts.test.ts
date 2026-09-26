// Applies the migrations to a revision 1 database: 0002 and 0003 remove the requirements and design kinds, 0005 renames the tokenizer
// calls, and 0006 and 0007 remove the bulk import. 0003 and 0007 rebuild tables, so with foreign keys on, cascade would delete child rows
// that should stay.

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
/** The migrations up to revision n (to test an older step against the schema it was written for) */
const upTo = (n: number) => fs.readdirSync(MIGRATIONS).filter((f) => Number(f.slice(0, 4)) <= n);

function r1Db(): { raw: DatabaseSync; file: string } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-r1-")), "sphica.db");
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
    path: ".sphica/changes/x/requirements.md",
    body: "要件",
  });
  const des = source(raw, docs, "design", { path: ".sphica/changes/x/design.md", body: "設計" });
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
      "insert into message_file (message_id, path, action) values ('m-1', '.sphica/changes/x/requirements.md', 'read')",
    )
    .run();
  const seqBefore = Number(one(raw, "select seq from sqlite_sequence where name = 'source_item'")?.seq);

  const applied = applyMigrations(raw, upTo(5), MIGRATIONS);
  assert.deepEqual(
    applied.map((m) => m.revision),
    [2, 3, 4, 5],
  );
  assert.equal(Number(one(raw, "pragma user_version")?.user_version), 5);
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

  raw.close();
});

/** A new database's schema, for comparing with a migrated one */
function freshSchema() {
  const fresh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-fresh-")), "sphica.db");
  dbInit(fresh);
  const raw = connectWriter("owner", fresh);
  const out = schemaOf(raw);
  raw.close();
  return out;
}

const schemaOf = (db: DatabaseSync) =>
  (
    db
      .prepare(
        "select type, name, tbl_name, sql from sqlite_schema where name not like 'sqlite_%' order by type, name",
      )
      .all() as { type: string; name: string; tbl_name: string; sql: string | null }[]
  ).map((r) => ({ ...r, sql: r.sql === null ? null : sqlShape(r.sql) }));

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
  source(raw, docs, "requirements", { path: ".sphica/changes/x/requirements.md", body: "要件" });
  const last = source(raw, docs, "design", { path: ".sphica/changes/x/design.md", body: "設計" });
  applyMigrations(raw, upTo(5), MIGRATIONS);
  assert.equal(count(raw, "select count(*) as n from source_item"), 0);
  const next = source(raw, docs, "document", { path: "docs/a.md", body: "本文" });
  assert.ok(next > last, `next id ${next} is above the deleted ${last}`);
  raw.close();
});

// Without the declaration, a rebuild would run with foreign keys on and delete child rows. Pin the declaration.
test("0003 and 0007, which rebuild tables, declare foreign keys off", () => {
  for (const n of ["0003_", "0007_"]) {
    const file = fs.readdirSync(MIGRATIONS).find((f) => f.startsWith(n));
    assert.ok(file, `${n} exists`);
    assert.equal(
      fs.readFileSync(path.join(MIGRATIONS, file), "utf8").split("\n")[0],
      "-- sphica: foreign_keys=off",
    );
  }
});

// A revision 4 database whose triggers and view call the tokenizer under another name. 0005 must replace them without
// that name being registered, keep the index, and leave the schema of a new database.
test("0005 moves the tokenizer calls to sphica_terms without the old function and keeps the index", () => {
  const { raw: r1, file } = r1Db();
  applyMigrations(r1, upTo(4), MIGRATIONS);
  r1.close();
  let raw = connectWriter("owner", file);
  const legacy = raw
    .prepare("select type, name, sql from sqlite_schema where sql like '%sphica_terms(%'")
    .all() as { type: string; name: string; sql: string }[];
  assert.deepEqual(legacy.map((r) => r.name).sort(), [
    "knowledge_search_text",
    "message_fts_ai",
    "message_fts_au",
  ]);
  for (const r of legacy) raw.exec(`drop ${r.type} ${r.name}`);
  for (const r of legacy) raw.exec(r.sql.replaceAll("sphica_terms(", "legacy_terms("));
  raw.function("legacy_terms", { deterministic: true }, (text) => String(text ?? "").toLowerCase());
  const p = Number(
    one(raw, "insert into project (key, name) values ('git:github.com/o/r', 'o/r') returning id")?.id,
  );
  const docs = Number(
    one(raw, "insert into connector (project_id, provider) values (?, 'docs') returning id", p)?.id,
  );
  const keep = section(raw, p, source(raw, docs, "document", { path: "docs/a.md", body: "本文" }), "oldword");
  raw.close();

  raw = connectWriter("owner", file);
  assert.throws(
    () => section(raw, p, source(raw, docs, "document", { path: "docs/b.md", body: "本文" }), "early"),
    /no such function: legacy_terms/,
    "before 0005 a write without the old function fails",
  );
  const applied = applyMigrations(raw, upTo(5), MIGRATIONS);
  assert.deepEqual(
    applied.map((m) => m.revision),
    [5],
  );
  assert.deepEqual(matches(raw, "oldword"), [keep], "rows indexed before 0005 are still found");
  const added = section(
    raw,
    p,
    source(raw, docs, "document", { path: "docs/c.md", body: "本文" }),
    "newword",
  );
  assert.deepEqual(matches(raw, "newword"), [added]);
  assert.equal(count(raw, "select count(*) as n from sqlite_schema where sql like '%legacy_terms%'"), 0);
  raw.close();
});

/** A revision 5 database with what the removed bulk import wrote, and trace rows that point at an extracted PR decision */
function r5WithImport() {
  const { raw, file } = r1Db();
  applyMigrations(raw, upTo(5), MIGRATIONS);
  const id = (sql: string, ...args: (string | number | null)[]) =>
    Number(one(raw, `${sql} returning id`, ...(args as (string | number)[]))?.id);
  const p = id("insert into project (key, name) values ('git:github.com/o/r', 'o/r')");
  const docs = id("insert into connector (project_id, provider) values (?, 'docs')", p);
  const gh = id("insert into connector (project_id, provider) values (?, 'github')", p);
  const person = id("insert into person (display_name, is_self) values ('私', 1)");
  const who = id(
    "insert into person_identity (person_id, provider, external_id, handle) values (?, 'github', '1', 'me')",
    person,
  );
  const doc = section(raw, p, source(raw, docs, "document", { path: "docs/a.md", body: "本文" }), "docword");
  const pr = Number(
    one(
      raw,
      "insert into source_item (connector_id, external_id, kind, title, state, url, closed_at, content_hash) values (?, '5', 'pull_request', 'Keep SQLite', 'merged', 'https://github.com/o/r/pull/5', ?, ?) returning id",
      gh,
      at("2026-09-11T00:00:00Z"),
      hash() as unknown as string,
    )?.id,
  );
  raw
    .prepare(
      "insert into conversation (id, project_id, source_item_id, origin, external_id, started_at) values ('gh-5', ?, ?, 'github', 'o/r#5', ?)",
    )
    .run(p, pr, at("2026-09-10T00:00:00Z"));
  raw
    .prepare(
      `insert into message (id, conversation_id, external_id, speaker_kind, identity_id, body, original_bytes, sent_at, content_hash, indexed)
       values ('m-gh', 'gh-5', 'body', 'person', ?, 'PR body prword', 14, ?, ?, 1)`,
    )
    .run(who, at("2026-09-10T00:00:00Z"), hash());
  raw
    .prepare("insert into message_file (message_id, path, action) values ('m-gh', 'src/a.ts', 'review')")
    .run();
  const key = "github:o/r/pull/5#abcdef012345-1";
  const decision = id(
    `insert into knowledge (project_id, source_item_id, conversation_id, source_key, kind, status, heading, body, occurred_at, content_hash)
     values (?, ?, 'gh-5', ?, 'decision', 'accepted', 'Decisions in PR #5', 'Use one SQLite file prdecision', ?, ?)`,
    p,
    pr,
    key,
    at("2026-09-11T00:00:00Z"),
    hash() as unknown as string,
  );
  const option = id(
    `insert into knowledge (project_id, source_item_id, conversation_id, source_key, kind, status, decision_id, heading, body, occurred_at, content_hash)
     values (?, ?, 'gh-5', ?, 'option', 'rejected', ?, 'Decisions in PR #5', 'Postgres', ?, ?)`,
    p,
    pr,
    `${key}.r1`,
    decision,
    at("2026-09-11T00:00:00Z"),
    hash() as unknown as string,
  );
  raw
    .prepare(
      "insert into knowledge_terms (knowledge_id, terms, content_hash, source, written_at) values (?, 'sqlite', ?, 'pr', ?)",
    )
    .run(decision, hash(), at("2026-09-12T00:00:00Z"));
  raw
    .prepare(
      "insert into conversation (id, project_id, origin, external_id, started_at) values ('cc-1', ?, 'claude-code', 's1', ?)",
    )
    .run(p, at("2026-09-12T00:00:00Z"));
  const verification = id(
    `insert into knowledge (project_id, conversation_id, source_key, kind, status, decision_id, body, occurred_at, content_hash)
     values (?, 'cc-1', 'claude-code:s1#v', 'verification', 'passed', ?, 'checked it', ?, ?)`,
    p,
    decision,
    at("2026-09-12T00:00:00Z"),
    hash() as unknown as string,
  );
  const older = id(
    `insert into knowledge (project_id, conversation_id, source_key, kind, status, superseded_by_id, body, occurred_at, content_hash)
     values (?, 'cc-1', 'claude-code:s1#old', 'decision', 'superseded', ?, 'Use Postgres', ?, ?)`,
    p,
    decision,
    at("2026-09-09T00:00:00Z"),
    hash() as unknown as string,
  );
  const seq = Number(one(raw, "select seq from sqlite_sequence where name = 'knowledge'")?.seq);
  return { raw, file, p, doc, decision, option, verification, older, seq };
}

test("0006 and 0007 keep PR decisions and the trace rows that point at them, drop the bulk import, and match a new database", () => {
  const x = r5WithImport();
  const { raw } = x;
  const applied = applyMigrations(raw, fs.readdirSync(MIGRATIONS), MIGRATIONS);
  assert.deepEqual(
    applied.map((m) => m.revision),
    [6, 7],
  );
  assert.equal(Number(one(raw, "pragma user_version")?.user_version), SCHEMA_REVISION);
  assert.equal(Number(one(raw, "pragma foreign_keys")?.foreign_keys), 1);
  assert.deepEqual(raw.prepare("pragma foreign_key_check").all(), []);
  const pr = one(raw, "select id, number, title, url, state, github_id, harvested_at from pull_request");
  assert.deepEqual(
    { ...pr },
    {
      id: pr?.id,
      number: 5,
      title: "Keep SQLite",
      url: "https://github.com/o/r/pull/5",
      state: "merged",
      github_id: null,
      harvested_at: null,
    },
  );
  const row = (k: number) => ({
    ...one(
      raw,
      "select source_key, pull_request_id, conversation_id, decision_id, superseded_by_id from knowledge where id = ?",
      k,
    ),
  });
  assert.deepEqual(row(x.decision), {
    source_key: "pr:5#abcdef012345-1",
    pull_request_id: pr?.id,
    conversation_id: null,
    decision_id: null,
    superseded_by_id: null,
  });
  assert.deepEqual(row(x.option), {
    source_key: "pr:5#abcdef012345-1.r1",
    pull_request_id: pr?.id,
    conversation_id: null,
    decision_id: x.decision,
    superseded_by_id: null,
  });
  assert.equal(row(x.verification).decision_id, x.decision, "the trace verification keeps its target");
  assert.equal(
    row(x.older).superseded_by_id,
    x.decision,
    "the superseded trace decision keeps its successor",
  );
  assert.equal(
    count(raw, `select count(*) as n from knowledge where id = ${x.doc}`),
    0,
    "document sections go",
  );
  assert.equal(count(raw, "select count(*) as n from conversation"), 1, "GitHub conversations go");
  assert.equal(count(raw, "select count(*) as n from message"), 0);
  assert.equal(count(raw, "select count(*) as n from message_file"), 0);
  assert.deepEqual({ ...one(raw, "select source from knowledge_terms") }, { source: "import" });
  assert.deepEqual(matches(raw, "prdecision"), [x.decision], "the index finds the moved decision");
  assert.deepEqual(matches(raw, "docword"), []);
  for (const table of ["source_item", "connector", "docs_exclude", "person", "person_identity"])
    assert.equal(count(raw, `select count(*) as n from sqlite_schema where name = '${table}'`), 0, table);
  // Deleted and moved ids are not reused
  assert.equal(Number(one(raw, "select seq from sqlite_sequence where name = 'knowledge'")?.seq), x.seq);
  // Capture at the old version keeps writing through the views
  raw
    .prepare(
      "insert into capture_conversation (id, project_id, origin, external_id, started_at) values ('cc-2', ?, 'codex', 's2', ?)",
    )
    .run(x.p, at("2026-09-13T00:00:00Z"));
  raw
    .prepare(
      "insert into capture_message (id, conversation_id, external_id, speaker_kind, body, truncated, original_bytes, sent_at, content_hash, indexed) values ('m-2', 'cc-2', 'e', 'self', 'after migrate', 0, 13, ?, ?, 1)",
    )
    .run(at("2026-09-13T00:00:00Z"), hash());
  raw
    .prepare("insert into capture_message_file (message_id, path, action) values ('m-2', 'a.ts', 'edit')")
    .run();
  assert.equal(count(raw, "select count(*) as n from message_file"), 1);
  // The schema equals that of a new database, apart from SQL comments (databases created from the r1 schema keep its Japanese comments)
  assert.deepEqual(schemaOf(raw), freshSchema());
  raw.close();
});

// trace can only point at decisions, but a database could hold anything. A record depending on a document section stops 0006 before it deletes.
test("0006 stops before deleting anything when a record points at a document section", () => {
  const x = r5WithImport();
  x.raw.prepare("update knowledge set decision_id = ? where id = ?").run(x.doc, x.verification);
  assert.throws(
    () => applyMigrations(x.raw, fs.readdirSync(MIGRATIONS), MIGRATIONS),
    /CHECK constraint failed/,
  );
  assert.equal(Number(one(x.raw, "pragma user_version")?.user_version), 5);
  assert.equal(count(x.raw, `select count(*) as n from knowledge where id = ${x.doc}`), 1);
  assert.equal(count(x.raw, "select count(*) as n from sqlite_schema where name = 'pull_request'"), 0);
  x.raw.close();
});
