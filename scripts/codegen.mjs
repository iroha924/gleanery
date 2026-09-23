#!/usr/bin/env node
// db/schema.sql から kysely の型を作り、server/src/db-types.ts へ書く。
//
// 生成元はメモリ上の SQLite に db/schema.sql だけを当てたもので、手元の DB ではない。
// kysely-codegen の CLI は better-sqlite3 を要求するので、programmatic API に node:sqlite のアダプタを渡す。
// --check は生成した文字列と db-types.ts を比べる。schema.sql を変えたのに型を作り直し忘れた commit を止める。

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// kysely と kysely-codegen は server の依存にある。ここから解決して、検査のために root へ依存を足さない。
const require = createRequire(path.join(root, "server/package.json"));
// biome-ignore lint/correctness/noUndeclaredDependencies: server/package.json の依存を解決する
const { Kysely, SqliteDialect } = require("kysely");
// biome-ignore lint/correctness/noUndeclaredDependencies: server/package.json の devDependencies を解決する
const { generate, RawExpressionNode, SqliteDialect: GenSqlite } = require("kysely-codegen");
const { adapt } = await import(path.join(root, "server/src/kysely-node-sqlite.ts"));

const OUT = path.join(root, "server/src/db-types.ts");
const check = process.argv.includes("--check");

// JSON の文字列で持つ列。読むときは db.ts の JSON_COLUMNS が値へ戻し、書くときは JSON.stringify して渡す。
// 文字列のまま渡すと kysely-codegen が TypeScript の parser で読もうとして落ちる（typescript 7 に旧 API が無い）。
const type = (t) => new RawExpressionNode(t);
const array = () => type("ColumnType<string[], string | undefined, string>");
const overrides = {
  columns: {
    "knowledge.refs": array(),
    "knowledge.downsides": array(),
    "work_item.next": array(),
    "source_item.metadata": type("ColumnType<Record<string, unknown>, string | undefined, string>"),
  },
};

const raw = new DatabaseSync(":memory:");
// trigger が参照するので登録だけ要る（型の生成では呼ばれない）。
raw.function("gleanery_terms", () => "");
raw.exec(fs.readFileSync(path.join(root, "db/schema.sql"), "utf8"));
const db = new Kysely({ dialect: new SqliteDialect({ database: adapt(raw) }) });
const text = await generate({
  db,
  dialect: new GenSqlite(),
  outFile: null,
  // FTS5 の仮想表と shadow table は kysely から触らない（検索は sql テンプレートで書く）。
  excludePattern: "*_fts*",
  overrides,
  logger: { info() {}, warn() {}, error: console.error, debug() {}, success() {}, log() {} },
});
await db.destroy();

const rel = path.relative(root, OUT);
if (check) {
  const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (now !== text) {
    console.error(`${rel} が db/schema.sql と合っていない。\`bun run codegen\` で作り直す`);
    process.exit(1);
  }
  console.log(`${rel} は db/schema.sql と一致している`);
} else {
  fs.writeFileSync(OUT, text);
  console.log(`${rel} を db/schema.sql から作り直した`);
}
