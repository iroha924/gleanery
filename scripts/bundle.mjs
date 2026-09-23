#!/usr/bin/env node
// 配る物を plugin/ の下へ組み立てる。**plugin/ そのものが npm package の root** になり、
// Claude Code は marketplace の npm source から、Codex は同じ tarball から展開する。
//
// **生成物は git で追跡しない。**publish のときに作るので、commit との差は検査しない
// （以前は plugin/dist をコミットして `git diff --exit-code` で見ていた）。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "plugin", "dist");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

// **--minify を足さない。**stricli の日本語のエラー文は例外クラスの constructor.name で振り分けるので、
// クラス名が潰れると英語へ戻る。
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
for (const entry of ["mcp", "capture"]) {
  run("bun", ["build", `server/src/${entry}.ts`, "--target=node", "--outfile", `plugin/dist/${entry}.js`]);
}
// CLI は Ink を含み、その開発用の import を差し替える plugin が要るので、Bun.build の script で束ねる。
run("bun", ["scripts/bundle-cli.ts"]);

// 配る先は server/src/assets.ts が dashboardRoot() で探す位置。
run("bun", ["run", "--cwd", "dashboard", "build"]);
fs.cpSync(path.join(root, "dashboard", "dist"), path.join(dist, "dashboard"), { recursive: true });

// plugin の cache には repository が無いので、schema と compose を持たせる。
const db = path.join(root, "plugin", "db");
fs.rmSync(db, { recursive: true, force: true });
fs.mkdirSync(db, { recursive: true });
for (const name of ["compose.yaml", "schema.sql"]) {
  fs.copyFileSync(path.join(root, "db", name), path.join(db, name));
}
fs.cpSync(path.join(root, "db", "migrations"), path.join(db, "migrations"), { recursive: true });

// npm は Windows で shebang を読んで .cmd を作るので、実行権が要る。
for (const entry of ["cli"]) fs.chmodSync(path.join(dist, `${entry}.js`), 0o755);

// **束ねても同梱の義務は消えない。**配るたびに、そのときの node_modules から作り直す。
run("node", ["scripts/third-party-notices.mjs"]);

const count = (dir) =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
console.log(
  `配布物: dist ${count(dist)} ファイル / db ${count(db)} ファイル（${path.relative(process.cwd(), path.join(root, "plugin"))} が package の root）`,
);
