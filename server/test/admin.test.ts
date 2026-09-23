import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dbInit, inspect, migrate, reindex } from "../src/admin.ts";
import { SCHEMA_REVISION } from "../src/db.ts";
import { connectWriter } from "../src/db-write.ts";
import { at, hash } from "./temp-db.ts";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-admin-"));

/** admin の出力（console.log）を黙らせて fn を流す。 */
async function quiet<T>(fn: () => T | Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

test("db init は DB を WAL で作って版を付け、2 度目は触らない", async () => {
  const file = path.join(tmp(), "nested", "gleanery.db");
  await quiet(() => dbInit(file));
  const raw = new DatabaseSync(file, { readOnly: true });
  assert.equal((raw.prepare("pragma journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  assert.equal(
    (raw.prepare("pragma user_version").get() as { user_version: number }).user_version,
    SCHEMA_REVISION,
  );
  raw.close();
  const w = connectWriter("owner", file);
  w.prepare("insert into project (key, name) values ('git:x/y', 'x/y')").run();
  w.close();
  await quiet(() => dbInit(file));
  const again = new DatabaseSync(file, { readOnly: true });
  assert.equal(
    (again.prepare("select count(*) as n from project").get() as { n: number }).n,
    1,
    "作り直していない",
  );
  again.close();
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp")),
    [],
    "一時ファイルを残さない",
  );
});

// 別のアプリの DB を同じ名前で置いていたとき、上から schema を当てて壊さない。
test("db init は gleanery の DB でないファイルを上書きしない", async () => {
  const file = path.join(tmp(), "gleanery.db");
  const raw = new DatabaseSync(file);
  raw.exec("create table mine (a)");
  raw.close();
  await assert.rejects(
    quiet(() => dbInit(file)),
    /gleanery の DB ではない/,
  );
});

test("db reindex は語彙索引を作り直し、doctor の確かめが通る", async () => {
  const file = path.join(tmp(), "gleanery.db");
  await quiet(() => dbInit(file));
  const w = connectWriter("owner", file);
  w.exec("insert into project (key, name) values ('git:x/y', 'x/y')");
  w.prepare(
    "insert into conversation (id, project_id, origin, external_id, started_at) values ('c', 1, 'codex', 's', ?)",
  ).run(at("2026-09-01T00:00:00Z"));
  w.prepare(
    "insert into knowledge (project_id, conversation_id, source_key, kind, body, occurred_at, content_hash) values (1, 'c', 'k', 'finding', '索引を作り直す', ?, ?)",
  ).run(at("2026-09-01T00:00:00Z"), hash());
  w.exec("insert into knowledge_fts (knowledge_fts) values ('delete-all')");
  const count = () =>
    (
      w.prepare("select count(*) as n from knowledge_fts where knowledge_fts match '\"索引\"'").get() as {
        n: number;
      }
    ).n;
  assert.equal(count(), 0);
  await quiet(() => reindex(file));
  assert.equal(count(), 1);
  w.close();
  const x = inspect(file);
  assert.equal(x.revision, SCHEMA_REVISION);
  assert.deepEqual(x.fts, { knowledge: null, message: null });
  assert.ok(x.bytes > 0);
});

test("当てる migration が無ければ db migrate は何もしない", async () => {
  const file = path.join(tmp(), "gleanery.db");
  await quiet(() => dbInit(file));
  await quiet(() => migrate(true, file));
  assert.equal(inspect(file).revision, SCHEMA_REVISION);
});

// 配った CLI から打つ経路。HOME を一時ディレクトリへ向け、持ち主の ~/.gleanery を触らない。
test("gleanery db init は HOME の .gleanery に DB を作る", () => {
  const home = tmp();
  execFileSync(process.execPath, [CLI, "db", "init"], {
    env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home },
    stdio: "ignore",
    timeout: 30_000,
  });
  assert.equal(inspect(path.join(home, ".gleanery", "gleanery.db")).revision, SCHEMA_REVISION);
});

// 当てる途中で落ちたら、前半だけ確定して版が上がらないまま残らない（打ち直すと二重に当たる）。
test("db migrate は新しい migration を 1 つの transaction で当てて版を上げ、落ちたら何も残さない", async () => {
  const dir = tmp();
  const file = path.join(dir, "gleanery.db");
  await quiet(() => dbInit(file));
  const migrations = path.join(dir, "migrations");
  fs.mkdirSync(migrations);
  const next = SCHEMA_REVISION + 1;
  const name = `${String(next).padStart(4, "0")}_add_note.sql`;
  fs.writeFileSync(
    path.join(migrations, name),
    "create table note (a text) strict;\ncreate table broken (;\n",
  );
  await assert.rejects(
    quiet(() => migrate(true, file, migrations)),
    /syntax error/,
  );
  assert.equal(inspect(file).revision, SCHEMA_REVISION);
  const tables = () =>
    new DatabaseSync(file, { readOnly: true })
      .prepare("select name from sqlite_schema where name = 'note'")
      .all().length;
  assert.equal(tables(), 0, "前半の DDL も戻っている");
  fs.writeFileSync(path.join(migrations, name), "create table note (a text) strict;\n");
  await quiet(() => migrate(true, file, migrations));
  assert.equal(inspect(file).revision, next);
  assert.equal(tables(), 1);
});
