import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { checkTrace, rows, saveTrace, type Trace } from "../src/trace.ts";
import { project, tempDb } from "./temp-db.ts";

const at = "2026-09-13T10:00:00+09:00";
const base = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  schema: "trace/1",
  session: { host: "claude-code", id: "s1" },
  items,
  ...extra,
});
const decision = (over: Record<string, unknown> = {}) => ({
  key: "d-fts5",
  kind: "decision",
  status: "accepted",
  at,
  text: "全文検索は FTS5 で持つ",
  context: "外部のサービスに頼らずに全文検索したい",
  options: [
    { text: "FTS5", chosen: true },
    { text: "外部の検索サービス", chosen: false, why: "資格情報とネットワークが要る" },
  ],
  confirmation: "schema.sql の表が FTS5",
  ...over,
});
const trigram = {
  options: [
    { text: "trigram", chosen: true },
    { text: "FTS5 の既定の語切り", chosen: false, why: "日本語の部分一致が弱い" },
  ],
  confirmation: "schema.sql の tokenize が trigram",
};
const problems = (raw: unknown) => checkTrace(raw).problems.join("\n");

test("通る記録は、決定の案を option の行にし、key を session で一意にする", () => {
  const r = checkTrace(
    base([decision()], {
      work: { key: "rebuild", title: "作り直し", goal: "13 表", current: "実装中", status: "active" },
    }),
  );
  assert.deepEqual(r.problems, []);
  const out = rows(r.trace as Trace);
  assert.deepEqual(
    out.map((x) => [x.key, x.kind, x.status, x.parent]),
    [
      ["claude-code:s1#d-fts5", "decision", "accepted", null],
      ["claude-code:s1#d-fts5:o1", "option", "chosen", "claude-code:s1#d-fts5"],
      ["claude-code:s1#d-fts5:o2", "option", "rejected", "claude-code:s1#d-fts5"],
    ],
  );
  assert.equal(out[2]?.reason, "資格情報とネットワークが要る");
});

// 決定の価値は捨てた案にある。棄却理由の無い決定は、同じ案を再検討させる。
test("棄却した案と理由・確かめ方の無い決定を通さない", () => {
  assert.match(
    problems(base([decision({ options: [{ text: "FTS5", chosen: true }] })])),
    /棄却した案と、その理由/,
  );
  assert.match(
    problems(
      base([
        decision({
          options: [
            { text: "a", chosen: true },
            { text: "b", chosen: false },
          ],
        }),
      ]),
    ),
    /why を書く/,
  );
  assert.match(problems(base([decision({ confirmation: undefined })])), /confirmation/);
});

test("根拠の無い fact と、理由の無い未実行の検証を通さない", () => {
  assert.match(
    problems(base([{ key: "f-1", kind: "finding", at, text: "SQLite は 3.50", confidence: "fact" }])),
    /fact には refs か evidence/,
  );
  assert.deepEqual(
    checkTrace(
      base([
        {
          key: "f-1",
          kind: "finding",
          at,
          text: "SQLite は 3.50",
          confidence: "fact",
          refs: ["cmd:sqlite3 --version"],
        },
      ]),
    ).problems,
    [],
  );
  assert.match(
    problems(base([{ key: "v-1", kind: "verification", at, text: "E2E", status: "not_run" }])),
    /reason/,
  );
});

test("参照は、この記録の決定か別の session の key だけ", () => {
  assert.match(
    problems(
      base([{ key: "v-1", kind: "verification", at, text: "型", status: "passed", verifies: "d-none" }]),
    ),
    /d-none はこの記録の決定に無い/,
  );
  assert.deepEqual(
    checkTrace(
      base([
        { key: "v-1", kind: "verification", at, text: "型", status: "passed", verifies: "codex:t9#d-old" },
      ]),
    ).problems,
    [],
  );
});

// 後継の無い superseded は、何に置き換わったのかが分からず迷子になる。
test("superseded は、この記録の別の決定が覆していなければならない", () => {
  assert.match(problems(base([decision({ status: "superseded" })])), /supersedes でこの key を指す/);
  const ok = checkTrace(
    base([
      decision({ status: "superseded" }),
      decision({ key: "d-like", text: "LIKE に戻す", supersedes: "d-fts5" }),
    ]),
  );
  assert.deepEqual(ok.problems, []);
  const out = rows(ok.trace as Trace);
  const old = out.find((x) => x.key === "claude-code:s1#d-fts5");
  assert.equal(old?.supersededBy, "claude-code:s1#d-like");
  // 覆された決定で採った案を、採用のまま返さない。
  assert.equal(out.find((x) => x.key === "claude-code:s1#d-fts5:o1")?.status, "was_chosen");
});

// 同じ記録で覆したのに有効のまま書くと、check を通って save だけが DB の CHECK で落ちる。
test("この記録の中で覆された決定は superseded でなければならない", () => {
  assert.match(
    problems(base([decision(), decision({ key: "d-like", text: "LIKE に戻す", supersedes: "d-fts5" })])),
    /d-like が覆しているので、status は superseded にする/,
  );
});

// 根拠は後から辿れる形で持つ。種類の無い文字列は、何を指すのかが分からない。
test("refs は種類を前置した形だけを通し、本文に貼ったキーは伏せてから持つ", () => {
  const fact = (refs: string[]) =>
    base([{ key: "f1", kind: "finding", at, text: "索引は要らない", confidence: "fact", refs }]);
  assert.match(problems(fact(["schema.sql"])), /commit: \/ url: \/ cmd:/);
  assert.deepEqual(
    checkTrace(fact(["cmd:bun run verify", "url:https://x.test/a", "issue:#31"])).problems,
    [],
  );
  const r = checkTrace(
    base([
      {
        key: "f2",
        kind: "finding",
        at,
        text: "PGPASSWORD=npg_AbCdEf123456 で繋いだ",
        refs: ["cmd:PGPASSWORD=npg_AbCdEf123456 psql"],
      },
    ]),
  );
  assert.deepEqual(r.problems, []);
  const out = JSON.stringify(rows(r.trace as Trace));
  assert.ok(!out.includes("npg_AbCdEf"), out);
});

test("知らない欄と、形の違う日時・パスを弾く", () => {
  assert.match(problems(base([decision({ extra: 1 })])), /Unrecognized key|extra/);
  assert.match(problems(base([decision({ at: "2026-09-13" })])), /ISO 8601/);
  assert.match(
    problems(
      base([
        {
          key: "c-1",
          kind: "constraint",
          status: "active",
          at,
          text: "x",
          files: [{ path: "/abs/x.ts", role: "applies_to" }],
        },
      ]),
    ),
    /相対パス/,
  );
  assert.match(problems(base([decision(), decision()])), /重複/);
});

// ---- 本物の SQLite へ入れる ----

const valid = (raw: unknown): Trace => {
  const r = checkTrace(raw);
  assert.deepEqual(r.problems, []);
  return r.trace as Trace;
};

test("記録を入れると決定・案・作業・ファイルが入り、同じ内容の再保存は書き直さない", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const t = valid(
      base([{ ...decision(), files: [{ path: "db/schema.sql", role: "applies_to" }] }], {
        work: {
          key: "rebuild",
          title: "作り直し",
          goal: "13 表",
          current: "実装中",
          next: ["型"],
          status: "active",
        },
      }),
    );
    assert.deepEqual(await saveTrace(db.ingest, p, t), { written: 3, superseded: 0 });
    assert.deepEqual(
      await saveTrace(db.ingest, p, t),
      { written: 0, superseded: 0 },
      "同じ内容は書き直さない",
    );
    const rows = db.owner
      .prepare("select kind, status, heading, work_item_id is not null as w from knowledge order by id")
      .all()
      .map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { kind: "decision", status: "accepted", heading: "作り直し", w: 1 },
      { kind: "option", status: "chosen", heading: "作り直し", w: 1 },
      { kind: "option", status: "rejected", heading: "作り直し", w: 1 },
    ]);
    assert.deepEqual(
      { ...db.owner.prepare("select next, status from work_item").get() },
      { next: '["型"]', status: "active" },
    );
    assert.deepEqual(
      db.owner
        .prepare("select path, role from knowledge_file")
        .all()
        .map((r) => ({ ...r })),
      [{ path: "db/schema.sql", role: "applies_to" }],
    );
    // 案を減らして書き直すと、古い案を棄却として残さない
    const three = [
      { text: "FTS5", chosen: true },
      { text: "外部の検索サービス", chosen: false, why: "資格情報とネットワークが要る" },
      { text: "LIKE の全件走査", chosen: false, why: "件数に比例して遅い" },
    ];
    const options = () =>
      (
        db.owner
          .prepare(
            "select count(*) as n from knowledge where kind = 'option' and source_key like '%d-three%'",
          )
          .get() as { n: number }
      ).n;
    await saveTrace(db.ingest, p, valid(base([decision({ key: "d-three", options: three })])));
    assert.equal(options(), 3);
    await saveTrace(
      db.ingest,
      p,
      valid(base([decision({ key: "d-three", options: three.slice(0, 2), text: "書き直し" })])),
    );
    assert.equal(options(), 2);
  } finally {
    await db.done();
  }
});

// 覆した決定は消さない（消すと、なぜ変えたかが失われて再提案される）。後継を指して superseded にする。
test("別の session の決定を覆すと、古い決定は後継を指して superseded になり、その採った案は当時の案になる", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    await saveTrace(db.ingest, p, valid(base([decision()])));
    const newer = valid({
      schema: "trace/1",
      session: { host: "claude-code", id: "s2" },
      items: [
        decision({
          ...trigram,
          key: "d-trigram",
          text: "全文検索は trigram で持つ",
          supersedes: "claude-code:s1#d-fts5",
        }),
      ],
    });
    assert.equal((await saveTrace(db.ingest, p, newer)).superseded, 1);
    const old = db.owner
      .prepare(
        "select status, superseded_by_id is not null as later from knowledge where source_key = 'claude-code:s1#d-fts5'",
      )
      .get();
    assert.deepEqual({ ...old }, { status: "superseded", later: 1 });
    assert.equal(
      (
        db.owner
          .prepare("select status from knowledge where source_key = 'claude-code:s1#d-fts5:o1'")
          .get() as { status: string }
      ).status,
      "was_chosen",
    );
    // 古い session を再 trace しても、DB 側の覆しを「採用」に戻さない
    await saveTrace(db.ingest, p, valid(base([decision({ text: "FTS5 で持つ（再 trace）" })])));
    assert.equal(
      (
        db.owner.prepare("select status from knowledge where source_key = 'claude-code:s1#d-fts5'").get() as {
          status: string;
        }
      ).status,
      "superseded",
    );
    // 逆向きに覆し返すと輪になるので止める
    const loop = valid(base([decision({ key: "d-loop", supersedes: "claude-code:s2#d-trigram" })]));
    await saveTrace(db.ingest, p, loop);
    await assert.rejects(
      saveTrace(
        db.ingest,
        p,
        valid({
          schema: "trace/1",
          session: { host: "claude-code", id: "s2" },
          items: [
            decision({ ...trigram, key: "d-trigram", text: "trigram", supersedes: "claude-code:s1#d-loop" }),
          ],
        }),
      ),
      /互いに覆し合う/,
    );
  } finally {
    await db.done();
  }
});

// 壊れた参照を黙って落とさない。途中まで書いた状態も残さない（1 つの transaction）。
test("このプロジェクトに無い決定を指す記録は、何も書かずに止まる", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const t = valid(base([decision({ supersedes: "claude-code:other#d-none" })]));
    await assert.rejects(saveTrace(db.ingest, p, t), /このプロジェクトに無い決定/);
    assert.equal((db.owner.prepare("select count(*) as n from conversation").get() as { n: number }).n, 0);
  } finally {
    await db.done();
  }
});

// 配る Skill が「形はこれ」と指す見本。契約から外れると、AI は通らない形を真似て書く。
test("trace Skill の見本は記録の検査を通る", () => {
  const example = new URL("../../plugin/skills/trace/example.json", import.meta.url);
  assert.deepEqual(checkTrace(JSON.parse(fs.readFileSync(example, "utf8"))).problems, []);
});
