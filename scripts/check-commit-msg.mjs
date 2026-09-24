#!/usr/bin/env node
// Commit message check. `node scripts/check-commit-msg.mjs <file>` for the commit-msg hook,
// `--range <base>..<head>` for CI (hooks can be skipped, so CI checks what was actually committed),
// `--pre-push` with Git's pre-push lines on stdin (checks the stored messages of the refs being pushed).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { commitMessageProblems } from "./lib/commit-msg.mjs";

const args = process.argv.slice(2);

/** Stored messages of the commits `git log <revs>` lists. */
function stored(revs) {
  return execFileSync("git", ["log", "--format=%H%x00%P%x00%B%x01", ...revs], { encoding: "utf8" })
    .split("\x01")
    .map((r) => r.replace(/^\n/, ""))
    .filter(Boolean)
    .map((r) => {
      const [sha = "", parents = "", body = ""] = r.split("\0");
      return { name: sha.slice(0, 7), body, merge: parents.split(" ").length > 1 };
    });
}

/** Commits each pushed ref adds: from the remote's old tip, or, for a new ref, those on no remote-tracking ref. */
function pushed(stdin) {
  const seen = new Map();
  for (const line of stdin.split("\n")) {
    const [, local, , remote] = line.trim().split(/\s+/);
    if (!local || /^0+$/.test(local)) continue; // a deletion pushes no commits
    let known = remote !== undefined && !/^0+$/.test(remote);
    if (known) {
      try {
        execFileSync("git", ["cat-file", "-e", `${remote}^{commit}`], { stdio: "ignore" });
      } catch {
        known = false; // the remote moved to a commit not fetched here
      }
    }
    for (const m of stored(known ? [`${remote}..${local}`] : [local, "--not", "--remotes"]))
      seen.set(m.name, m);
  }
  return [...seen.values()];
}

const messages =
  args[0] === "--range"
    ? stored([args[1] ?? ""])
    : args[0] === "--pre-push"
      ? pushed(fs.readFileSync(0, "utf8"))
      : [
          {
            name: "this commit",
            body: fs.readFileSync(args[0] ?? "", "utf8"),
            merge: mergeInProgress(),
            hook: true,
          },
        ];

/** Git's comment character for templates (core.commentChar), `#` when unset or `auto`. */
function commentChar() {
  try {
    const c = execFileSync("git", ["config", "core.commentChar"], { encoding: "utf8" }).trim();
    return c && c !== "auto" ? c : "#";
  } catch {
    return "#";
  }
}

/** Git's commit.cleanup, `default` when unset. */
function cleanupMode() {
  try {
    return execFileSync("git", ["config", "commit.cleanup"], { encoding: "utf8" }).trim() || "default";
  } catch {
    return "default";
  }
}

/** `git merge` leaves MERGE_HEAD while it waits for the message. */
function mergeInProgress() {
  try {
    const dir = execFileSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8" }).trim();
    return fs.existsSync(path.join(dir, "MERGE_HEAD"));
  } catch {
    return false;
  }
}

let failed = 0;
for (const m of messages) {
  const problems = commitMessageProblems(m.body, {
    merge: m.merge,
    hook: m.hook === true,
    commentChar: commentChar(),
    cleanup: cleanupMode(),
  });
  if (!problems.length) continue;
  failed++;
  console.error(`${m.name}: ${m.body.split("\n")[0]}`);
  for (const p of problems) console.error(`  - ${p}`);
}
if (failed) process.exit(1);
console.log(`commit messages: ${messages.length} checked`);
