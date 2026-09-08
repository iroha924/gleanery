#!/usr/bin/env node
// MCP を触ったコミットで版が上がっているかを見る。
//
// **これは規約では守れない。**Claude Code はプラグインを
// `~/.claude/plugins/cache/mitos/mitos/<版>/` へ複製したものから動かし、
// 複製は版が変わったときだけ起きる。`bun run bundle` もセッションの張り直しも
// `claude plugin marketplace update` も効かない。
//
// AGENTS.md にそう書いた当日に、書いた本人が 8 コミット続けて踏んだ（実測）。
// **CLI は `plugin/dist/cli.js` を直接読むので普通に動いてしまい、気付けない。**

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const version = (ref) => {
  const body =
    ref === null
      ? fs.readFileSync("plugin/.claude-plugin/plugin.json", "utf8")
      : git("show", `${ref}:plugin/.claude-plugin/plugin.json`);
  return JSON.parse(body).version;
};

// HEAD が無い（最初のコミット）なら比べる先が無い。
let head;
try {
  head = git("rev-parse", "HEAD");
} catch {
  process.exit(0);
}

if (version(head) !== version(null)) process.exit(0);

console.error(
  [
    "server/src/mcp.ts を変えたのに版が上がっていない。",
    "",
    "  Claude Code は ~/.claude/plugins/cache/mitos/mitos/<版>/ の複製から動く。",
    "  複製は版が変わったときだけ起きるので、このままでは**どのセッションにも届かない**。",
    "",
    "  plugin/.claude-plugin/plugin.json と .claude-plugin/marketplace.json の version を上げて、",
    "  コミットの後に `claude plugin update mitos` を叩き、セッションを張り直す。",
  ].join("\n"),
);
process.exit(1);
