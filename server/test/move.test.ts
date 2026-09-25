// Moves a project after its repository was renamed, then syncs GitHub under the new name. Ids, bodies, and search words must survive.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { decisionHash } from "../src/decisions.ts";
import { type GithubSource, syncGithub } from "../src/github.ts";
import { moveProject } from "../src/move.ts";
import { tempDb } from "./temp-db.ts";

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

const me = { id: 1, login: "me" };
const BODY = [
  "本文",
  "",
  "## 採った案と棄却した案",
  "",
  "- 採った: 実 DB。棄却: 偽の db（権限が見えない）、文字列の照合（実行されない SQL が通る）",
  "- 採った: begin immediate。棄却: 既定の begin（busy_timeout を待たずに落ちる）",
  "",
].join("\n");

/** One merged PR of the owner's with one comment, served under repo */
const github = (repo: string): GithubSource => ({
  pulls: async () => [
    {
      number: 5,
      title: "取り込みを直す",
      body: BODY,
      user: me,
      state: "closed",
      merged_at: "2026-09-11T02:00:00Z",
      closed_at: "2026-09-11T02:00:00Z",
      created_at: "2026-09-10T02:00:00Z",
      updated_at: "2026-09-11T02:00:00Z",
      html_url: `https://github.com/${repo}/pull/5`,
    },
  ],
  issues: async () => [],
  reviewComments: async () => [],
  issueComments: async () => [
    {
      id: 40,
      user: me,
      body: "これで直る",
      created_at: "2026-09-10T03:00:00Z",
      html_url: `https://github.com/${repo}/pull/5#issuecomment-40`,
      issue_url: `https://api.github.com/repos/${repo}/issues/5`,
    },
  ],
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

async function setup() {
  const db = tempDb();
  const p = Number(
    (
      db.owner.prepare("insert into project (key, name) values (?, 'o/old') returning id").get(FROM) as {
        id: number;
      }
    ).id,
  );
  const person = Number(
    (
      db.owner.prepare("insert into person (display_name, is_self) values ('私', 1) returning id").get() as {
        id: number;
      }
    ).id,
  );
  db.owner
    .prepare(
      "insert into person_identity (person_id, provider, external_id, handle) values (?, 'github', '1', 'me')",
    )
    .run(person);
  await syncGithub(db.ingest, p, "o/old", github("o/old"));
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

type Snapshot = { ids: string[]; words: number; bodies: string[]; keys: string[] };
function snapshot(db: ReturnType<typeof tempDb>): Snapshot {
  const col = (sql: string) =>
    db.owner
      .prepare(sql)
      .all()
      .map((r) => String(Object.values(r as object)[0]));
  return {
    ids: [
      ...col("select 'c:' || id from conversation order by id"),
      ...col("select 'm:' || id from message order by id"),
      ...col("select 'k:' || id from knowledge order by id"),
    ],
    words: Number(
      (
        db.owner
          .prepare(
            "select count(*) as n from knowledge_terms t join knowledge k on k.id = t.knowledge_id and k.content_hash = t.content_hash",
          )
          .get() as { n: number }
      ).n,
    ),
    bodies: [
      ...col("select body from message order by id"),
      ...col("select body from knowledge order by id"),
    ],
    keys: col("select source_key from knowledge order by id"),
  };
}
const found = (db: ReturnType<typeof tempDb>, word: string) =>
  db.owner.prepare("select rowid from knowledge_fts where knowledge_fts match ?").all(`"${word}"`).length;

test("a move keeps ids, bodies, and search words through a sync under the new name", async () => {
  const { db, p, files } = await setup();
  try {
    const before = snapshot(db);
    assert.equal(
      before.words,
      7,
      "each line gives a decision, its chosen option, and one row per rejected option",
    );
    assert.ok(before.keys.every((k) => k.startsWith("github:o/old/pull/5#")));

    const dry = await moveProject(db.ingest, FROM, TO, false);
    assert.deepEqual(dry, {
      from: FROM,
      to: TO.key,
      knowledge: 7,
      terms: 7,
      conversations: 1,
      spooled: 3,
      applied: false,
    });
    assert.equal(projectOf(files.queued), FROM, "a check writes nothing");
    assert.deepEqual(snapshot(db), before);

    const moved = await moveProject(db.ingest, FROM, TO, true);
    assert.equal(moved.applied, true);
    assert.deepEqual(
      db.owner.prepare("select key, name from project where id = ?").get(p),
      Object.assign(Object.create(null), { key: TO.key, name: "o/new" }),
    );
    for (const f of [files.queued, files.held, files.rejected]) assert.equal(projectOf(f), TO.key);
    assert.equal(projectOf(files.other), "git:github.com/o/other");
    assert.equal(
      (db.owner.prepare("select external_id from conversation").get() as { external_id: string }).external_id,
      "o/new#5",
    );

    await syncGithub(db.ingest, p, "o/new", github("o/new"));
    const after = snapshot(db);
    assert.deepEqual(after.ids, before.ids, "no row was deleted or added");
    assert.deepEqual(after.bodies, before.bodies);
    assert.equal(after.words, before.words, "search words still match their records");
    assert.deepEqual(
      after.keys,
      before.keys.map((k) => k.replace("github:o/old/", "github:o/new/")),
    );
    const k = before.ids.find((i) => i.startsWith("k:"))?.slice(2);
    assert.equal(found(db, `extra${k}`), 1, "the index still holds the words");
    assert.equal(
      (
        db.owner.prepare("select count(*) as n from knowledge where refs like '%o/old%'").get() as {
          n: number;
        }
      ).n,
      0,
    );

    await assert.rejects(moveProject(db.ingest, FROM, TO, true), /No project has the key/);
  } finally {
    await db.done();
  }
});

test("a move stops before writing when a record with search words has a hash the sync would not produce", async () => {
  const { db, files } = await setup();
  try {
    db.owner.exec(
      "update knowledge set content_hash = zeroblob(32) where source_key like '%.c' and id = (select min(id) from knowledge where source_key like '%.c')",
    );
    db.owner.exec(
      "update knowledge_terms set content_hash = zeroblob(32) where knowledge_id = (select min(id) from knowledge where source_key like '%.c')",
    );
    const before = snapshot(db);
    await assert.rejects(moveProject(db.ingest, FROM, TO, true), /search words.*\.c\b.*Nothing was moved/);
    assert.deepEqual(snapshot(db), before);
    assert.equal(projectOf(files.queued), FROM, "the spool is untouched too");
  } finally {
    await db.done();
  }
});

test("a move refuses a key that is already registered and a remote that did not change", async () => {
  const { db } = await setup();
  try {
    db.owner.prepare("insert into project (key, name) values (?, 'o/new')").run(TO.key);
    await assert.rejects(moveProject(db.ingest, FROM, TO, true), /already registered/);
    await assert.rejects(moveProject(db.ingest, FROM, { ...TO, key: FROM }, true), /already/);
  } finally {
    await db.done();
  }
});

test("a run stopped after rewriting the spool can be run again", async () => {
  const { db, files } = await setup();
  try {
    // The spool step is idempotent: records already moved are not touched again, and the database still has the old key.
    const first = JSON.parse(fs.readFileSync(files.queued, "utf8"));
    fs.writeFileSync(files.queued, JSON.stringify({ ...first, project: TO.key }));
    const moved = await moveProject(db.ingest, FROM, TO, true);
    assert.equal(moved.spooled, 2);
    assert.equal(projectOf(files.queued), TO.key);
    assert.equal(projectOf(files.held), TO.key);
  } finally {
    await db.done();
  }
});

test("rows last synced under an earlier rule move with their search words, and the next sync keeps them", async () => {
  const { db, p } = await setup();
  try {
    // The shape of a database last synced before the rule changed: hashes and the words bound to them use rule 1
    const rows = db.owner
      .prepare("select id, source_key, kind, body, reason, heading, refs, occurred_at from knowledge")
      .all() as {
      id: number;
      source_key: string;
      kind: string;
      body: string;
      reason: string | null;
      heading: string;
      refs: string;
      occurred_at: string;
    }[];
    for (const r of rows) {
      const m = /^(.*#[0-9a-f]{12}-\d+)(?:\.(c|r\d+))?$/.exec(r.source_key);
      const status = !m?.[2] ? "accepted" : m[2] === "c" ? "chosen" : "rejected";
      const old = decisionHash(
        { ...r, status, occurred: r.occurred_at, parent: m?.[2] ? (m[1] ?? null) : null },
        1,
      );
      db.owner.prepare("update knowledge set content_hash = ? where id = ?").run(old, r.id);
      db.owner.prepare("update knowledge_terms set content_hash = ? where knowledge_id = ?").run(old, r.id);
    }
    const before = snapshot(db);
    assert.equal(before.words, 7);

    await moveProject(db.ingest, FROM, TO, true);
    await syncGithub(db.ingest, p, "o/new", github("o/new"));
    const after = snapshot(db);
    assert.deepEqual(after.ids, before.ids);
    assert.equal(after.words, 7, "the words follow the current rule's hash");
  } finally {
    await db.done();
  }
});
