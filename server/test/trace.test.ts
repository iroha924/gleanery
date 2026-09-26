import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { searchKnowledge } from "../src/search.ts";
import {
  checkHarvest,
  checkTrace,
  type Harvest,
  type PullRequest,
  rows,
  saveHarvest,
  saveTrace,
  sessionKeys,
  type Trace,
} from "../src/trace.ts";
import { project, tempDb } from "./temp-db.ts";

/** A trace record's rows, keyed the way saveTrace keys them */
const traceRows = (t: Trace) => rows(t.items, sessionKeys(t));

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

test("a valid record turns decision options into option rows and makes keys unique per session", () => {
  const r = checkTrace(
    base([decision()], {
      work: { key: "rebuild", title: "作り直し", goal: "13 表", current: "実装中", status: "active" },
    }),
  );
  assert.deepEqual(r.problems, []);
  const out = traceRows(r.trace as Trace);
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

// A decision is worth its rejected options. A decision without rejection reasons invites the same options again.
// A decision made without alternatives is saved as is; asking for a rejected option would make one up.
test("accepts a decision without alternatives, and rejects missing reasons or a way to confirm", () => {
  assert.equal(problems(base([decision({ options: [{ text: "FTS5", chosen: true }] })])), "");
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
    /write why for every option not chosen/,
  );
  assert.match(problems(base([decision({ confirmation: undefined })])), /confirmation/);
});

test("rejects facts without evidence and unrun verifications without a reason", () => {
  assert.match(
    problems(base([{ key: "f-1", kind: "finding", at, text: "SQLite は 3.50", confidence: "fact" }])),
    /fact needs refs or evidence/,
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

test("references point only to decisions in this record or keys of other sessions", () => {
  assert.match(
    problems(
      base([{ key: "v-1", kind: "verification", at, text: "型", status: "passed", verifies: "d-none" }]),
    ),
    /d-none is not a decision in this record/,
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

// A superseded decision without a successor is lost, since nothing says what replaced it.
test("superseded requires another decision in this record to overturn it", () => {
  assert.match(
    problems(base([decision({ status: "superseded" })])),
    /point supersedes of the newer decision at this key/,
  );
  const ok = checkTrace(
    base([
      decision({ status: "superseded" }),
      decision({ key: "d-like", text: "LIKE に戻す", supersedes: "d-fts5" }),
    ]),
  );
  assert.deepEqual(ok.problems, []);
  const out = traceRows(ok.trace as Trace);
  const old = out.find((x) => x.key === "claude-code:s1#d-fts5");
  assert.equal(old?.supersededBy, "claude-code:s1#d-like");
  // The chosen option of an overturned decision is not returned as chosen.
  assert.equal(out.find((x) => x.key === "claude-code:s1#d-fts5:o1")?.status, "was_chosen");
});

// Writing a decision as active after overturning it in the same record passes check and fails only at save on the database CHECK.
test("a decision overturned within this record must be superseded", () => {
  assert.match(
    problems(base([decision(), decision({ key: "d-like", text: "LIKE に戻す", supersedes: "d-fts5" })])),
    /d-like supersedes it, so set status to superseded/,
  );
});

// Evidence is kept in a traceable form. A string without a kind does not say what it points to.
test("refs must have a kind prefix, and keys pasted in text are masked before storing", () => {
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
  const out = JSON.stringify(traceRows(r.trace as Trace));
  assert.ok(!out.includes("npg_AbCdEf"), out);
});

test("rejects unknown fields and malformed dates and paths", () => {
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
    /relative to the project root/,
  );
  assert.match(problems(base([decision(), decision()])), /duplicated/);
});

// ---- Store into a real SQLite database ----

const valid = (raw: unknown): Trace => {
  const r = checkTrace(raw);
  assert.deepEqual(r.problems, []);
  return r.trace as Trace;
};

test("saving a record stores decisions, options, work, and files, and saving the same content again writes nothing", async () => {
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
    assert.deepEqual(await saveTrace(db.ingest, p, t), { written: 1, superseded: 0, terms: 0 });
    assert.deepEqual(
      await saveTrace(db.ingest, p, t),
      { written: 0, superseded: 0, terms: 0 },
      "same content is not rewritten",
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
    // Rewriting with fewer options does not keep the old ones as rejected
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

// Overturned decisions are not deleted (deleting loses why it changed, and it gets proposed again). They point to the successor as superseded.
test("overturning another session's decision makes it superseded with a successor, and its chosen option becomes was_chosen", async () => {
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
    // Re-tracing the old session does not flip the overturn in the database back to accepted
    await saveTrace(db.ingest, p, valid(base([decision({ text: "FTS5 で持つ（再 trace）" })])));
    assert.equal(
      (
        db.owner.prepare("select status from knowledge where source_key = 'claude-code:s1#d-fts5'").get() as {
          status: string;
        }
      ).status,
      "superseded",
    );
    // Overturning back in the other direction would make a cycle, so it stops
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
      /supersede each other/,
    );
  } finally {
    await db.done();
  }
});

// Broken references are not silently dropped, and no partial write remains (one transaction).
test("a record pointing to a decision outside this project stops without writing", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const t = valid(base([decision({ supersedes: "claude-code:other#d-none" })]));
    await assert.rejects(saveTrace(db.ingest, p, t), /decisions not in this project/);
    assert.equal((db.owner.prepare("select count(*) as n from conversation").get() as { n: number }).n, 0);
  } finally {
    await db.done();
  }
});

// The sample the shipped Skill points to as the format. If it breaks the contract, the AI copies a shape that fails.
test("the trace Skill sample passes the record check", () => {
  const example = new URL("../../plugin/skills/trace/example.json", import.meta.url);
  assert.deepEqual(checkTrace(JSON.parse(fs.readFileSync(example, "utf8"))).problems, []);
});

// ---- harvest: one pull request's decisions ----

const PR: PullRequest = {
  number: 12,
  githubId: 9001,
  title: "Keep SQLite",
  url: "https://github.com/o/r/pull/12",
  state: "merged",
};
const harvest = (items: unknown[], pr = 12): Harvest => {
  const r = checkHarvest({ schema: "harvest/1", pr, version: "0123456789ab", items });
  assert.deepEqual(r.problems, []);
  return r.harvest as Harvest;
};
const found = (db: ReturnType<typeof tempDb>, sql: string, ...args: (string | number)[]) =>
  db.owner
    .prepare(sql)
    .all(...args)
    .map((r) => ({ ...r }));

test("harvest stores one pull request's items under it, keeps earlier items a rerun leaves out, and never touches trace rows", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    await saveTrace(db.ingest, p, valid(base([decision()])));
    const traceRow = found(
      db,
      "select id, content_hash, status from knowledge where source_key = 'claude-code:s1#d-fts5'",
    );
    const first = await saveHarvest(
      db.ingest,
      p,
      PR,
      harvest([
        decision({ key: "sqlite", confirmation: undefined, refs: ["issue:#4821"] }),
        { key: "windows", kind: "finding", at, text: "Paths break on Windows", terms: ["Windows path"] },
      ]),
    );
    // Counted per item: the decision and its two options are one
    assert.deepEqual([first.written, first.terms, first.kept], [2, 1, []]);
    const rowsOf = () =>
      found(
        db,
        "select source_key, conversation_id, pull_request_id, heading from knowledge where pull_request_id is not null order by source_key",
      );
    const pr = found(
      db,
      "select id, number, github_id, harvested_at is not null as saved from pull_request",
    )[0];
    assert.deepEqual(pr, { id: pr?.id, number: 12, github_id: 9001, saved: 1 });
    assert.deepEqual(
      rowsOf().map((r) => r.source_key),
      ["pr:12#sqlite", "pr:12#sqlite:o1", "pr:12#sqlite:o2", "pr:12#windows"],
    );
    assert.ok(rowsOf().every((r) => r.conversation_id === null && r.heading === "PR #12: Keep SQLite"));
    assert.deepEqual(found(db, "select source from knowledge_terms"), [{ source: "harvest" }]);
    // Only the refs carry the issue number, so the search finds the decision through them
    const hits = await searchKnowledge(db.reader, { question: "4821", projects: [p], limit: 5 });
    assert.deepEqual(
      hits.map((h) => [h.kind, h.context]),
      [["decision", "PR #12: Keep SQLite"]],
    );
    // A rerun without one item keeps it and says so
    const again = await saveHarvest(
      db.ingest,
      p,
      PR,
      harvest([decision({ key: "sqlite", confirmation: undefined })]),
    );
    assert.deepEqual(again.kept, ["pr:12#windows"]);
    assert.equal(rowsOf().length, 4);
    assert.deepEqual(
      found(db, "select id, content_hash, status from knowledge where source_key = 'claude-code:s1#d-fts5'"),
      traceRow,
    );
  } finally {
    await db.done();
  }
});

// After `project move` points the project at another repository, #12 can be a different pull request. Refuse rather than mix them.
test("harvest refuses a number that now names a different pull request, and a record for another number", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    await saveHarvest(db.ingest, p, PR, harvest([{ key: "f", kind: "finding", at, text: "a" }]));
    await assert.rejects(
      saveHarvest(
        db.ingest,
        p,
        { ...PR, githubId: 7 },
        harvest([{ key: "g", kind: "finding", at, text: "b" }]),
      ),
      /different pull request/,
    );
    await assert.rejects(saveHarvest(db.ingest, p, PR, harvest([], 13)), /record is for #13/);
    assert.deepEqual(found(db, "select source_key from knowledge"), [{ source_key: "pr:12#f" }]);
  } finally {
    await db.done();
  }
});

test("a harvest record keeps its references inside itself and needs no confirmation", () => {
  const r = checkHarvest({
    schema: "harvest/1",
    pr: 12,
    version: "0123456789ab",
    items: [
      decision({ key: "a", confirmation: undefined, supersedes: "claude-code:s1#d-fts5" }),
      { key: "v", kind: "verification", status: "passed", at, text: "ran", verifies: "pr:11#x" },
    ],
  });
  assert.match(r.problems.join("\n"), /items\.0\.supersedes: .*outside this record/);
  assert.match(r.problems.join("\n"), /items\.1\.verifies: .*outside this record/);
  assert.doesNotMatch(r.problems.join("\n"), /confirmation/);
  assert.match(
    checkHarvest({ schema: "harvest/1", pr: 0, version: "0123456789ab", items: [] }).problems.join("\n"),
    /pr/,
  );
  // Without the version harvest read printed, save could not tell whether the pull request changed since
  assert.match(checkHarvest({ schema: "harvest/1", pr: 1, items: [] }).problems.join("\n"), /version/);
});

// A key rewritten as another kind keeps no options of the decision it was, and a renamed pull request renames every record under it
test("harvest drops the options of a decision rewritten as another kind, and retitles items a rerun leaves out", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    await saveHarvest(
      db.ingest,
      p,
      PR,
      harvest([
        decision({ key: "sqlite", confirmation: undefined }),
        { key: "kept", kind: "finding", at, text: "k" },
      ]),
    );
    await saveHarvest(
      db.ingest,
      p,
      { ...PR, title: "Keep one SQLite file" },
      harvest([{ key: "sqlite", kind: "finding", at, text: "now a finding" }]),
    );
    assert.deepEqual(found(db, "select source_key, kind from knowledge order by source_key"), [
      { source_key: "pr:12#kept", kind: "finding" },
      { source_key: "pr:12#sqlite", kind: "finding" },
    ]);
    assert.deepEqual(found(db, "select distinct heading from knowledge"), [
      { heading: "PR #12: Keep one SQLite file" },
    ]);
  } finally {
    await db.done();
  }
});
