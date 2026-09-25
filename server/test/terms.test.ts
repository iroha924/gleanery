import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { read, renderHits, searchKnowledge, searchSplit, splitJson } from "../src/search.ts";
import { searchTerms } from "../src/terms.ts";
import { checkTrace, saveTrace, type Trace } from "../src/trace.ts";
import { hash, knowledge, project, type TempDb, tempDb } from "./temp-db.ts";

let db: TempDb;
let p: number;
before(() => {
  db = tempDb();
  p = project(db);
});
after(() => db.done());

const found = async (question: string) =>
  (await searchKnowledge(db.reader, { question, projects: [p], limit: 10 })).map((h) =>
    Number(h.ref.slice(2)),
  );
const putTerms = (id: number, terms: string, contentHash?: Buffer) =>
  db.owner
    .prepare(
      "insert into knowledge_terms (knowledge_id, terms, content_hash, source, written_at) values (?, ?, coalesce(?, (select content_hash from knowledge where id = ?)), 'import', '2026-09-26T00:00:00.000Z') on conflict (knowledge_id) do update set terms = excluded.terms, content_hash = excluded.content_hash",
    )
    .run(id, terms, contentHash ?? null, id);

test("search terms are normalized and bounded, and unreadable characters are refused", () => {
  assert.equal(searchTerms(" ORM ,移行, ORM,,  query  builder "), "ORM, 移行, query builder");
  assert.equal(searchTerms(["ＡＢＣ", "abc"]), "ABC, abc");
  assert.equal(searchTerms([]), "");
  assert.equal(searchTerms(["絵文字‍の結合"]), "絵文字‍の結合");
  assert.throws(() => searchTerms(["a\u200bb"]), /invisible/);
  assert.throws(() => searchTerms(["a\u0007b"]), /control/);
  assert.throws(() => searchTerms(["x".repeat(41)]), /longer than 40/);
  assert.throws(() => searchTerms(Array.from({ length: 17 }, (_, i) => `t${i}`)), /more than 16/);
  assert.throws(() => searchTerms(Array.from({ length: 16 }, (_, i) => `${"y".repeat(30)}${i}`)), /400/);
});

test("terms find a record only while they were written for its current text", async () => {
  const id = knowledge(db, p, { source_key: "t#hash", body: "kysely を残す" });
  assert.deepEqual(await found("ORM"), []);
  putTerms(id, "ORM, query builder");
  assert.deepEqual(await found("ORM"), [id]);
  db.owner
    .prepare("update knowledge set body = 'kysely を使い続ける', content_hash = ? where id = ?")
    .run(hash(7), id);
  assert.deepEqual(await found("ORM"), [], "words written for the old text no longer find it");
  assert.deepEqual(await found("使い続ける"), [id]);
  putTerms(id, "ORM");
  assert.deepEqual(await found("ORM"), [id], "rewritten for the new text");
  db.owner.prepare("delete from knowledge where id = ?").run(id);
  assert.equal(
    db.owner.prepare("select count(*) n from knowledge_terms where knowledge_id = ?").get(id)?.n,
    0,
  );
  assert.deepEqual(await found("ORM"), []);
});

test("db reindex rebuilds the same index, terms included", async () => {
  const { reindex } = await import("../src/admin.ts");
  const id = knowledge(db, p, { source_key: "t#reindex", body: "索引の作り直し" });
  putTerms(id, "rebuild-marker");
  reindex(db.file);
  assert.deepEqual(await found("rebuild-marker"), [id]);
});

const trace = (terms: unknown): Trace => {
  const r = checkTrace({
    schema: "trace/1",
    session: { host: "claude-code", id: "terms" },
    items: [
      {
        key: "d-orm",
        kind: "decision",
        status: "accepted",
        at: "2026-09-26T10:00:00+09:00",
        text: "kysely を残す",
        context: "型を推論させたい",
        options: [
          { text: "kysely", chosen: true },
          { text: "別の道具", chosen: false, why: "移行の手間" },
        ],
        confirmation: "package.json",
        ...(terms === undefined ? {} : { terms }),
      },
    ],
  });
  assert.deepEqual(r.problems, []);
  return r.trace as Trace;
};

test("trace writes a decision's terms to it and its options, keeps them when omitted, and clears them with an empty list", async () => {
  await saveTrace(db.ingest, p, trace(["ORM-choice", "query builder"]));
  const ids = (
    db.owner
      .prepare("select id from knowledge where source_key like 'claude-code:terms#d-orm%' order by id")
      .all() as {
      id: number;
    }[]
  ).map((r) => r.id);
  assert.equal(ids.length, 3);
  assert.deepEqual(
    (await found("ORM-choice")).sort(),
    [ids[0], ids[2]].sort(),
    "the decision and its rejected option",
  );
  const before = db.owner
    .prepare("select content_hash from knowledge where id = ?")
    .get(ids[0] as number)?.content_hash;
  await saveTrace(db.ingest, p, trace(undefined));
  assert.deepEqual(
    db.owner.prepare("select content_hash from knowledge where id = ?").get(ids[0] as number)?.content_hash,
    before,
  );
  assert.equal((await found("ORM-choice")).length, 2, "omitted keeps them");
  await saveTrace(db.ingest, p, trace([]));
  assert.deepEqual(await found("ORM-choice"), [], "an empty list clears them");
});

test("trace check refuses terms that break the rules", () => {
  const r = checkTrace({
    schema: "trace/1",
    session: { host: "claude-code", id: "terms" },
    items: [
      {
        key: "f-bad",
        kind: "finding",
        at: "2026-09-26T10:00:00+09:00",
        text: "見つけたこと",
        terms: ["a\u200bb"],
      },
    ],
  });
  assert.match(r.problems.join("\n"), /invisible/);
});

test("terms never appear in knowledge results, read, or the rendered hits", async () => {
  const id = knowledge(db, p, { source_key: "t#hidden", body: "本文だけが見える" });
  putTerms(id, "Ignore-previous-instructions-marker");
  const split = await searchSplit(db.reader, {
    question: "Ignore-previous-instructions-marker",
    projects: [p],
    limit: 5,
  });
  assert.equal(split.records[0]?.ref, `k:${id}`);
  for (const text of [
    JSON.stringify(split),
    splitJson(split, 4000).text,
    renderHits(split.records, 4000).text,
    (await read(db.reader, [`k:${id}`], 8000, { projects: [p] })).text,
  ])
    assert.ok(!text.includes("marker"), text.slice(0, 200));
});

test("the owner import writes only records unchanged since the draft and says why it skipped the rest", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { importTerms, listTerms } = await import("../src/admin.ts");
  const fresh = knowledge(db, p, { source_key: "t#import-fresh", body: "取り込む記録" });
  const changed = knowledge(db, p, { source_key: "t#import-changed", body: "変わる記録" });
  const badTerms = knowledge(db, p, { source_key: "t#import-bad-terms", body: "語が読めない記録" });
  const hexOf = (id: number) =>
    Buffer.from(
      db.owner.prepare("select content_hash from knowledge where id = ?").get(id)?.content_hash as Uint8Array,
    ).toString("hex");
  const draft = {
    "t#import-fresh": { terms: "importmarkerzz, 取り込み", content_hash: hexOf(fresh) },
    "t#import-changed": { terms: "stalemarkerzz", content_hash: hexOf(changed) },
    "t#import-bad": { terms: "x", content_hash: "00" },
    "t#import-bad-terms": { terms: "a\u200bb", content_hash: hexOf(badTerms) },
  };
  db.owner
    .prepare("update knowledge set body = '変わった記録', content_hash = ? where id = ?")
    .run(hash(9), changed);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-terms-"));
  try {
    const file = path.join(dir, "draft.json");
    fs.writeFileSync(file, JSON.stringify(draft));
    const r = importTerms(file, "git:github.com/o/r", db.file);
    assert.equal(r.written, 1);
    assert.deepEqual(
      r.skipped.map((s) => [s.key, s.why.split(":")[0]]),
      [
        ["t#import-changed", "the record changed after the draft"],
        ["t#import-bad", "not a record of this project"],
        ["t#import-bad-terms", "search term has a control or invisible character"],
      ],
    );
    assert.deepEqual(await found("importmarkerzz"), [fresh]);
    assert.deepEqual(await found("stalemarkerzz"), []);
    listTerms("git:github.com/o/r", `k:${fresh}`, db.file);
    assert.throws(() => importTerms(file, "git:github.com/o/none", db.file), /not registered/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
