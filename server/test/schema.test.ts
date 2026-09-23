// db/schema.sql の制約が、PostgreSQL の実装と同じものを拒み、同じものを通すか。
// 書き込みは owner の接続で行う（authorizer ではなく schema そのものを見る）。

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { at, hash, insert, type TempDb, tempDb } from "./temp-db.ts";

let db: TempDb;
let p: number;
let conversation: string;
let connector: number;
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
  connector = insert(db, "connector", { project_id: p, provider: "github" });
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

const item = (v: Record<string, string | number | Buffer | null>) => ({
  connector_id: connector,
  external_id: String(Math.random()),
  title: "題",
  content_hash: hash(),
  ...v,
});
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

test("取り込み元の項目は種類ごとの形を守る", () => {
  insert(db, "source_item", item({ kind: "document", path: "a.md", body: "本文" }));
  rejects("source_item", item({ kind: "pull_request", state: "open", path: "a.md" }));
  rejects("source_item", item({ kind: "pull_request" }));
  rejects("source_item", item({ kind: "issue", state: "open", closed_at: at("2026-09-01T00:00:00Z") }));
  rejects("source_item", item({ kind: "document", path: "a.md", body: "b", content_hash: Buffer.alloc(31) }));
  rejects("source_item", item({ kind: "document", path: "../a.md", body: "b" }));
  rejects("source_item", item({ kind: "document", path: "/a.md", body: "b" }));
  rejects("source_item", item({ kind: "document", path: "a/../b.md", body: "b" }));
  rejects("source_item", item({ kind: "document", path: "a.md", body: "b", metadata: "[]" }));
});

test("知識は種類と状態の組・案の親・覆しの後継を守り、stance は種類と状態から決まる", () => {
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

// 時刻は文字列の辞書順で比べる。ミリ秒の無い形や時差付きが混ざると、同じ秒の中で並びが狂い、日付の境界で外れる。
test("時刻は ISO 8601 の UTC（ミリ秒まで）の形だけを受ける", () => {
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

test("発言の大きさは本文のバイト数と合い、主キーと id は null を受けない", () => {
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
  // STRICT: 型の違う値を黙って入れない（失わずに変わる "1" は受け、変わらない値を拒む）
  rejects("message", { ...ok("m4", "x"), original_bytes: "abc" as unknown as number }, /cannot store/);
});

// PostgreSQL の正規表現 `^(git:[^[:space:]]+|local:[a-z0-9][a-z0-9._-]*)$` と 12 例で突き合わせた（plan 3.3）。
test("プロジェクトの key は PostgreSQL の実装と同じものを通し、同じものを拒む", () => {
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

test("取り込まない path は末尾のスラッシュと制御文字を拒む", () => {
  for (const path of ["a/", "a\u0001b", "a\u007fb", "a\u001fb", "..", "../a"])
    rejects("docs_exclude", { connector_id: connector, kind: "file", path });
  insert(db, "docs_exclude", { connector_id: connector, kind: "file", path: "..config/a.md" });
});

// 暗黙の rowid は VACUUM で振り直されうる。FTS の rowid は明示の seq に結ぶ。
test("発言の索引は VACUUM の後も引け、会話を消すと発言も索引も消える", () => {
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
  assert.deepEqual(hit('"残る"'), [], "cascade で索引も消える");
  db.owner.exec("insert into message_fts (message_fts, rank) values ('integrity-check', 1)");
  db.owner.exec("insert into knowledge_fts (knowledge_fts, rank) values ('integrity-check', 1)");
  assert.deepEqual(db.owner.prepare("pragma foreign_key_check").all(), []);
});

test("知識の索引は見出し・本文・理由のどれでも引け、書き換えに追従する", () => {
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
