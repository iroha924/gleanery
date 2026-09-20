#!/usr/bin/env node
// SQL の書き方が、移行で決めた形から戻っていないかを見る。
//
// **どちらも型では止まらない。**手書きの結果型は SQL と突き合わされず、kysely の deprecated な
// 呼び出しは実行時に警告を出すだけで、コンパイルは通る。放っておくと次に書くコードが元の形に戻る。
//
// 生成した型と schema.sql のずれは別の検査が見る（scripts/codegen.mjs --check）。

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const fail = [];

/** owner の鍵で migration を流す経路と、接続の版の検査。kysely の instance をまだ持てない。 */
const RAW_QUERY_OK = new Set(["server/src/db.ts", "server/src/admin.ts"]);

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

// 実行時に logOnce で警告を出すだけの呼び出し。型は通る（kysely 0.29.6 の dist を調べた結果）。
const DEPRECATED = [
  [/\.orderBy\(\s*\[/, "orderBy(配列) は deprecated。orderBy(expr, 'asc') を重ねて書く"],
  [/\.withinGroupOrderBy\(\s*\[/, "withinGroupOrderBy(配列) は deprecated。呼び出しを重ねて書く"],
  [/\.orderBy\(\s*"[^"]*\s+(asc|desc)"/, "方向を文字列へ埋めない。orderBy(expr, 'desc') と書く"],
  [/\.withinGroupOrderBy\(\s*"[^"]*\s+(asc|desc)"/, "方向を文字列へ埋めない。第 2 引数で渡す"],
  [/\.withTables[(<]/, "withTables は deprecated。$extendTables を使う"],
];

for (const file of [...walk(path.join(root, "server/src")), ...walk(path.join(root, "server/test"))]) {
  const rel = path.relative(root, file);
  const text = fs.readFileSync(file, "utf8");
  text.split("\n").forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    if (/\.query\s*</.test(line) && !RAW_QUERY_OK.has(rel)) {
      fail.push(`${at}: 結果型を手で書いている。kysely の推論を使う（#74）`);
    }
    for (const [re, why] of DEPRECATED) if (re.test(line)) fail.push(`${at}: ${why}`);
  });
}

// migration の型は kysely/migration から取る。root からの import は deprecated（dist に 18 件）。
for (const file of walk(path.join(root, "server/src"))) {
  const rel = path.relative(root, file);
  const m = fs.readFileSync(file, "utf8").match(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"kysely"/);
  if (m && /\b(Migration|Migrator|MigrationProvider|MigrationResultSet)\b/.test(m[1])) {
    fail.push(`${rel}: migration の型は "kysely/migration" から import する`);
  }
}

if (fail.length) {
  console.error(`SQL の書き方:\n${fail.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `SQL の書き方: 手書きの結果型は ${RAW_QUERY_OK.size} ファイルの例外だけ、deprecated な呼び出しは無い`,
);
