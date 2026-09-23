#!/usr/bin/env node
// npm pack した tarball を利用者が受け取る形で確かめる（CI の check と release が通る）。使い方: node scripts/check-tarball.mjs <tgz>
// 中身の一覧（scripts/lib/tarball.mjs）、version がリポジトリと同じこと、リポジトリの外で CLI が起動し一時 HOME に DB を作れること

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tarballProblems, trackedDistribution } from "./lib/tarball.mjs";

const tgz = process.argv[2] && path.resolve(process.argv[2]);
if (!tgz) throw new Error("tarball の path を渡す");
const root = path.resolve(import.meta.dirname, "..");
const paths = new Set(
  execFileSync("tar", ["tzf", tgz], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.endsWith("/"))
    .map((f) => f.replace(/^package\//, "")),
);
const problems = tarballProblems(paths, trackedDistribution(root));
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

// **リポジトリの外へ出す。**中で展開すると、同梱物を取り違えても親を辿って当たり、通ってしまう。
const out = fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-tarball-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-home-"));
// 持ち主の DB を指す GLEANERY_DB は子へ渡さない（一時 HOME の DB だけを作る）
const parentEnv = { ...process.env };
delete parentEnv.GLEANERY_DB;
try {
  execFileSync("tar", ["xzf", tgz, "-C", out]);
  const pkg = path.join(out, "package");
  const cli = (...args) =>
    execFileSync(process.execPath, [path.join(pkg, "dist", "cli.js"), ...args], {
      cwd: out,
      encoding: "utf8",
      env: { ...parentEnv, HOME: home, USERPROFILE: home },
    });
  const version = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version;
  const expected = JSON.parse(fs.readFileSync(path.join(root, "plugin", "package.json"), "utf8")).version;
  if (version !== expected)
    throw new Error(`tarball は ${version}。リポジトリの version は ${expected}（古い tarball）`);
  const named = cli("--version").trim().split(/\s+/)[0];
  if (named !== version)
    throw new Error(`tarball の CLI は ${named} を名乗った。package の version は ${version}`);
  cli("--help");
  cli("db", "--help");
  cli("init");
  if (!fs.existsSync(path.join(home, ".gleanery", "gleanery.db")))
    throw new Error("init が DB を作らなかった");
  // Web の画面の資産は配らない（端末の画面へ移した）。残っていれば bundle の消し忘れ
  if (fs.existsSync(path.join(pkg, "dist", "dashboard")))
    throw new Error("tarball に dist/dashboard が残っている");
  console.log(`tarball: ${paths.size} ファイル、配布物の一覧と一致。CLI ${version} が起動し、DB を作れた`);
} finally {
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
