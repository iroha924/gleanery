// SQL を実行する call site の台帳。どこが検査に到達していないかを `file:line` で名指しする。
//
// **行番号は持ち越さない。**静的な走査も観測も、同じ作業ツリーからその場で取る。持ち越すのは
// 「このファイルは何箇所が未到達でよいか」という数と理由だけなので、行がずれても壊れない。

import fs from "node:fs";
import path from "node:path";

// kysely の実行と、node:sqlite へ生の SQL を渡す形の両方を数える。後者を落とすと、schema の適用・migration・
// 接続の設定が台帳に載らないまま「全部見ている」ように読める。node:sqlite の接続を持つ変数は `raw` と呼ぶ
// （`.exec(` だけで数えると RegExp#exec まで拾う）。
const SITE = /\.(?:execute|executeTakeFirst|executeTakeFirstOrThrow)\s*\(|\braw\.(?:exec|prepare)\s*\(/;
// transaction や接続を張る `.execute(fn)` は SQL を組み立てない。中の問い合わせが別の call site になる。
const NOT_A_QUERY = /\.(?:transaction|connection)\(\)\s*\.execute\s*\(/;
// kysely へ node:sqlite を渡すアダプタ。どの SQL もここを通るので、ここを数えると全部が 1 箇所に潰れる。
const ADAPTER = "server/src/kysely-node-sqlite.ts";

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

/** `server/src` の SQL 実行箇所を `server/src/foo.ts:12` の形で返す。 */
export function callSites(root) {
  const out = [];
  for (const file of walk(path.join(root, "server/src")).sort()) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel === ADAPTER) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (SITE.test(line) && !NOT_A_QUERY.test(line)) out.push(`${rel}:${i + 1}`);
    });
  }
  return out;
}

/**
 * 子プロセスのレーン（scripts/check-sql-live.mjs）が受け持つファイル。test から db を差し込む継ぎ目が無く、
 * 配る entrypoint を子プロセスで起動するほうが、接続の役割と後始末まで一緒に見える。
 */
export const LIVE_FILES = ["server/src/cli.ts", "server/src/github.ts", "server/src/capture.ts"];

/** 子プロセスのレーンでも踏めない call site と、その理由。1 行 1 箇所で書く。 */
export const ALLOWED_UNREACHED = [];

/**
 * test から実行できない call site の数と、その理由。LIVE_FILES は子プロセスのレーンが全部見るので、
 * ここには出てこない。`sites` はそのファイルの call site の総数で、1 箇所を到達させて同時に 1 箇所足す
 * 取り替えを落とすために持つ。
 */
export const ALLOWED_UNCOVERED = [];
