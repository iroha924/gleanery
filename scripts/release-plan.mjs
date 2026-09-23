#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { isPackageInput, releaseKind, withoutReleaseVersion } from "./lib/release-scope.mjs";

const root = path.resolve(import.meta.dirname, "..");
const { base, json } = parseArgs({
  options: { base: { type: "string" }, json: { type: "boolean", default: false } },
}).values;
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

function defaultBase() {
  try {
    return git("describe", "--tags", "--abbrev=0");
  } catch {
    try {
      return git("rev-parse", "HEAD^");
    } catch {
      return git("rev-parse", "HEAD");
    }
  }
}

const ref = base ?? defaultBase();
const versionFiles = new Set([
  "plugin/package.json",
  "plugin/.claude-plugin/plugin.json",
  "plugin/.codex-plugin/plugin.json",
]);
const at = (revision, file) => {
  try {
    return git("show", `${revision}:${file}`);
  } catch {
    return null;
  }
};
const files = git("diff", "--name-only", ref, "--cached")
  .split("\n")
  .filter(Boolean)
  .filter(isPackageInput)
  .filter(
    (file) =>
      !versionFiles.has(file) || withoutReleaseVersion(at(ref, file)) !== withoutReleaseVersion(at("", file)),
  );
const kind = releaseKind(files);
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const packageVersion = read("plugin/package.json").version;
const claudeVersion = read("plugin/.claude-plugin/plugin.json").version;
const codexVersion = read("plugin/.codex-plugin/plugin.json").version;
const marketplaceVersion = read(".claude-plugin/marketplace.json").plugins.find(
  (entry) => entry.name === "gleanery",
)?.source?.version;
const actions =
  kind === "none"
    ? []
    : [
        "PRのCI（check・pr-body）とCodexのレビューを通し、branchにmainを取り込む",
        `git tag v${packageVersion} <PR head> && git push origin v${packageVersion}`,
        "release.ymlのprepareを見て、environment npm-releaseを承認する",
        "npm stage download <stage-id> のSHA-512をjob summaryと照合し、provenanceを見て2FAで承認",
        "gh pr merge <PR> --merge --match-head-commit <PR head>",
        "git diff --exit-code <PR head> <merge commit>",
        `npm pack gleanery@${packageVersion} --silent のSHA-512を照合`,
        `npm dist-tag add gleanery@${packageVersion} latest`,
        "bun run release:status",
        "Claude/Codexのplugin cacheを更新してsessionを張り直す",
      ];
const plan = {
  base: ref,
  commit: git("rev-parse", "HEAD"),
  kind,
  files,
  versions: {
    package: packageVersion,
    claude: claudeVersion,
    codex: codexVersion,
    marketplace: marketplaceVersion,
  },
  actions,
};

if (json) {
  process.stdout.write(`${JSON.stringify(plan)}\n`);
} else {
  const label = { none: "releaseなし", plugin: "plugin" }[kind];
  console.log(`release種別: ${label}`);
  console.log(`比較: ${ref}..${plan.commit}`);
  console.log(
    `version: npm ${packageVersion} / plugin ${claudeVersion} / marketplace ${marketplaceVersion} / Codex ${codexVersion}`,
  );
  if (files.length) console.log(`入力: ${files.join(", ")}`);
  for (const action of actions) console.log(`  ${action}`);
}
