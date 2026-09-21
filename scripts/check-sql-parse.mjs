#!/usr/bin/env node
// 組み立てた SQL を、実際の PostgreSQL に受け付けさせる。
//
// **型検査と単体テストは、必ず実行時に落ちる SQL を素通りさせる。**test の double は SQL を実行せず
// 記録するだけなので、構文エラーの SQL が 184/184 pass のまま入った（#85 で 2 種類・6 箇所）。
//
// oracle は `EXPLAIN (GENERIC_PLAN)` で、`PREPARE` ではない。PREPARE は parse・analyze・rewrite までで
// planning をしないので、一意 index の消えた `on conflict` を通す（実測: 18.6 で PREPARE は PASS、
// EXPLAIN は「no unique or exclusion constraint matching the ON CONFLICT specification」で落ちた）。
// ANALYZE を付けない EXPLAIN は文を実行しないので、固定データも書き込みも要らない。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ALLOWED_UNCOVERED, callSites } from "./lib/sql-call-sites.mjs";
import { root, withTempPostgres } from "./lib/temp-postgres.mjs";

// pg は server の依存にある。ここから解決して、検査のために root へ依存を足さない。
const pg = createRequire(path.join(root, "server/package.json"))("pg");

const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-sql-corpus-"));

/** テストを走らせて SQL を集める。集める側と検査する側を同じ command にする。別々にすると、順序が
 * 変わっただけで「集めていないものを検査して緑」になる（verify が build より先に test を走らせていた件）。 */
function collect() {
  const r = spawnSync("bun", ["run", "--cwd", "server", "test"], {
    cwd: root,
    env: { ...process.env, GLEANERY_SQL_CORPUS: corpusDir },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    // node --test は失敗の中身を stdout へ書く。stderr だけ出すと CI のログが見出し 1 行で終わる
    // （実測: 落ちるテストで stdout 783 バイト / stderr 0 バイト）。この実行は corpus を集める分だけ
    // verify と条件が違うので、ここで手掛かりを捨てると「verify は緑なのに」を切り分けられない。
    console.error("テストが通らないので SQL を集められない。先に `bun run test` を直す。\n");
    console.error(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    process.exit(1);
  }
  const rows = [];
  for (const f of fs.readdirSync(corpusDir)) {
    for (const line of fs.readFileSync(path.join(corpusDir, f), "utf8").split("\n")) {
      if (line.trim()) rows.push(JSON.parse(line));
    }
  }
  return rows;
}

/** 同じ SQL は 1 度だけ通す。出所は全部持つ（同じ文を複数の call site が出す）。 */
function distinct(rows) {
  const bySql = new Map();
  for (const { sql, at } of rows) {
    const seen = bySql.get(sql) ?? new Set();
    seen.add(at);
    bySql.set(sql, seen);
  }
  return [...bySql].map(([sql, at]) => ({ sql, at: [...at].sort() }));
}

// 集めた SQL は捨てる。残すと $TMPDIR に組み立てた SQL 全文が実行ごとに溜まる。
process.on("exit", () => fs.rmSync(corpusDir, { recursive: true, force: true }));

const rows = collect();
if (rows.length === 0) {
  console.error(`SQL が 1 文も集まらなかった。server/test/fake-db.ts の書き出しが壊れている可能性がある。`);
  process.exit(1);
}
const statements = distinct(rows);
const observed = new Set(rows.map((r) => r.at));

const failures = await withTempPostgres("sql-parse", async ({ port, password }) => {
  const client = new pg.Client({
    host: "127.0.0.1",
    port: Number(port),
    user: "postgres",
    password,
    database: "postgres",
  });
  await client.connect();
  const bad = [];
  try {
    for (const { sql, at } of statements) {
      try {
        await client.query(`explain (generic_plan, costs false, format json) ${sql}`);
      } catch (e) {
        bad.push({ at, sql, message: e.message, position: e.position });
      }
    }
  } finally {
    await client.end();
  }
  return bad;
});

// 空振りの検出。到達しなかった call site は、件数だけでなく file:line を毎回並べる。
const sites = callSites(root);
const uncovered = sites.filter((s) => !observed.has(s));
const byFile = new Map();
for (const s of uncovered) {
  const file = s.slice(0, s.lastIndexOf(":"));
  byFile.set(file, [...(byFile.get(file) ?? []), s]);
}

const ledger = [];
for (const [file, list] of [...byFile].sort()) {
  const allowed = ALLOWED_UNCOVERED.find((a) => a.file === file);
  if (!allowed) {
    ledger.push(
      `${file}: ${list.length} 箇所がどのテストからも SQL を組み立てていない\n    ${list.join("\n    ")}`,
    );
  } else if (list.length > allowed.uncovered) {
    ledger.push(
      `${file}: 到達しない call site が ${allowed.uncovered} から ${list.length} へ増えた\n    ${list.join("\n    ")}`,
    );
  }
}
for (const a of ALLOWED_UNCOVERED) {
  const now = (byFile.get(a.file) ?? []).length;
  if (now < a.uncovered) {
    ledger.push(`${a.file}: 到達しない call site は ${now} 箇所に減った。ALLOWED_UNCOVERED の数を下げる`);
  }
  // 総数も見る。1 箇所を到達させて 1 箇所足す取り替えは、未到達の数だけでは差し引き 0 で素通りする。
  const total = sites.filter((s) => s.startsWith(`${a.file}:`)).length;
  if (total !== a.sites) {
    ledger.push(`${a.file}: call site が ${a.sites} から ${total} へ変わった。ALLOWED_UNCOVERED を見直す`);
  }
}

if (failures.length) {
  console.error(`実 PostgreSQL が受け付けない SQL が ${failures.length} 文ある。\n`);
  for (const f of failures) {
    console.error(`  ${f.at.join(" / ")}`);
    console.error(`    ${f.message}${f.position ? `（位置 ${f.position}）` : ""}`);
    console.error(`    ${f.sql.replace(/\s+/g, " ").slice(0, 300)}\n`);
  }
}
if (ledger.length) {
  console.error(`${failures.length ? "" : "\n"}SQL を組み立てていない call site がある。\n`);
  for (const l of ledger) console.error(`  ${l}`);
  console.error(
    `\n到達させられないなら scripts/lib/sql-call-sites.mjs の ALLOWED_UNCOVERED へ理由付きで足す。`,
  );
}
if (failures.length || ledger.length) process.exit(1);

console.log(
  `SQL: ${statements.length} 文（${rows.length} 回）を実 PostgreSQL が受け付けた。` +
    `server/src の SQL 実行箇所 ${sites.length - uncovered.length} / ${sites.length} が到達済み` +
    (uncovered.length ? `（残り ${uncovered.length} 箇所は ALLOWED_UNCOVERED に理由付きで載せてある）` : ""),
);
