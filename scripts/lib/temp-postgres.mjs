// 使い捨ての PostgreSQL を立て、db/schema.sql を当てて渡す。型の生成（scripts/codegen.mjs）と
// SQL の検査（scripts/check-sql-parse.mjs）が同じ形を使う。
//
// 手元の開発用 DB を使わない。手元の DB は migration を当て損ねていたり、試した列が残っていたり
// する。そこを入力にすると、db/schema.sql に無い形を「通った」と読んでしまう。正本だけを入力にする。
//
// 資格情報を argv へ出さない。一時 DB のパスワードは環境変数で docker へ渡す
// （docker の `-e NAME` は値を書かずに親の環境から取る）。

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

export const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");
const SCHEMA = path.join(root, "db/schema.sql");

// db/compose.yaml と同じ image。digest で留める。CI が third-party action を full SHA で
// 固定しているのと同じ理由で、上流がタグを差し替えても取り込まない。版を上げるときは両方直す。
export const IMAGE =
  "pgvector/pgvector:0.8.6-pg18@sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a";

const LABEL = "gleanery-temp-postgres";
const docker = (args, opts = {}) => execFileSync("docker", args, { encoding: "utf8", ...opts });
// 起動時に古い分をまとめて消さない。label でも名前の接頭辞でも、並行して走っているもう一方の
// 稼働中のコンテナに当たる（実測: filter は label のキー一致で、実行中でも rm -f が通る）。
// SIGINT や打ち切りで抜けた残骸は `docker rm -f $(docker ps -aq --filter label=gleanery-temp-postgres)` で消す。

/**
 * 立ち上がるまで待つ。**TCP で確かめる。**初期化と init script のあいだ、entrypoint は
 * `listen_addresses=''` の一時 server を上げて、終わったら落としてから本番を上げ直す。
 * 一時 server は TCP を listen しないので、socket 経由の `select 1` はこの窓でも通ってしまう
 * （実測: 窓は約 100ms。CI で waitReady がそこで返り、続く schema の流し込みが
 * `connection to server on socket … failed: No such file or directory` で落ちた）。
 */
const waitReady = (name, deadlineMs = 60_000) => {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const r = spawnSync(
      "docker",
      ["exec", name, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-c", "select 1"],
      { stdio: "ignore" },
    );
    if (r.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error(`一時 DB が ${deadlineMs / 1000} 秒で立ち上がらなかった`);
};

/**
 * 一時 DB を立て、`db/schema.sql` を当てて `fn` へ接続先を渡す。戻り方によらず必ず消す。
 * `purpose` はコンテナ名に入るだけで、並行して走る別の用途と取り違えないための目印である。
 */
export async function withTempPostgres(purpose, fn) {
  // 名前は毎回変える。固定にすると、並行して走ったもう一方のコンテナを消してしまう。
  const name = `gleanery-${purpose}-${crypto.randomBytes(4).toString("hex")}`;
  const env = { ...process.env, POSTGRES_PASSWORD: crypto.randomBytes(24).toString("base64url") };
  try {
    // ポートは 0 を渡して空きを選ばせる。開発用の DB が 5432 を使っているので固定にできない。
    docker(
      [
        "run",
        "-d",
        "--name",
        name,
        "--label",
        LABEL,
        "-e",
        "POSTGRES_PASSWORD",
        "-p",
        "127.0.0.1:0:5432",
        IMAGE,
      ],
      { env, stdio: ["ignore", "ignore", "inherit"] },
    );
    waitReady(name);

    // schema.sql は role を自分で作る（create role ... login）ので、そのまま丸ごと当てられる。
    // ON_ERROR_STOP が無いと、途中の失敗を飛ばして「当たったが中身が欠けている」状態になる。
    docker(
      [
        "exec",
        "-i",
        name,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-q",
        "-f",
        "-",
      ],
      { input: fs.readFileSync(SCHEMA, "utf8"), stdio: ["pipe", "ignore", "inherit"] },
    );

    const port = docker(["port", name, "5432/tcp"]).trim().split(":").pop();
    return await fn({ port, password: env.POSTGRES_PASSWORD, env, name });
  } finally {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  }
}
