// Moves a project after its repository was renamed. Ids, keys, bodies, and search words must survive; harvested pull requests point at
// the new repository.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { moveProject } from "../src/move.ts";
import { harvested, knowledge, tempDb } from "./temp-db.ts";

const realHome = process.env.HOME;
let home = "";
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-move-home-"));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const FROM = "git:github.com/o/old";
const TO = { key: "git:github.com/o/new", root: "/nonexistent/new", name: "o/new" };

function spool(dir: string, name: string, project: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ v: 1, kind: "message", project, body: "本文はそのまま" }));
  return file;
}
const projectOf = (file: string) =>
  (JSON.parse(fs.readFileSync(file, "utf8")) as { project: string }).project;

function setup() {
  const db = tempDb();
  const p = Number(
    (
      db.owner.prepare("insert into project (key, name) values (?, 'o/old') returning id").get(FROM) as {
        id: number;
      }
    ).id,
  );
  harvested(db, p, {
    number: 5,
    key: "keep",
    body: "実 DB で確かめる",
    kind: "decision",
    status: "accepted",
  });
  db.owner.prepare("update pull_request set url = ? where number = 5").run("https://github.com/o/old/pull/5");
  knowledge(db, p, { source_key: "claude-code:s1#t", body: "セッションで決めた" });
  db.owner.exec(
    "insert into knowledge_terms (knowledge_id, terms, content_hash, source, written_at) select id, 'extra' || id, content_hash, 'import', '2026-09-12T00:00:00.000Z' from knowledge",
  );
  const sp = path.join(home, ".sphica", "spool");
  const files = {
    queued: spool(sp, "a.json", FROM),
    held: spool(path.join(sp, "unregistered"), "b.json", FROM),
    rejected: spool(path.join(sp, "rejected"), "c.json", FROM),
    other: spool(sp, "d.json", "git:github.com/o/other"),
  };
  return { db, p, files };
}

/** Rows as plain objects (node:sqlite returns them without a prototype, which deepStrictEqual compares) */
const rows = (db: ReturnType<typeof tempDb>, sql: string) =>
  db.owner
    .prepare(sql)
    .all()
    .map((r) => ({ ...r }));

test("a move changes the key, the spool, and harvested URLs, and keeps ids, keys, and search words", async () => {
  const { db, files } = setup();
  try {
    const before = rows(db, "select id, source_key, content_hash from knowledge order by id");
    const words = rows(db, "select knowledge_id, content_hash from knowledge_terms order by knowledge_id");
    const dry = await moveProject(db.ingest, FROM, TO, false);
    assert.deepEqual(
      { ...dry, spooled: undefined },
      { from: FROM, to: TO.key, pullRequests: 1, applied: false, spooled: undefined },
    );
    assert.equal(projectOf(files.queued), FROM, "a dry run writes nothing");
    const moved = await moveProject(db.ingest, FROM, TO, true);
    assert.deepEqual(moved.spooled, { pending: 1, held: 1, rejected: 1 });
    assert.equal(projectOf(files.queued), TO.key);
    assert.equal(projectOf(files.held), TO.key);
    assert.equal(projectOf(files.rejected), TO.key);
    assert.equal(projectOf(files.other), "git:github.com/o/other");
    assert.deepEqual(rows(db, "select key, name from project"), [{ key: TO.key, name: "o/new" }]);
    assert.deepEqual(rows(db, "select url from pull_request"), [{ url: "https://github.com/o/new/pull/5" }]);
    assert.deepEqual(rows(db, "select id, source_key, content_hash from knowledge order by id"), before);
    assert.deepEqual(
      rows(db, "select knowledge_id, content_hash from knowledge_terms order by knowledge_id"),
      words,
    );
  } finally {
    await db.done();
  }
});

test("a move refuses a key that is already registered and a remote that did not change", async () => {
  const { db } = setup();
  try {
    db.owner.prepare("insert into project (key, name) values (?, 'o/new')").run(TO.key);
    await assert.rejects(moveProject(db.ingest, FROM, TO, true), /already registered/);
    await assert.rejects(moveProject(db.ingest, FROM, { ...TO, key: FROM }, true), /already/);
  } finally {
    await db.done();
  }
});

test("a run stopped after rewriting the spool can be run again", async () => {
  const { db, files } = setup();
  try {
    // The spool step is idempotent: records already moved are not touched again, and the database still has the old key.
    const first = JSON.parse(fs.readFileSync(files.queued, "utf8"));
    fs.writeFileSync(files.queued, JSON.stringify({ ...first, project: TO.key }));
    const moved = await moveProject(db.ingest, FROM, TO, true);
    assert.deepEqual(moved.spooled, { pending: 0, held: 1, rejected: 1 });
    assert.equal(projectOf(files.queued), TO.key);
    assert.equal(projectOf(files.held), TO.key);
  } finally {
    await db.done();
  }
});
