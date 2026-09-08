#!/usr/bin/env node
// バンドルが変わったコミットで版が上がっているかを見る。
//
// **理由は AGENTS.md「MCP を直したら、版を上げないと誰にも届かない」。**
// 見るのはソースではなくバンドルそのもの — `mcp.js` には search.ts も db.ts も
// 畳み込まれるので、`mcp.ts` を触ったかだけで判定すると穴が開く（実際に開いた）。

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const at = (ref, file) => {
  try {
    return git("show", `${ref}:${file}`);
  } catch {
    return null;
  }
};

try {
  git("rev-parse", "HEAD");
} catch {
  // 最初のコミット。比べる先が無い。
  process.exit(0);
}

const BUNDLE = "plugin/dist/mcp.js";
if (at("HEAD", BUNDLE) === fs.readFileSync(BUNDLE, "utf8")) process.exit(0);

const MANIFEST = "plugin/.claude-plugin/plugin.json";
const was = JSON.parse(at("HEAD", MANIFEST) ?? "{}").version;
const now = JSON.parse(fs.readFileSync(MANIFEST, "utf8")).version;
if (was !== now) process.exit(0);

console.error(
  [
    `${BUNDLE} が変わったのに版が ${now} のままになっている。`,
    "",
    "  Claude Code は ~/.claude/plugins/cache/mitos/mitos/<版>/ の複製から動く。",
    "  複製は版が変わったときだけ起きるので、このままでは**どのセッションにも届かない**。",
    "",
    "  plugin/.claude-plugin/plugin.json と .claude-plugin/marketplace.json の version を上げて、",
    "  コミットの後に `claude plugin update mitos` を叩き、セッションを張り直す。",
  ].join("\n"),
);
process.exit(1);
