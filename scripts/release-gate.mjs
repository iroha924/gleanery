#!/usr/bin/env node
// tag から npm へ stage してよいかを確かめる。release.yml が stage の前後で 2 回呼ぶ。
// 使い方: node scripts/release-gate.mjs --tag v1.2.3 --commit <sha>（GH_TOKEN と GITHUB_REPOSITORY が要る）

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { gateProblems } from "./lib/release-gate.mjs";

const root = path.resolve(import.meta.dirname, "..");
const { tag, commit } = parseArgs({
  options: { tag: { type: "string" }, commit: { type: "string" } },
}).values;
const repo = process.env.GITHUB_REPOSITORY;
if (!tag || !commit || !/^[0-9a-f]{40}$/.test(commit) || !repo) {
  throw new Error("--tag・--commit（40 桁の sha）と GITHUB_REPOSITORY を渡す");
}
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
const api = (endpoint) => JSON.parse(run("gh", ["api", endpoint]));
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

run("git", ["fetch", "--quiet", "origin", "main"]);
let mainIsAncestor = true;
try {
  run("git", ["merge-base", "--is-ancestor", "FETCH_HEAD", commit]);
} catch {
  mainIsAncestor = false;
}

// 注釈付きの tag は `^{}` の行が指す commit を取る
const refs = run("git", ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`])
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("\t"));
// ls-remote は ref の末尾でも当たる（`x/refs/tags/v1` も返る）ので、名前の完全一致で選ぶ
const exact = (name) => refs.find(([, ref]) => ref === name)?.[0];
const tagCommit = exact(`refs/tags/${tag}^{}`) ?? exact(`refs/tags/${tag}`) ?? null;

const { problems, pull } = gateProblems({
  tag,
  commit,
  repo,
  versions: {
    package: read("plugin/package.json").version,
    claude: read("plugin/.claude-plugin/plugin.json").version,
    codex: read("plugin/.codex-plugin/plugin.json").version,
    marketplace: read(".claude-plugin/marketplace.json").plugins.find((entry) => entry.name === "gleanery")
      ?.source?.version,
  },
  mainIsAncestor,
  tagCommit,
  pulls: api(`repos/${repo}/commits/${commit}/pulls`),
  runs: api(`repos/${repo}/actions/runs?head_sha=${commit}&event=pull_request&per_page=100`).workflow_runs,
});
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`${tag}: PR #${pull} の head ${commit} を stage してよい`);
