// 配る tarball の中身の検査。release:prepare と CI が同じ一覧で見る（片方だけ広げると、もう片方が穴になる）。

import { execFileSync } from "node:child_process";

/** repository が追跡する配布物。tarball に全部入っていなければならない。 */
export function trackedDistribution(root) {
  return execFileSync(
    "git",
    [
      "ls-files",
      "plugin/skills",
      "plugin/hooks",
      "plugin/mcp",
      "plugin/.claude-plugin",
      "plugin/.codex-plugin",
      "plugin/LICENSE",
      "db",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .map((file) => file.replace(/^plugin\//, ""));
}

/** tarball の中の path（`package/` を外したもの）の問題。空なら通る。 */
export function tarballProblems(paths, tracked) {
  const problems = [];
  for (const required of new Set([
    "dist/cli.js",
    "dist/mcp.js",
    "dist/capture.js",
    "db/schema.sql",
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "package.json",
    "THIRD_PARTY_NOTICES.md",
    ...tracked,
  ]))
    if (!paths.has(required)) problems.push(`tarballに${required}が無い`);
  for (const file of paths)
    if (
      file.includes("node_modules/") ||
      /(^|\/)\.env(?:\.|$)/.test(file) ||
      file.endsWith("bun.lock") ||
      /(^|\/)src\/.+\.(?:ts|tsx)$/.test(file)
    )
      problems.push(`tarballへ入れてはいけないfileがある: ${file}`);
  return problems;
}
