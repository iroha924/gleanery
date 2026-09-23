#!/usr/bin/env node
// CI が npm pack した tarball を、release:prepare と同じ一覧で検査する。使い方: node scripts/check-tarball.mjs <tgz>

import { execFileSync } from "node:child_process";
import path from "node:path";
import { tarballProblems, trackedDistribution } from "./lib/tarball.mjs";

const tgz = process.argv[2];
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
console.log(`tarball: ${paths.size} ファイル、配布物の一覧と一致`);
