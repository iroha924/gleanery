import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tarballProblems, trackedDistribution } from "../../scripts/lib/tarball.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tracked = trackedDistribution(root);
const complete = new Set([
  "dist/cli.js",
  "dist/mcp.js",
  "dist/capture.js",
  "db/schema.sql",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "package.json",
  "THIRD_PARTY_NOTICES.md",
  ...tracked,
]);

test("配る物が揃っていれば通り、追跡している manifest・Skill・hook の欠けを見つける", () => {
  assert.deepEqual(tarballProblems(complete, tracked), []);
  for (const must of [".codex-plugin/plugin.json", "hooks/hooks.json", "skills/trace/SKILL.md"]) {
    assert.ok(tracked.includes(must) || must.startsWith(".codex"), `${must} は追跡している配布物`);
    const missing = new Set([...complete].filter((f) => f !== must));
    assert.match(
      tarballProblems(missing, tracked).join("\n"),
      new RegExp(`${must.replace(/\./g, "\\.")}が無い`),
    );
  }
});

test("入れてはいけないファイルを見つける", () => {
  for (const bad of ["node_modules/x/index.js", ".env", "server/bun.lock", "src/cli.ts"])
    assert.match(tarballProblems(new Set([...complete, bad]), tracked).join("\n"), /入れてはいけない/, bad);
});
