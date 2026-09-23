// revision 1 の DB から、要件定義・設計書の種類を外す migration（0002・0003）を当てる。
// 0003 は表を作り直すので、外部キーが効いたままだと、残すべき子の行まで cascade で消える。

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

test("要件定義・設計書の行と子孫だけが消え、ほかは残り、新しく作った DB と同じ schema になる", () => {
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
    [2, 3],
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
  assert.equal(count(raw, "select count(*) as n from knowledge_file"), 1, "消した節のファイルだけが消える");
  assert.equal(count(raw, "select count(*) as n from conversation"), 1);
  assert.equal(count(raw, "select count(*) as n from message"), 1);
  assert.equal(
    count(raw, "select count(*) as n from message_file where action = 'read'"),
    1,
    "読んだ記録は履歴として残す",
  );
  assert.deepEqual(matches(raw, "keepword"), [keepDoc]);
  assert.deepEqual(matches(raw, "reqword"), []);
  assert.deepEqual(matches(raw, "desword"), []);
  assert.equal(desSec > 0, true);

  // 消した id を振り直さない
  const next = source(raw, docs, "document", { path: "docs/b.md", body: "次" });
  assert.ok(next > seqBefore, `次の id ${next} が移行前の最大 ${seqBefore} を越える`);
  assert.throws(
    () => source(raw, docs, "requirements", { path: "r.md", body: "x" }),
    /CHECK constraint failed/,
  );

  // 新しく作った DB と schema が文字列で一致する
  const fresh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-fresh-")), "gleanery.db");
  dbInit(fresh);
  const schemaOf = (db: DatabaseSync) =>
    db
      .prepare(
        "select type, name, tbl_name, sql from sqlite_schema where name not like 'sqlite_%' order by type, name",
      )
      .all();
  const freshRaw = connectWriter("owner", fresh);
  assert.deepEqual(schemaOf(raw), schemaOf(freshRaw));
  freshRaw.close();
  raw.close();
});

test("残る source_item が 0 件でも、消した id を振り直さない", () => {
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
  assert.ok(next > last, `次の id ${next} が消した ${last} を越える`);
  raw.close();
});

// 宣言を消すと、0003 は外部キーが効いたまま表を作り直し、子の行を消す。宣言が付いていることを固定する。
test("表を作り直す 0003 は外部キーを切る宣言を持つ", () => {
  const file = fs.readdirSync(MIGRATIONS).find((f) => f.startsWith("0003_"));
  assert.ok(file, "0003 がある");
  assert.equal(
    fs.readFileSync(path.join(MIGRATIONS, file), "utf8").split("\n")[0],
    "-- gleanery: foreign_keys=off",
  );
});
