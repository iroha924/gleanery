import assert from "node:assert/strict";
import { test } from "node:test";
import { listSessions, listWork, projects, searchSessions, sessionDetail } from "../src/sessions.ts";
import { fakeDb } from "./fake-db.ts";

const at = new Date("2026-09-20T01:00:00Z");

test("作業場所の一覧は名前順で、行をそのまま返す", async () => {
  const row = { id: 1, key: "git:github.com/o/r", name: "o/r", sessions: 2, knowledge: 3, connectors: [] };
  const { db, calls } = fakeDb(() => [row]);
  assert.deepEqual(await projects(db), [row]);
  assert.match(calls[0]?.sql ?? "", /order by "p"\."name"/);
  assert.match(calls[0]?.sql ?? "", /c\.origin <> 'github'/);
});

test("セッションの一覧は GitHub の会話を外し、件数とページを返す", async () => {
  const item = {
    id: "00000000-0000-4000-8000-000000000001",
    origin: "claude-code",
    sessionId: "s1",
    branch: "main",
    startedAt: at,
    project: "o/r",
    lastAt: at,
    title: "題",
    said: 3,
    traced: 1,
    files: 2,
  };
  const { db, calls } = fakeDb((sql) => (sql.includes("count(*) as") ? [{ n: "31" }] : [item]));
  const page = await listSessions(db, { project: 7, page: 2, pageSize: 30 });
  assert.deepEqual(page, { items: [item], total: 31, page: 2, pageSize: 30, pages: 2 });
  for (const c of calls) assert.match(c.sql, /"c"\."origin" <> \$1/);
  // 2 ページ目は 30 件を飛ばす
  assert.deepEqual(calls[1]?.parameters.slice(-2), [30, 30]);
  assert.match(calls[1]?.sql ?? "", /count\(distinct f\.path\)/);
});

test("作業場所を指定しなければ全部の作業場所を数える", async () => {
  const { db, calls } = fakeDb((sql) => (sql.includes("count(*) as") ? [{ n: "0" }] : []));
  const page = await listSessions(db, { page: 1, pageSize: 30 });
  assert.equal(page.total, 0);
  assert.equal(page.pages, 0);
  assert.ok(calls[0]?.parameters.includes(null));
});

test("無い session は null で、後続の問い合わせを投げない", async () => {
  const { db, calls } = fakeDb(() => []);
  assert.equal(await sessionDetail(db, "00000000-0000-4000-8000-000000000001"), null);
  assert.equal(calls.length, 1);
});

test("session の詳細は発言・知識・作業・読んだ成果物をまとめ、知識に札を付ける", async () => {
  const conversation = {
    id: "00000000-0000-4000-8000-000000000001",
    origin: "codex",
    sessionId: "s1",
    branch: null,
    startedAt: at,
    projectId: 1,
    project: "o/r",
    projectKey: "git:github.com/o/r",
    title: "題",
  };
  const message = {
    id: "m1",
    speaker: "self",
    body: "直して",
    sentAt: at,
    truncated: false,
    originalBytes: 9,
    files: [],
  };
  const knowledge = {
    id: 5,
    kind: "decision",
    status: "accepted",
    stance: "do",
    body: "こうする",
    reason: "理由",
    confirmation: null,
    downsides: [],
    at,
    decisionId: null,
  };
  const { db, calls } = fakeDb(
    (_sql, _p, nth) => [[conversation], [message], [knowledge], [], []][nth] ?? [],
  );
  const found = await sessionDetail(db, conversation.id);
  assert.equal(found?.title, "題");
  assert.deepEqual(found?.messages, [message]);
  assert.equal(found?.knowledge[0]?.label, "【採用した決定】");
  assert.equal(calls.length, 5);
  // 成果物は同じ作業場所で同期された要件定義と設計書だけ
  assert.match(calls[4]?.sql ?? "", /"cn"\."project_id" = \$/);
});

test("作業の一覧は終わった作業も含め、作業場所で絞れる", async () => {
  const row = {
    id: "3",
    project: "o/r",
    title: "作業",
    goal: "目的",
    current: "いま",
    next: ["次"],
    status: "done",
    updated_at: at,
  };
  const { db, calls } = fakeDb(() => [row]);
  const works = await listWork(db, [1, 2]);
  assert.equal(works[0]?.ref, "w:3");
  assert.equal(works[0]?.status, "done");
  assert.doesNotMatch(calls[0]?.sql ?? "", /"w"\."status" in/);
  assert.match(calls[0]?.sql ?? "", /w\.project_id = any/);
  const all = fakeDb(() => []);
  await listWork(all.db, null);
  assert.doesNotMatch(all.calls[0]?.sql ?? "", /any/);
});

test("検索で当たらなければ session を引きに行かない", async () => {
  const { db, calls } = fakeDb(() => []);
  assert.deepEqual(await searchSessions(db, {}, { q: "認証", mode: "said" }), []);
  assert.equal(calls.length, 1);
});

test("当たった発言を session ごとに束ね、GitHub の会話を外す", async () => {
  const hit = (id: string) => ({
    id,
    body: `本文 ${id}`,
    speaker_kind: "self",
    sent_at: at,
    url: null,
    truncated: false,
    original_bytes: 10,
    origin: "claude-code",
    project: "o/r",
    title: null,
    source_kind: null,
    number: null,
    handle: null,
    display_name: null,
    is_self: null,
  });
  const a = "00000000-0000-4000-8000-00000000000a";
  const b = "00000000-0000-4000-8000-00000000000b";
  const owner = {
    id: "c1",
    sessionId: "s1",
    origin: "claude-code",
    project: "o/r",
    title: "<pasted_content>題</pasted_content>",
  };
  const { db, calls } = fakeDb((_sql, _p, nth) =>
    nth === 0
      ? [hit(a), hit(b)]
      : [
          { ...owner, ref: a },
          { ...owner, ref: b },
        ],
  );
  const found = await searchSessions(db, {}, { q: "認証", mode: "said", project: 1 });
  assert.equal(found.length, 1);
  // 題は一覧と同じく囲みの札を外す
  assert.equal(found[0]?.title, "題");
  assert.deepEqual(
    found[0]?.hits.map((h) => h.ref),
    [`m:${a}`, `m:${b}`],
  );
  assert.match(calls[1]?.sql ?? "", /c\.origin <> 'github'/);
  assert.match(calls[1]?.sql ?? "", /"gleanery"\."message"/);
});

// 貼り付けで始めた session は、最初の発言がホストの囲みの札で始まる。札が題の幅を食うと見分けられない。
test("題の頭に付いた囲みの札を外し、一覧・詳細・検索で同じ題にする", async () => {
  const raw = '<pasted_content id="90a1">\ngleanery を SQLite へ移す</pasted_content> 続きも';
  const row = {
    id: "00000000-0000-4000-8000-000000000001",
    title: raw,
    ref: "1",
    sessionId: "s1",
    origin: "claude-code",
    project: "o/r",
  };
  const list = await listSessions(fakeDb((sql) => (sql.includes("count(*) as") ? [{ n: "1" }] : [row])).db, {
    project: null,
    page: 1,
    pageSize: 30,
  });
  assert.equal(list.items[0]?.title, "gleanery を SQLite へ移す 続きも");
  const detail = await sessionDetail(fakeDb((_sql, _p, n) => (n === 0 ? [row] : [])).db, row.id);
  assert.equal(detail?.title, "gleanery を SQLite へ移す 続きも");
  // 札の無い題と、札だけの題はそのまま
  const plain = await listSessions(
    fakeDb((sql) =>
      sql.includes("count(*) as")
        ? [{ n: "2" }]
        : [
            { ...row, title: "a < b > c" },
            { ...row, title: "<x>" },
          ],
    ).db,
    { project: null, page: 1, pageSize: 30 },
  );
  assert.deepEqual(
    plain.items.map((i) => i.title),
    ["a < b > c", "<x>"],
  );
});
