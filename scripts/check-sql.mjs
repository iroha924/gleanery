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

/** owner の鍵で migration を流す経路と、接続の版の検査。kysely の instance をまだ持てない。 */
const RAW_QUERY_OK = new Set(["server/src/db.ts", "server/src/admin.ts"]);

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

// 改行を跨いで見る。整形が引数を折り返すと、行ごとの正規表現は同じ書き方を取りこぼす。
const RULES = [
  // 型引数の有無を問わず pg の query を弾く。移行前はこれが既定だった。
  // Hono の `c.req.query(...)` は別物なので、直前が `req.` のものは見ない。
  [/(?<!req)\.query\s*[(<]/g, "SQL を手で書いて pg の query へ渡している。builder か sql テンプレートで書く"],
  [/\.orderBy\(\s*\[/g, "orderBy(配列) は deprecated。orderBy(expr, 'asc') を重ねて書く"],
  [/\.orderBy\(\s*([`'"])[^`'"]*\s+(?:asc|desc)\1/g, "方向を文字列へ埋めない。orderBy(expr, 'desc') と書く"],
];

const files = [...walk(path.join(root, "server/src")), ...walk(path.join(root, "server/test"))];
for (const file of files) {
  const rel = path.relative(root, file);
  const text = fs.readFileSync(file, "utf8");
  for (const [re, why] of RULES) {
    if (re === RULES[0][0] && RAW_QUERY_OK.has(rel)) continue;
    for (const m of text.matchAll(re)) {
      fail.push(`${rel}:${text.slice(0, m.index).split("\n").length}: ${why}`);
    }
  }
}

if (fail.length) {
  console.error(`SQL の書き方:\n${fail.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `SQL の書き方: pg の query は ${RAW_QUERY_OK.size} ファイルの例外だけ、deprecated な orderBy は無い`,
);
