#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const attempt = (command, args, options = {}) => {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
      ...options,
    }).trim();
  } catch {
    return null;
  }
};
const manifestVersion = (where, manifest) => {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(where, manifest), "utf8"));
    return typeof value.version === "string"
      ? { status: "ok", version: value.version }
      : { status: "unknown", version: null };
  } catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "ENOENT"
      ? { status: "missing", version: null }
      : { status: "unknown", version: null };
  }
};
const dirs = (where) => {
  try {
    return fs.readdirSync(where, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "ENOENT" ? [] : null;
  }
};

const packageVersion = read("plugin/package.json").version;
const claudeManifest = read("plugin/.claude-plugin/plugin.json").version;
const codexManifest = read("plugin/.codex-plugin/plugin.json").version;
const marketplace = read(".claude-plugin/marketplace.json").plugins.find((entry) => entry.name === "gleanery")
  ?.source?.version;
const tagsText = attempt("npm", ["view", "gleanery", "dist-tags", "--json"]);
let tags = null;
try {
  tags = tagsText ? JSON.parse(tagsText) : null;
} catch {
  tags = null;
}
const remoteTags = attempt("git", ["ls-remote", "--tags", "origin"]);
const globalRoot = attempt("npm", ["root", "-g"]);
const globalPackage = globalRoot
  ? manifestVersion(path.join(globalRoot, "gleanery"), "package.json")
  : { status: "unknown", version: null };
const claudeText = attempt("claude", ["plugin", "list", "--json"]);
let claudeCache = null;
let claudeObserved = false;
try {
  const plugins = claudeText ? JSON.parse(claudeText) : [];
  claudeObserved = claudeText !== null;
  claudeCache =
    plugins.find((entry) => entry.id?.startsWith("gleanery@") && entry.scope === "user")?.version ?? null;
} catch {
  claudeCache = null;
}
const codexRoot = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "plugins", "cache");
const codexCaches = [];
let codexObserved = true;
let codexInvalid = false;
const markets = dirs(codexRoot);
if (markets === null) codexObserved = false;
for (const market of markets ?? []) {
  const versions = dirs(path.join(codexRoot, market.name, "gleanery"));
  if (versions === null) {
    codexObserved = false;
    continue;
  }
  for (const version of versions) {
    const cache = path.join(codexRoot, market.name, "gleanery", version.name);
    const actual = manifestVersion(cache, path.join(".codex-plugin", "plugin.json"));
    if (actual.status === "ok") codexCaches.push(actual.version);
    else if (actual.status === "unknown") codexObserved = false;
    else codexInvalid = true;
  }
}

console.log("npm package");
console.log(`  repository: ${packageVersion}`);
console.log(`  registry latest: ${tags?.latest ?? "不明"}`);
console.log(`  registry next: ${tags?.next ?? "不明"}`);
console.log(
  `  npm i -g: ${
    globalPackage.status === "ok"
      ? globalPackage.version
      : globalPackage.status === "missing"
        ? "見つからない"
        : "不明"
  }`,
);
console.log(
  `  remote tag v${tags?.latest ?? packageVersion}: ${
    remoteTags === null
      ? "不明"
      : remoteTags.includes(`refs/tags/v${tags?.latest ?? packageVersion}`)
        ? "あり"
        : "無し"
  }`,
);
console.log("plugin channel");
console.log(`  marketplace: ${marketplace ?? "不明"}`);
console.log(`  Claude manifest: ${claudeManifest}`);
console.log(`  Codex manifest: ${codexManifest}`);
console.log(`  Claude cache: ${claudeObserved ? (claudeCache ?? "見つからない") : "不明"}`);
console.log(
  `  Codex cache: ${
    codexObserved
      ? codexCaches.length
        ? codexCaches.join(", ")
        : codexInvalid
          ? "manifestが無い"
          : "見つからない"
      : "不明"
  }`,
);

const issues = [];
const unknowns = [];
if (tags && tags.latest !== packageVersion) issues.push("repositoryとnpm latestが一致しない");
if (tags && tags.next !== tags.latest) issues.push("npm nextとlatestが一致しない");
if (tags?.latest && globalPackage.status !== "unknown" && globalPackage.version !== tags.latest) {
  issues.push("npm i -gのCLIがnpm latestと一致しない");
}
if (remoteTags !== null && !remoteTags.includes(`refs/tags/v${tags?.latest ?? packageVersion}`)) {
  issues.push("npm latestに対応するremote tagが無い");
}
if (claudeManifest !== codexManifest || claudeManifest !== marketplace) {
  issues.push("plugin channelのmanifestとmarketplaceが一致しない");
}
if (marketplace && claudeObserved && claudeCache !== marketplace) {
  issues.push("Claude cacheがmarketplaceと一致しない");
}
if (marketplace && codexObserved && (codexCaches.length !== 1 || codexCaches[0] !== marketplace)) {
  issues.push("Codex cacheがmarketplaceと一致しない");
}
if (marketplace && tags?.latest && marketplace.localeCompare(tags.latest, undefined, { numeric: true }) > 0) {
  issues.push("plugin channelがnpm latestより先へ進んでいる");
}
if (tags === null) unknowns.push("npmのdist-tagを観測できない");
if (remoteTags === null) unknowns.push("remote tagを観測できない");
if (globalPackage.status === "unknown") unknowns.push("npm i -gのCLIを観測できない");
if (!claudeObserved) unknowns.push("Claude cacheを観測できない");
if (!codexObserved) unknowns.push("Codex cacheを観測できない");
if (issues.length) {
  console.log("残っていること");
  for (const issue of issues) console.log(`  ${issue}`);
}
if (unknowns.length) {
  console.log("確認できないこと");
  for (const unknown of unknowns) console.log(`  ${unknown}`);
}
if (!issues.length && !unknowns.length) {
  console.log("release台帳に食い違いは無い");
}
if (issues.length || unknowns.length) process.exitCode = 1;
