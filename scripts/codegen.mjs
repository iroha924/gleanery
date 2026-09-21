#!/usr/bin/env node
// db/schema.sql から kysely の型を作り、server/src/db-types.ts へ書く。
//
// **生成元は使い捨ての PostgreSQL で、手元の開発用 DB ではない。**理由と立て方は
// scripts/lib/temp-postgres.mjs にある。db/schema.sql だけを入力にする。
//
// --check は kysely-codegen の --verify へ渡す。schema.sql を変えたのに型を作り直し忘れた commit を
// ここで止める。CI がこれを走らせる。

import { execFileSync } from "node:child_process";
import path from "node:path";
import { root, withTempPostgres } from "./lib/temp-postgres.mjs";

const OUT = path.join(root, "server/src/db-types.ts");
const check = process.argv.includes("--check");

await withTempPostgres("codegen", ({ port, password, env }) => {
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
        env: { ...env, DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${port}/postgres` },
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
  } catch (e) {
    if (!check) throw e;
    console.error(
      `${path.relative(root, OUT)} が db/schema.sql と合っていない。\`bun run codegen\` で作り直す`,
    );
    // exit を呼ばない。使い捨てのコンテナを消す finally が飛ぶ。
    process.exitCode = 1;
  }

  if (process.exitCode !== 1) {
    console.log(
      check
        ? `${path.relative(root, OUT)} は db/schema.sql と一致している`
        : `${path.relative(root, OUT)} を db/schema.sql から作り直した`,
    );
  }
});
