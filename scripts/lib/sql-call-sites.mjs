// SQL を実行する call site の台帳。どこが検査に到達していないかを `file:line` で名指しする。
//
// **行番号は持ち越さない。**静的な走査も観測も、同じ作業ツリーからその場で取る。持ち越すのは
// 「このファイルは何箇所が未到達でよいか」という数と理由だけなので、行がずれても壊れない。

import fs from "node:fs";
import path from "node:path";

// kysely の実行と、pg の client へ生の SQL を渡す形の両方を数える。後者を落とすと、schema の適用と
// migration が台帳にも EXPLAIN にも載らないまま「全部見ている」ように読める。
const SITE = /\.(?:execute|executeTakeFirst|executeTakeFirstOrThrow)\s*\(|\.query\s*[(<]/;
// transaction を張る `.execute(fn)` は SQL を組み立てない。中の問い合わせが別の call site になる。
// Hono の `c.req.query(...)` は SQL ではない（scripts/check-sql.mjs が同じ除外を持つ）。
const NOT_A_QUERY = /\.transaction\(\)\s*\.execute\s*\(|\breq\.query\s*\(/;

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
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (SITE.test(line) && !NOT_A_QUERY.test(line)) out.push(`${rel}:${i + 1}`);
    });
  }
  return out;
}

/**
 * 実 DB のレーン（scripts/check-sql-live.mjs）が受け持つファイル。偽の db を差し込む継ぎ目が無く、
 * 配る entrypoint を子プロセスで起動するほうが、role と接続まで一緒に見える。
 */
export const LIVE_FILES = [
  "server/src/cli.ts",
  "server/src/github.ts",
  "server/src/http/routes/knowledge.ts",
  "server/src/capture.ts",
];

/** 実 DB でも踏めない call site と、その理由。1 行 1 箇所で書く。 */
export const ALLOWED_UNREACHED = [];

/**
 * 偽の db で SQL を組み立てられない call site の数と、その理由。LIVE_FILES は実 DB のレーンが
 * 全部見るので、ここには出てこない。`sites` はそのファイルの call site の総数で、1 箇所を
 * 到達させて同時に 1 箇所足す取り替えを落とすために持つ。
 */
export const ALLOWED_UNCOVERED = [
  {
    file: "server/src/titles.ts",
    sites: 2,
    uncovered: 1,
    // 題を書き戻す更新は OpenAI の応答の後にある。対象 0 件で止めると、この 1 文だけ出ない。
  },
  {
    file: "server/src/admin.ts",
    sites: 8,
    uncovered: 8,
    // schema の適用と migration。owner の鍵でしか動かず、kysely を持てないので pg の client へ
    // 生の SQL を渡す（scripts/check-sql.mjs の RAW_QUERY_OK が名指しで許している 2 ファイルの 1 つ）。
  },
  {
    file: "server/src/db.ts",
    sites: 4,
    uncovered: 4,
    // 接続と schema の版の確認。kysely の instance を持つ前に走る。
  },
];
