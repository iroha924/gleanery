import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { listSessions, listWork, projects, searchSessions, sessionDetail } from "../src/sessions.ts";
import { at, hash, insert, knowledge, message, project, type TempDb, tempDb } from "./temp-db.ts";

let db: TempDb;
let p1: number;
let p2: number;
before(() => {
  db = tempDb();
  p1 = project(db);
  p2 = project(db, "git:github.com/o/other", "o/other");
  // A session that starts with a paste. The first message starts with the host's wrapper tag.
  message(db, p1, {
    id: "m-a1",
    session: "a",
    body: '<pasted_content id="90a1">\ngleanery を SQLite へ移す</pasted_content> 続きも',
    sent: "2026-09-10T00:00:00Z",
  });
  message(db, p1, {
    id: "m-a2",
    session: "a",
    body: "AI の応答",
    speaker: "assistant",
    indexed: 0,
    sent: "2026-09-10T00:01:00Z",
  });
  insert(db, "message_file", { message_id: "m-a1", path: "server/src/db.ts", action: "edit" });
  insert(db, "message_file", { message_id: "m-a2", path: "server/src/db.ts", action: "edit" });
  message(db, p1, { id: "m-b1", session: "b", body: "認証の話", sent: "2026-09-12T00:00:00Z" });
  message(db, p2, { id: "m-c1", session: "c", body: "別のプロジェクトの認証", sent: "2026-09-11T00:00:00Z" });
  insert(db, "connector", {
    project_id: p1,
    provider: "github",
    last_success_at: at("2026-09-13T00:00:00Z"),
  });
});
after(() => db.done());

test("the project list is sorted by name and has session and knowledge counts and source status", async () => {
  const got = await projects(db.reader);
  assert.deepEqual(
    got.map((x) => [x.name, x.sessions]),
    [
      ["o/other", 1],
      ["o/r", 2],
    ],
  );
  assert.deepEqual(got[1]?.connectors, [
    { provider: "github", lastSuccessAt: new Date("2026-09-13T00:00:00Z"), lastError: null },
  ]);
});

test("the session list is newest by last message, strips wrapper tags from titles, and counts touched files without duplicates", async () => {
  const page = await listSessions(db.reader, { project: p1, page: 1, pageSize: 30 });
  assert.equal(page.total, 2);
  assert.deepEqual(
    page.items.map((i) => i.sessionId),
    ["b", "a"],
  );
  const a = page.items[1];
  assert.equal(a?.title, "gleanery を SQLite へ移す 続きも");
  assert.equal(a?.said, 1);
  assert.equal(a?.files, 1);
  assert.equal(a?.lastAt?.toISOString(), "2026-09-10T00:01:00.000Z");
  const second = await listSessions(db.reader, { project: p1, page: 2, pageSize: 1 });
  assert.deepEqual(
    second.items.map((i) => i.sessionId),
    ["a"],
  );
  assert.equal(
    (await listSessions(db.reader, { page: 1, pageSize: 30 })).total,
    3,
    "all projects when none is given",
  );
});

test("a missing session is null", async () => {
  assert.equal(await sessionDetail(db.reader, "無い"), null);
});

test("session details gather messages, touched files, knowledge, and work, with labels on knowledge", async () => {
  const conversation = `c-${p1}-a`;
  insert(db, "knowledge", {
    project_id: p1,
    conversation_id: conversation,
    source_key: "a#d",
    kind: "decision",
    status: "accepted",
    body: "こうする",
    occurred_at: at("2026-09-10T00:02:00Z"),
    content_hash: hash(),
  });
  insert(db, "work_item", {
    project_id: p1,
    source_key: "w",
    title: "作業",
    goal: "目的",
    current: "いま",
    next: '["次"]',
    status: "active",
    conversation_id: conversation,
    updated_at: at("2026-09-10T00:03:00Z"),
  });
  const found = await sessionDetail(db.reader, conversation);
  assert.equal(found?.title, "gleanery を SQLite へ移す 続きも");
  assert.deepEqual(
    found?.messages.map((m) => [m.speaker, m.files.map((f) => f.path)]),
    [
      ["self", ["server/src/db.ts"]],
      ["assistant", ["server/src/db.ts"]],
    ],
  );
  assert.equal(found?.knowledge[0]?.label, "[decision]");
  assert.deepEqual(found?.work[0]?.next, ["次"]);
});

test("the work list includes finished work and filters by project", async () => {
  insert(db, "work_item", {
    project_id: p2,
    source_key: "done",
    title: "終わった作業",
    goal: "目的",
    current: "済んだ",
    status: "done",
    updated_at: at("2026-09-09T00:00:00Z"),
  });
  const only = await listWork(db.reader, [p2]);
  assert.deepEqual(
    only.items.map((w) => [w.title, w.status]),
    [["終わった作業", "done"]],
  );
  assert.equal(only.more, false);
  assert.ok((await listWork(db.reader, null)).items.length >= 2);
});

test("reports when the work list is cut at the limit", async () => {
  const all = (await listWork(db.reader, null)).items.length;
  assert.ok(all >= 2);
  const cut = await listWork(db.reader, null, all - 1);
  assert.equal(cut.items.length, all - 1);
  assert.equal(cut.more, true);
  const exact = await listWork(db.reader, null, all);
  assert.equal(exact.items.length, all);
  assert.equal(exact.more, false);
});

test("groups matched messages by session and strips wrapper tags from titles", async () => {
  assert.deepEqual(await searchSessions(db.reader, { q: "当たらない語", mode: "said" }), []);
  const found = await searchSessions(db.reader, { q: "SQLite", mode: "said", project: p1 });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.sessionId, "a");
  assert.equal(found[0]?.title, "gleanery を SQLite へ移す 続きも");
  const all = await searchSessions(db.reader, { q: "認証", mode: "said" });
  assert.deepEqual(new Set(all.map((s) => s.sessionId)), new Set(["b", "c"]));
  knowledge(db, p1, { source_key: "k#auth", body: "認証は OAuth" });
  const byKnowledge = await searchSessions(db.reader, { q: "OAuth", mode: "knowledge", project: p1 });
  assert.equal(byKnowledge[0]?.hits[0]?.text, "認証は OAuth");
});

test("titles without tags and titles that are only a tag are shown as is", async () => {
  const p3 = project(db, "git:github.com/o/third", "o/third");
  message(db, p3, { id: "m-x", session: "x", body: "a < b > c" });
  message(db, p3, { id: "m-y", session: "y", body: "<x>", sent: "2026-09-09T00:00:00Z" });
  const page = await listSessions(db.reader, { project: p3, page: 1, pageSize: 30 });
  assert.deepEqual(
    page.items.map((i) => i.title),
    ["a < b > c", "<x>"],
  );
});

// A session with only trace and no linked work has no owner message or work title. A blank title would not identify it.
test("a session without a title is named by its session id", async () => {
  const p4 = project(db, "git:github.com/o/fourth", "o/fourth");
  insert(db, "conversation", {
    id: "c-none",
    project_id: p4,
    origin: "codex",
    external_id: "only-trace",
    started_at: at("2026-09-08T00:00:00Z"),
  });
  const page = await listSessions(db.reader, { project: p4, page: 1, pageSize: 30 });
  assert.equal(page.items[0]?.title, "(untitled) only-trace");
  assert.equal((await sessionDetail(db.reader, "c-none"))?.title, "(untitled) only-trace");
});
