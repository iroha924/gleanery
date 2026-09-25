// Plumbing for running the shipped entry points as child processes against a real database.
//
// The parent owns the timeout and termination. Tests connecting to a database, which `.claude/rules/verification.md` forbids,
// came from pools held open that never returned. With a child process, the parent can take that responsibility from outside.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

export const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");

/** Time limit for a child process. Past it, the child is killed and that counts as a check failure. */
const TIMEOUT_MS = 120_000;

/** A throwaway project. It gets a git remote so the project key is stable. */
export function makeRepo(dir, remote = "https://github.com/example/live.git", name = "repo") {
  const repo = path.join(dir, name);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("remote", "add", "origin", remote);
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  // english-exempt: Japanese document fixture committed to the temp repository
  fs.writeFileSync(path.join(repo, "docs/design.md"), "# 設計\n\n判断の理由をここに書く。\n");
  // english-exempt: Japanese document fixture committed to the temp repository
  fs.writeFileSync(path.join(repo, "README.md"), "# live\n\n検査のためのプロジェクト。\n");
  git("add", "-A");
  git("commit", "-qm", "docs");
  return repo;
}

/** Japanese text the fake gh returns, kept outside its source so each exemption covers one value. */
const GH_TEXT = {
  // english-exempt: Japanese record fixture sent through the real CLI
  reviewComment: "ここは実 DB で確かめたい",
  // english-exempt: Japanese record fixture sent through the real CLI
  issueComment: "偽の db では権限が見えない",
  // english-exempt: Japanese record fixture sent through the real CLI
  renamedTitle: "題を変えた PR",
  // english-exempt: Japanese record fixture sent through the real CLI
  prTitle: "はじめの PR",
  // english-exempt: Japanese record fixture sent through the real CLI
  body: "本文",
  // english-exempt: a Japanese decision under the English template headings, as owners often write them
  decisions: "\n\n## Decisions\n\n- Chosen: 実 DB。Rejected: 偽の db（権限が見えない）",
  // english-exempt: Japanese record fixture sent through the real CLI
  issueTitle: "はじめの issue",
};

/**
 * Installs a fake `gh`. `syncGithub` starts gh internally, so without it 14 sites are unreachable.
 * It never reaches the real GitHub. It returns fixed JSON made for the checks.
 */
export function fakeGh(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const gh = path.join(bin, "gh");
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env node
// A fake for the checks. It never goes out. gh gets --slurp, so return an array of pages.
// Check comments first. \`pulls/comments\` also matches \`/pulls\`, so in the other order a PR would come back
// instead of review comments, and it would fail without pull_request_url.
const T = ${JSON.stringify(GH_TEXT)};
const args = process.argv.slice(2).join(" ");
const out = (v) => process.stdout.write(JSON.stringify([v]));
// The second round returns fewer messages and issues. The branches that delete removed ones only run when counts drop.
const round2 = process.env.SPHICA_FAKE_GH_ROUND === "2";
// Mix terminal control sequences into fields third parties can write (to check that output drops them)
const evil = process.env.SPHICA_FAKE_GH_ROUND === "hostile" ? "\\u001b[2J\\u001b]0;pwn\\u0007\\r" : "";
const person = { id: 1, login: \`someone\${evil}\` };
if (args.includes("pulls/comments")) {
  if (round2) { out([]); process.exit(0); }
  out([{ id: 11, pull_request_url: "https://api.github.com/repos/example/live/pulls/1", user: person,
         body: T.reviewComment, created_at: "2026-09-02T00:00:00Z",
         html_url: "https://example.invalid/1#r11", path: "docs/design.md", line: 3 }]);
} else if (args.includes("issues/comments")) {
  if (round2) { out([]); process.exit(0); }
  out([{ id: 12, issue_url: "https://api.github.com/repos/example/live/issues/2", user: person,
         body: T.issueComment, created_at: "2026-09-03T00:00:00Z",
         html_url: "https://example.invalid/2#c12" }]);
} else if (args.includes("pulls?")) {
  // The second round changes only the title. A title is not message content, so messages are not rewritten.
  out([{ number: 1, title: round2 ? T.renamedTitle : \`\${T.prTitle}\${evil}\`, body: \`\${T.body}\${evil}\${T.decisions}\`, state: evil ? "closed" : "open", user: person,
         created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z",
         html_url: "https://example.invalid/1", merged_at: evil ? "2026-09-02T01:00:00Z" : null, closed_at: evil ? "2026-09-02T01:00:00Z" : null }]);
} else if (args.includes("issues?")) {
  if (round2) { out([]); process.exit(0); }
  out([{ number: 2, title: T.issueTitle, body: T.body, state: "closed", user: person,
         created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-03T00:00:00Z",
         html_url: "https://example.invalid/2", closed_at: "2026-09-03T00:00:00Z" }]);
} else {
  out([]);
}
`,
    { mode: 0o755 },
  );
  return bin;
}

/**
 * The child process environment. The database is ~/.sphica/sphica.db in the temp HOME (created by `sphica init`).
 * No GitHub key is passed (only the fake gh is used).
 */
function childEnv(dir, covDir, extra = {}) {
  const env = { ...process.env, ...extra };
  // **Swap home.** Otherwise the child uses the owner's ~/.sphica.
  // `capture flush` reads the queue in ~/.sphica/spool and deletes what it sent (measured: it sent the owner's
  // 4 unsent items to the throwaway database and removed them from the spool). Changing only the database path does not close this.
  env.HOME = dir;
  env.USERPROFILE = dir;
  // If the parent's SPHICA_DB remained, the child would open that database instead of the temp HOME one.
  for (const k of ["SPHICA_DB", "GITHUB_TOKEN"]) delete env[k];
  // Host sessions leak in from the parent. With both present the CLI stops because it cannot tell which host it is,
  // so keep only what the check passes.
  for (const k of ["CODEX_THREAD_ID", "CODEX_SESSION_ID"]) delete env[k];
  if (!("CLAUDE_CODE_SESSION_ID" in extra)) delete env.CLAUDE_CODE_SESSION_ID;
  // Capture decides whether a turn is the owner's from the parent session. A leftover parent value would conflict with the
  // session the check passes, and nothing would be queued (measured: the hook exited 0 with an empty spool).
  if (!("SPHICA_PARENT_SESSION" in extra)) delete env.SPHICA_PARENT_SESSION;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return {
    ...env,
    NODE_V8_COVERAGE: covDir,
    PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
  };
}

/** Runs the CLI once. Failures do not stop it (the goal is reach, and callers judge success). */
export function runCli(args, dir, covDir, { cwd = root, ...extra } = {}) {
  const r = spawnSync("node", [path.join(root, "server/src/cli.ts"), ...args], {
    cwd,
    env: childEnv(dir, covDir, extra),
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, timedOut: r.signal === "SIGTERM" };
}

/**
 * Runs the capture hook once. The spool lives under home, so this relies on childEnv
 * swapping home (so the owner's queue is never read).
 */
export function runHook(input, dir, covDir, extra = {}) {
  const r = spawnSync("node", [path.join(root, "server/src/capture.ts")], {
    cwd: extra.cwd ?? root,
    env: childEnv(dir, covDir, extra),
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Creates a temp directory and deletes it afterwards. */
export async function withTempDir(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-live-")));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
