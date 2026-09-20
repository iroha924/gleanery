#!/usr/bin/env node
// db/schema.sql から kysely の型を作り、server/src/db-types.ts へ書く。
//
// **生成元は使い捨ての PostgreSQL で、手元の開発用 DB ではない。**手元の DB は migration を
// 当て損ねていたり、試した列が残っていたりする。そこから型を作ると schema.sql に無い形が
// 型へ写り、コンパイルは通るのに正本と合わない。db/schema.sql だけを入力にする。
//
// --check は kysely-codegen の --verify へ渡す。schema.sql を変えたのに型を作り直し忘れた commit を
// ここで止める。CI がこれを走らせる。
//
// 資格情報を argv へ出さない。一時 DB のパスワードは環境変数で docker と codegen へ渡す
// （docker の `-e NAME` は値を書かずに親の環境から取る）。

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "server/src/db-types.ts");
const SCHEMA = path.join(root, "db/schema.sql");
// db/compose.yaml と同じ image。digest で留める。CI が third-party action を full SHA で
// 固定しているのと同じ理由で、上流がタグを差し替えても取り込まない。版を上げるときは両方直す。
const IMAGE =
  "pgvector/pgvector:0.8.6-pg18@sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a";
// 名前は毎回変える。固定にすると、並行して走ったもう一方のコンテナを消してしまう。
const NAME = `gleanery-codegen-${crypto.randomBytes(4).toString("hex")}`;
const check = process.argv.includes("--check");

const LABEL = "gleanery-codegen";
const docker = (args, opts = {}) => execFileSync("docker", args, { encoding: "utf8", ...opts });
const remove = () => spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
/** 前回が SIGINT や打ち切りで抜けて残した分を回収する。名前は毎回変わるので label で引く。 */
const sweep = () => {
  const left = spawnSync("docker", ["ps", "-aq", "--filter", `label=${LABEL}`], { encoding: "utf8" });
  const ids = (left.stdout ?? "").split("\n").filter(Boolean);
  if (ids.length) spawnSync("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
};

/** 立ち上がるまで待つ。pg_isready は初期化の途中でも一度 true を返すので、実際に問い合わせて確かめる。 */
const waitReady = (deadlineMs = 60_000) => {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const r = spawnSync(
      "docker",
      ["exec", NAME, "psql", "-U", "postgres", "-d", "postgres", "-c", "select 1"],
      {
        stdio: "ignore",
      },
    );
    if (r.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error(`一時 DB が ${deadlineMs / 1000} 秒で立ち上がらなかった`);
};

const env = { ...process.env, POSTGRES_PASSWORD: crypto.randomBytes(24).toString("base64url") };

sweep();
try {
  // ポートは 0 を渡して空きを選ばせる。開発用の DB が 5432 を使っているので固定にできない。
  docker(
    [
      "run",
      "-d",
      "--name",
      NAME,
      "--label",
      LABEL,
      "-e",
      "POSTGRES_PASSWORD",
      "-p",
      "127.0.0.1:0:5432",
      IMAGE,
    ],
    {
      env,
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  waitReady();

  // schema.sql は role を自分で作る（create role ... login）ので、そのまま丸ごと当てられる。
  // ON_ERROR_STOP が無いと、途中の失敗を飛ばして「型はできたが中身が欠けている」状態になる。
  docker(
    [
      "exec",
      "-i",
      NAME,
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
    {
      input: fs.readFileSync(SCHEMA, "utf8"),
      stdio: ["pipe", "ignore", "inherit"],
    },
  );

  const port = docker(["port", NAME, "5432/tcp"]).trim().split(":").pop();
  try {
    execFileSync(
      path.join(root, "server/node_modules/.bin/kysely-codegen"),
      [
        "--dialect",
        "postgres",
        "--out-file",
        OUT,
        "--include-pattern",
        "gleanery.*",
        ...(check ? ["--verify"] : []),
      ],
      {
        env: {
          ...env,
          DATABASE_URL: `postgres://postgres:${env.POSTGRES_PASSWORD}@127.0.0.1:${port}/postgres`,
        },
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
  } catch (e) {
    if (!check) throw e;
    console.error(
      `${path.relative(root, OUT)} が db/schema.sql と合っていない。\`bun run codegen\` で作り直す`,
    );
    // exit を呼ばない。finally が飛んで、使い捨てのコンテナが残る。
    process.exitCode = 1;
  }

  if (process.exitCode !== 1) {
    console.log(
      check
        ? `${path.relative(root, OUT)} は db/schema.sql と一致している`
        : `${path.relative(root, OUT)} を db/schema.sql から作り直した`,
    );
  }
} finally {
  remove();
}
