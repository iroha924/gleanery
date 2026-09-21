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
 * どのテストからも SQL を組み立てていない call site の数と、その理由。
 * 数を増やす変更は通らない。減ったときも落として、古い許しが残らないようにする。
 *
 * `sites` はそのファイルの call site の総数。未到達の数だけを見ると、1 箇所を到達させて同時に
 * 1 箇所足す取り替えが差し引き 0 で素通りする。総数も固定して、その交換を落とす。
 */
export const ALLOWED_UNCOVERED = [
  {
    file: "server/src/cli.ts",
    sites: 19,
    uncovered: 19,
    // withDb が open(env, role) を直に呼び、db を注入する継ぎ目が無い。継ぎ目を作るより、配る
    // entrypoint を子プロセスで起動して実 DB へ通すほうが role と接続まで見える（#85 の 2 本目）。
  },
  {
    file: "server/src/http/routes/knowledge.ts",
    sites: 9,
    uncovered: 9,
    // route は http/runtime.ts の module 束縛の db を使う。fake を注入すると「route が誤って
    // 書き込みを始めた」を検出できない（fake は書き込みも受け付ける）。reader で実 DB へ通す。
  },
  {
    file: "server/src/github.ts",
    sites: 14,
    uncovered: 14,
    // syncGithub は内部で gh を起動する。PATH へ偽物を置く形は子プロセスで起動するレーンに寄せる。
  },
  {
    file: "server/src/capture.ts",
    sites: 5,
    uncovered: 1,
    // flush は open(env, "capture") で自分で繋ぐ。cli と同じ理由で 2 本目のレーンが見る。
  },
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
    // schema の適用と migration。kysely を持てない owner の経路で、pg の client へ生の SQL を渡す
    // （scripts/check-sql.mjs の RAW_QUERY_OK が名指しで許している 2 ファイルのうちの 1 つ）。
  },
  {
    file: "server/src/db.ts",
    sites: 4,
    uncovered: 4,
    // 接続と schema の版の確認。同じく kysely の instance を持つ前に走る。
  },
];
