#!/usr/bin/env node
// Commit message check. `node scripts/check-commit-msg.mjs <file>` for the commit-msg hook,
// `--range <base>..<head>` for CI (hooks can be skipped, so CI checks what was actually committed).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { commitMessageProblems } from "./lib/commit-msg.mjs";

const args = process.argv.slice(2);
const messages =
  args[0] === "--range"
    ? execFileSync("git", ["log", "--format=%H%x00%B%x01", args[1] ?? ""], { encoding: "utf8" })
        .split("\x01")
        .map((r) => r.replace(/^\n/, ""))
        .filter(Boolean)
        .map((r) => {
          const [sha, body = ""] = r.split("\0");
          return { name: sha?.slice(0, 7) ?? "", body };
        })
    : [{ name: "this commit", body: fs.readFileSync(args[0] ?? "", "utf8") }];

let failed = 0;
for (const m of messages) {
  const problems = commitMessageProblems(m.body);
  if (!problems.length) continue;
  failed++;
  console.error(`${m.name}: ${m.body.split("\n")[0]}`);
  for (const p of problems) console.error(`  - ${p}`);
}
if (failed) process.exit(1);
console.log(`commit messages: ${messages.length} checked`);
