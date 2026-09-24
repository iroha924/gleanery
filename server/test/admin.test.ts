import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyMigrations, dbInit, inspect, migrate, reindex } from "../src/admin.ts";
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

test("gleanery init は DB を WAL で作ってバージョンを付け、2 度目は触らない", async () => {
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

// 2 つの gleanery init が同時に「まだ無い」を見ても、後から置く側が先に置かれて記録の入った DB を空の DB で置き換えない。
test("gleanery init は置く直前に先に置かれた DB を置き換えない", async (t) => {
  const file = path.join(tmp(), "gleanery.db");
  await quiet(() => dbInit(file));
  const w = connectWriter("owner", file);
  w.prepare("insert into project (key, name) values ('git:x/y', 'x/y')").run();
  w.close();
  // 存在の確かめをすり抜けた側を再現する。
  t.mock.method(fs, "existsSync", (f: fs.PathLike) =>
    String(f) === file ? false : fs.statSync(f, { throwIfNoEntry: false }) !== undefined,
  );
  await assert.rejects(async () => quiet(() => dbInit(file)), /already exists/);
  t.mock.restoreAll();
  const raw = new DatabaseSync(file, { readOnly: true });
  assert.equal((raw.prepare("select count(*) as n from project").get() as { n: number }).n, 1);
  raw.close();
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp")),
    [],
  );
});

test("hard link を持たない FS では rename で置く", async (t) => {
  const file = path.join(tmp(), "gleanery.db");
  t.mock.method(fs, "linkSync", () => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  });
  await quiet(() => dbInit(file));
  const raw = new DatabaseSync(file, { readOnly: true });
  assert.equal(
    (raw.prepare("pragma user_version").get() as { user_version: number }).user_version,
    SCHEMA_REVISION,
  );
  raw.close();
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp")),
    [],
  );
});

// 別のアプリの DB を同じ名前で置いていたとき、上から schema を当てて壊さない。
test("gleanery init は gleanery の DB でないファイルを上書きしない", async () => {
  const file = path.join(tmp(), "gleanery.db");
  const raw = new DatabaseSync(file);
  raw.exec("create table mine (a)");
  raw.close();
  await assert.rejects(
    quiet(() => dbInit(file)),
    /is not a gleanery database/,
  );
});

test("db reindex は全文検索の索引を作り直し、doctor の確かめが通る", async () => {
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
test("gleanery init は HOME の .gleanery に DB を作る", () => {
  const home = tmp();
  execFileSync(process.execPath, [CLI, "init"], {
    env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home },
    stdio: "ignore",
    timeout: 30_000,
  });
  assert.equal(inspect(path.join(home, ".gleanery", "gleanery.db")).revision, SCHEMA_REVISION);
});

// 旧名の別名は残さない。旧 `gleanery db init` と、要件定義の置き場所を作っていた旧 `gleanery init --cwd`・`gleanery check` は通らない。
test("旧い command の形は拒まれ、DB を作らない", () => {
  for (const args of [["db", "init"], ["init", "--cwd", "."], ["check"]]) {
    const home = tmp();
    const r = spawnSync(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.notEqual(r.status, 0, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.equal(fs.existsSync(path.join(home, ".gleanery", "gleanery.db")), false, args.join(" "));
  }
});

// 当てる途中で落ちたら、前半だけ確定してバージョンが上がらないまま残らない（打ち直すと二重に当たる）。
test("db migrate は新しい migration を 1 つの transaction で当ててバージョンを上げ、落ちたら何も残さない", async () => {
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

/** 番号が current + 1 から続く migration を dir に置く。 */
function writeMigrations(dir: string, bodies: string[]): string[] {
  fs.mkdirSync(dir, { recursive: true });
  return bodies.map((body, i) => {
    const name = `${String(SCHEMA_REVISION + 1 + i).padStart(4, "0")}_m${i}.sql`;
    fs.writeFileSync(path.join(dir, name), body);
    return name;
  });
}

// 親の表を作り直す migration は、外部キーが効いたままだと DROP の暗黙の削除で子の行を cascade で消す。
test("foreign_keys=off を宣言した migration は外部キーを切って単独で当て、終わったら戻す", async () => {
  const dir = tmp();
  const file = path.join(dir, "gleanery.db");
  await quiet(() => dbInit(file));
  const raw = connectWriter("owner", file);
  const migrations = path.join(dir, "migrations");
  const files = writeMigrations(migrations, [
    `create table parent (id integer primary key autoincrement not null, v text not null) strict;
create table child (id integer primary key not null, parent_id integer not null references parent (id) on delete cascade) strict;
insert into parent (v) values ('a');
insert into child (id, parent_id) values (1, 1);`,
    // 1 行目の先頭の空白は宣言として読む（読み損ねると外部キーが効いたまま作り直す）
    `  -- gleanery: foreign_keys=off
create table "parent_new" (id integer primary key autoincrement not null, v text not null check (v <> '')) strict;
insert into "parent_new" (id, v) select id, v from parent;
drop table parent;
alter table "parent_new" rename to parent;`,
  ]);
  const applied = applyMigrations(raw, files, migrations);
  assert.deepEqual(
    applied.map((m) => m.revision),
    [SCHEMA_REVISION + 1, SCHEMA_REVISION + 2],
  );
  assert.equal((raw.prepare("pragma foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
  assert.equal(
    (raw.prepare("pragma user_version").get() as { user_version: number }).user_version,
    SCHEMA_REVISION + 2,
  );
  assert.equal((raw.prepare("select count(*) as n from child").get() as { n: number }).n, 1, "子の行が残る");
  raw.close();
});

test("外部キーを切る migration が落ちたら、同じ接続で戻して外部キーを効かせ直し、前の migration のバージョンで止まる", async () => {
  const dir = tmp();
  const file = path.join(dir, "gleanery.db");
  await quiet(() => dbInit(file));
  const raw = connectWriter("owner", file);
  const migrations = path.join(dir, "migrations");
  const files = writeMigrations(migrations, [
    "create table note (a text) strict;",
    "-- gleanery: foreign_keys=off\ncreate table half (a text) strict;\ncreate table broken (;",
  ]);
  assert.throws(() => applyMigrations(raw, files, migrations), /syntax error/);
  assert.equal((raw.prepare("pragma foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
  assert.equal(
    (raw.prepare("pragma user_version").get() as { user_version: number }).user_version,
    SCHEMA_REVISION + 1,
  );
  const has = (t: string) => raw.prepare("select 1 from sqlite_schema where name = ?").get(t) !== undefined;
  assert.ok(has("note"), "前の migration は確定している");
  assert.ok(!has("half"), "落ちた migration の前半は戻っている");
  fs.writeFileSync(
    path.join(migrations, files[1] as string),
    "-- gleanery: foreign_keys=off\ncreate table half (a text) strict;",
  );
  applyMigrations(raw, files, migrations);
  assert.equal(
    (raw.prepare("pragma user_version").get() as { user_version: number }).user_version,
    SCHEMA_REVISION + 2,
  );
  raw.close();
});

// 宣言を読み損ねて外部キーが効いたまま当てると、残すべき子の行を消す。読めない宣言は当てる前に止める。
test("知らない宣言や 1 行目以外の宣言があれば、何も当てずに止まる", async () => {
  for (const body of [
    "-- gleanery: foreign_keys=of\ncreate table x (a text) strict;",
    "create table x (a text) strict;\n-- gleanery: foreign_keys=off",
    // 先頭に空白があっても宣言として読む（宣言なしと読むと、外部キーが効いたまま表を作り直す）
    "create table x (a text) strict;\n  -- gleanery: foreign_keys=off",
  ]) {
    const dir = tmp();
    const file = path.join(dir, "gleanery.db");
    await quiet(() => dbInit(file));
    const raw = connectWriter("owner", file);
    const files = writeMigrations(path.join(dir, "migrations"), [body]);
    assert.throws(() => applyMigrations(raw, files, path.join(dir, "migrations")), /declaration/, body);
    assert.equal(
      (raw.prepare("pragma user_version").get() as { user_version: number }).user_version,
      SCHEMA_REVISION,
    );
    raw.close();
  }
});

// 宣言が無いまま表を消すと、外部キーが効いたまま子の行を cascade で消す。書き方（コメント・改行）によらず、
// SQLite が実際に消そうとした時点で止め、何も残さない。コメントの中の drop table は止めない。
test("宣言の無い migration は、書き方によらず表を消すことも作り変えることもできず、コメントの中の drop は通る", async () => {
  for (const drop of [
    "drop table parent;",
    "DROP /* rebuild */ TABLE parent;",
    "DROP -- rebuild\nTABLE parent;",
    // 親を rename すると、子の外部キーが退避先を指すよう書き換わり、退避先を消すと子も消える
    "alter table parent rename to parent_old;\ncreate table parent (id integer primary key not null) strict;\ninsert into parent select * from parent_old;\ndelete from parent_old;",
  ]) {
    const dir = tmp();
    const file = path.join(dir, "gleanery.db");
    await quiet(() => dbInit(file));
    const raw = connectWriter("owner", file);
    raw.exec(`create table parent (id integer primary key not null) strict;
create table child (id integer primary key not null, parent_id integer not null references parent (id) on delete cascade) strict;
insert into parent (id) values (1);
insert into child (id, parent_id) values (1, 1);`);
    const migrations = path.join(dir, "migrations");
    const files = writeMigrations(migrations, [drop]);
    assert.throws(() => applyMigrations(raw, files, migrations), /not authorized/, drop);
    assert.equal((raw.prepare("select count(*) as n from child").get() as { n: number }).n, 1, drop);
    raw.close();
  }
  const dir = tmp();
  const file = path.join(dir, "gleanery.db");
  await quiet(() => dbInit(file));
  const raw = connectWriter("owner", file);
  const migrations = path.join(dir, "migrations");
  const files = writeMigrations(migrations, [
    "/* DROP TABLE parent */\ncreate table note (id integer) strict; -- DROP TABLE parent",
  ]);
  applyMigrations(raw, files, migrations);
  assert.equal(
    (raw.prepare("pragma user_version").get() as { user_version: number }).user_version,
    SCHEMA_REVISION + 1,
  );
  raw.close();
});
