// Whether the constraints in db/schema.sql reject what they should and accept what they should.
// Writes use the owner connection (testing the schema itself, not the authorizer).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { at, hash, insert, type TempDb, tempDb } from "./temp-db.ts";

let db: TempDb;
let p: number;
let conversation: string;
let pr: number;
before(() => {
  db = tempDb();
  p = insert(db, "project", { key: "git:github.com/o/r", name: "o/r" });
  conversation = "c1";
  insert(db, "conversation", {
    id: conversation,
    project_id: p,
    origin: "codex",
    external_id: "s",
    started_at: at("2026-09-01T00:00:00Z"),
  });
  pr = insert(db, "pull_request", { project_id: p, number: 1, title: "題", state: "merged" });
});
after(() => db.done());

const rejects = (
  table: string,
  v: Record<string, string | number | Buffer | null>,
  why: RegExp = /constraint failed/,
) =>
  assert.throws(
    () => insert(db, table, v),
    why,
    `${table} ${JSON.stringify(v, (_k, x) => (Buffer.isBuffer(x) ? "<hash>" : x))}`,
  );

const fact = (v: Record<string, string | number | Buffer | null>) => ({
  project_id: p,
  conversation_id: conversation,
  source_key: `k${Math.random()}`,
  kind: "finding",
  body: "本文",
  occurred_at: at("2026-09-01T00:00:00Z"),
  content_hash: hash(),
  ...v,
});

test("pull requests keep a positive number, one row per number, and a known state", () => {
  rejects("pull_request", { project_id: p, number: 0, title: "題", state: "open" });
  rejects("pull_request", { project_id: p, number: 2, title: "題", state: "draft" });
  rejects("pull_request", { project_id: p, number: 2, title: "", state: "open" });
  rejects("pull_request", { project_id: p, number: 1, title: "題", state: "open" }, /UNIQUE/);
  rejects("pull_request", {
    project_id: p,
    number: 3,
    title: "題",
    state: "open",
    harvested_at: "2026-09-01T00:00:00Z",
  });
});

// A record comes from the session trace read or the pull request harvest read, never both and never neither.
test("knowledge has exactly one provenance, and document sections are gone", () => {
  insert(db, "knowledge", fact({ conversation_id: null, pull_request_id: pr }));
  rejects("knowledge", fact({ pull_request_id: pr }));
  rejects("knowledge", fact({ conversation_id: null }));
  rejects("knowledge", fact({ kind: "document", heading: "h" }));
});

test("knowledge enforces kind and status pairs, option parents, and successors, and stance follows kind and status", () => {
  const d = insert(db, "knowledge", fact({ kind: "decision", status: "accepted" }));
  const stance = db.owner.prepare("select stance from knowledge where id = ?").get(d) as { stance: string };
  assert.equal(stance.stance, "do");
  rejects("knowledge", fact({ kind: "option", status: "rejected" }));
  rejects("knowledge", fact({ kind: "finding", status: "active" }));
  rejects("knowledge", fact({ kind: "decision", status: "accepted", confirmation: null, command: "x" }));
  rejects("knowledge", fact({ kind: "finding", confirmation: "x" }));
  rejects("knowledge", fact({ kind: "decision", status: "superseded" }));
  rejects("knowledge", fact({ kind: "finding", downsides: '["x"]' }));
  rejects("knowledge", fact({ kind: "finding", refs: "{}" }));
  rejects("knowledge", fact({ kind: "finding", occurred_at: "2026-09-01T00:00:00Z" }));
});

// Times compare as strings. Mixing forms without milliseconds or with offsets breaks ordering within a second and at date boundaries.
test("times accept only ISO 8601 UTC with milliseconds", () => {
  for (const bad of [
    "2026-09-01T00:00:00Z",
    "2026-09-01T09:00:00.000+09:00",
    "2026-02-30T00:00:00.000Z",
    "garbage",
  ])
    rejects("conversation", {
      id: `c-${bad}`,
      project_id: p,
      origin: "codex",
      external_id: bad,
      started_at: bad,
    });
});

test("message size matches the body byte count, and primary keys and ids reject null", () => {
  const ok = (id: string, body: string) => ({
    id,
    conversation_id: conversation,
    external_id: id,
    speaker_kind: "self",
    body,
    original_bytes: Buffer.byteLength(body),
    sent_at: at("2026-09-01T00:00:00Z"),
    content_hash: hash(),
    indexed: 1,
  });
  insert(db, "message", ok("m1", "日本語とasciiの混在"));
  rejects("message", { ...ok("m2", "こんにちは"), original_bytes: 5 });
  rejects("message", { ...ok("m3", "abc"), truncated: 1 });
  rejects("message", ok(null as unknown as string, "x"));
  rejects("conversation", {
    id: null,
    project_id: p,
    origin: "codex",
    external_id: "n",
    started_at: at("2026-09-01T00:00:00Z"),
  });
  // STRICT: no silent type mismatches (accepts "1", which converts without loss, and rejects values that do not convert)
  rejects("message", { ...ok("m4", "x"), original_bytes: "abc" as unknown as number }, /cannot store/);
});

// A key is only `git:<text without spaces>` or `local:<name starting with a lowercase letter or digit>`.
test("project keys accept only the defined forms", () => {
  const cases: [string, boolean][] = [
    ["git:github.com/o/r2", true],
    ["local:my-app.v2", true],
    ["git:a b", false],
    ["git:a\tb", false],
    ["git:a\nb", false],
    ["git:a\rb", false],
    ["git:a\vb", false],
    ["git:a\fb", false],
    ["git:", false],
    ["local:My", false],
    ["local:a:b", false],
    ["svn:x", false],
  ];
  for (const [key, ok] of cases) {
    if (ok) insert(db, "project", { key, name: key });
    else rejects("project", { key, name: key });
  }
});

// VACUUM can renumber implicit rowids. The FTS rowid is tied to the explicit seq.
test("the message index still works after VACUUM, and deleting a conversation removes its messages and index entries", () => {
  const c = "c-fts";
  insert(db, "conversation", {
    id: c,
    project_id: p,
    origin: "codex",
    external_id: "fts",
    started_at: at("2026-09-01T00:00:00Z"),
  });
  const add = (id: string, body: string) =>
    insert(db, "message", {
      id,
      conversation_id: c,
      external_id: id,
      speaker_kind: "self",
      body,
      original_bytes: Buffer.byteLength(body),
      sent_at: at("2026-09-01T00:00:00Z"),
      content_hash: hash(),
      indexed: 1,
    });
  add("u1", "再送の話");
  add("u2", "消す発言");
  add("u3", "残る発言");
  db.owner.prepare("delete from message where id = 'u2'").run();
  db.owner.exec("vacuum");
  const hit = (q: string) =>
    (
      db.owner
        .prepare("select m.id from message_fts f join message m on m.seq = f.rowid where message_fts match ?")
        .all(q) as { id: string }[]
    ).map((r) => r.id);
  assert.deepEqual(hit('"再送"'), ["u1"]);
  assert.deepEqual(hit('"消す"'), []);
  assert.deepEqual(hit('"残る"'), ["u3"]);
  db.owner.prepare("delete from conversation where id = ?").run(c);
  assert.deepEqual(hit('"残る"'), [], "cascade removes the index entries too");
  db.owner.exec("insert into message_fts (message_fts, rank) values ('integrity-check', 1)");
  db.owner.exec("insert into knowledge_fts (knowledge_fts, rank) values ('integrity-check', 1)");
  assert.deepEqual(db.owner.prepare("pragma foreign_key_check").all(), []);
});

test("the knowledge index matches heading, body, or reason, and follows updates", () => {
  const k = insert(db, "knowledge", fact({ heading: "見出しの語", body: "柑橘の語", reason: "理由の語" }));
  const hit = (q: string) =>
    (
      db.owner.prepare("select rowid from knowledge_fts where knowledge_fts match ?").all(q) as {
        rowid: number;
      }[]
    ).map((r) => r.rowid);
  for (const q of ['"見出し"', '"柑橘"', '"理由"']) assert.deepEqual(hit(q), [k], q);
  db.owner.prepare("update knowledge set body = '書き換えた' where id = ?").run(k);
  assert.deepEqual(hit('"柑橘"'), []);
  assert.deepEqual(hit('"書き換え"'), [k]);
});
