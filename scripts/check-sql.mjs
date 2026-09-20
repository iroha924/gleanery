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
  [/\.query\s*</g, "結果型を手で書いている。kysely の推論を使う"],
  // 型引数の無い query に SQL を組んで渡す形。移行前はこれが既定だった。
  [/\.query\(\s*`/g, "SQL を文字列で組んで query へ渡している。builder か sql テンプレートで書く"],
  [/\.orderBy\(\s*\[/g, "orderBy(配列) は deprecated。orderBy(expr, 'asc') を重ねて書く"],
  [/\.orderBy\(\s*['"][^'"]*\s+(?:asc|desc)['"]/g, "方向を文字列へ埋めない。orderBy(expr, 'desc') と書く"],
];

// 識別子をそのまま SQL へ挿す口。外部入力を渡すと注入になるので、定数しか渡していないことを目で見る。
const IDENTIFIER_SINKS = /\bsql\.(?:raw|table|ref|lit)\s*[(<]/g;

const files = [...walk(path.join(root, "server/src")), ...walk(path.join(root, "server/test"))];
let sinks = 0;
for (const file of files) {
  const rel = path.relative(root, file);
  const text = fs.readFileSync(file, "utf8");
  sinks += text.match(IDENTIFIER_SINKS)?.length ?? 0;
  for (const [re, why] of RULES) {
    if (re.source.startsWith("\\.query") && RAW_QUERY_OK.has(rel)) continue;
    for (const m of text.matchAll(re)) {
      fail.push(`${rel}:${text.slice(0, m.index).split("\n").length}: ${why}`);
    }
  }
}

if (fail.length) {
  console.error(`SQL の書き方:\n${fail.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
// `sql<T>` の T は SQL から推論されず、この検査も見ない（SKILL.md に書いてある）。件数だけ出す。
const rawTyped = files.reduce((n, f) => n + (fs.readFileSync(f, "utf8").match(/\bsql<\{/g)?.length ?? 0), 0);
console.log(
  `SQL の書き方: .query< は ${RAW_QUERY_OK.size} ファイルの例外だけ、deprecated な orderBy は無い` +
    `（sql<{…}> の手書き結果型 ${rawTyped} 件と、識別子を挿す ${sinks} 件は、この検査の対象外）`,
);
