#!/usr/bin/env node
// SQL の書き方が、移行で決めた形から戻っていないかを見る。
//
// **どちらも型では止まらない。**手書きの結果型は SQL と突き合わされず、kysely の deprecated な
// 呼び出しは実行時に警告を出すだけで、コンパイルは通る。放っておくと次に書くコードが元の形に戻る。
//
// 生成した型と schema.sql のずれは scripts/codegen.mjs が見る。

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const fail = [];

/**
 * node:sqlite を直に扱ってよいファイル。接続の設定（sqlite.ts・db-write.ts）、kysely の組み立て（db.ts）、
 * schema の適用と migration（admin.ts）、kysely へ渡すアダプタ。ほかのアプリのコードは kysely で書く
 * （結果の型が schema から推論される）。
 */
const RAW_SQL_OK = new Set([
  "server/src/sqlite.ts",
  "server/src/db.ts",
  "server/src/db-write.ts",
  "server/src/admin.ts",
  "server/src/kysely-node-sqlite.ts",
]);

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

// 改行を跨いで見る。整形が引数を折り返すと、行ごとの正規表現は同じ書き方を取りこぼす。
// 生の接続を手に入れる経路は 2 つ（node:sqlite を import する、接続の関数を呼ぶ）。両方を止めれば、
// 呼び方（exec・prepare）を 1 つずつ数えなくてよい。test は fixture を入れるのに生の接続を使ってよい。
const RAW = /from\s+["']node:sqlite["']|\bconnect(?:Reader|Writer)\s*\(/g;
const RULES = [
  [RAW, "node:sqlite の接続を直に扱っている。kysely（openReader / openWriter）で書く"],
  [/\.orderBy\(\s*\[/g, "orderBy(配列) は deprecated。orderBy(expr, 'asc') を重ねて書く"],
  [/\.orderBy\(\s*([`'"])[^`'"]*\s+(?:asc|desc)\1/g, "方向を文字列へ埋めない。orderBy(expr, 'desc') と書く"],
];

const files = [...walk(path.join(root, "server/src")), ...walk(path.join(root, "server/test"))];
for (const file of files) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  const text = fs.readFileSync(file, "utf8");
  for (const [re, why] of RULES) {
    if (re === RAW && (RAW_SQL_OK.has(rel) || rel.startsWith("server/test/"))) continue;
    for (const m of text.matchAll(re)) {
      fail.push(`${rel}:${text.slice(0, m.index).split("\n").length}: ${why}`);
    }
  }
}

if (fail.length) {
  console.error(`SQL の書き方:\n${fail.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`SQL の書き方: 生の SQL は ${RAW_SQL_OK.size} ファイルの例外だけ、deprecated な orderBy は無い`);
