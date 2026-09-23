#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const { base } = parseArgs({ options: { base: { type: "string" } } }).values;
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });
const git = (...args) => run("git", args).trim();

if (git("status", "--porcelain")) {
  throw new Error("未commitの変更がある。review済みのcleanなcommitから実行する");
}

const planArgs = ["scripts/release-plan.mjs", "--json"];
if (base) planArgs.push("--base", base);
const plan = JSON.parse(run(process.execPath, planArgs));
if (plan.kind === "none") throw new Error(`${plan.base}からnpm packageへ入る変更が無い`);

run(process.execPath, ["scripts/check-mcp-version.mjs", "--base", plan.base], { stdio: "inherit" });
run("bun", ["run", "verify"], { stdio: "inherit" });
if (git("status", "--porcelain")) {
  throw new Error("verifyが追跡fileを変更した。変更を確認してcommitし直す");
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), `gleanery-${plan.versions.package}-`));
const packed = JSON.parse(
  run("npm", ["pack", "--json", "--pack-destination", stage], { cwd: path.join(root, "plugin") }),
)[0];
const paths = new Set(packed.files.map((file) => file.path));
const trackedDistribution = git(
  "ls-files",
  "plugin/skills",
  "plugin/hooks",
  "plugin/mcp",
  "plugin/.claude-plugin",
  "plugin/.codex-plugin",
  "plugin/LICENSE",
  "db",
)
  .split("\n")
  .filter(Boolean)
  .map((file) => file.replace(/^plugin\//, ""));
for (const required of [
  "dist/cli.js",
  "dist/mcp.js",
  "dist/capture.js",
  "db/schema.sql",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "package.json",
  "THIRD_PARTY_NOTICES.md",
  ...trackedDistribution,
]) {
  if (!paths.has(required)) throw new Error(`tarballに${required}が無い`);
}
for (const file of paths) {
  if (
    file.includes("node_modules/") ||
    /(^|\/)\.env(?:\.|$)/.test(file) ||
    file.endsWith("bun.lock") ||
    /(^|\/)src\/.+\.(?:ts|tsx)$/.test(file)
  ) {
    throw new Error(`tarballへ入れてはいけないfileがある: ${file}`);
  }
}

const tgz = path.join(stage, packed.filename);
const unpacked = path.join(stage, "unpacked");
fs.mkdirSync(unpacked);
run("tar", ["xzf", tgz, "-C", unpacked]);
const cli = path.join(unpacked, "package", "dist", "cli.js");
const actual = run(process.execPath, [cli, "--version"], { cwd: stage }).trim().split(/\s+/)[0];
if (actual !== plan.versions.package) {
  throw new Error(`tarballのCLIは${actual}を名乗った。package versionは${plan.versions.package}`);
}
run(process.execPath, [cli, "--help"], { cwd: stage });
run(process.execPath, [cli, "db", "--help"], { cwd: stage });

console.log(`release種別: ${plan.kind}`);
console.log(`review対象commit: ${plan.commit}`);
console.log(`検査済みtarball: ${tgz}`);
console.log(`次: npm publish ${tgz} --tag next`);
console.log(`registry確認: npm pack gleanery@${plan.versions.package} --silent`);
console.log(`merge後: git tag v${plan.versions.package} <merge commit>`);
console.log(`tag push後: npm dist-tag add gleanery@${plan.versions.package} latest`);
console.log("最後にClaude/Codexのplugin cacheを更新し、sessionを張り直す");
