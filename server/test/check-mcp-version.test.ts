import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "check-mcp-version.mjs",
);

function repo(): { dir: string; git: (...a: string[]) => string; done: () => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-version-")));
  const git = (...a: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-C", dir, ...a],
      { encoding: "utf8" },
    ).trim();
  git("init", "-q");
  return { dir, git, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function write(dir: string, file: string, body: string) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
}

function bump(dir: string, version: string) {
  write(dir, "plugin/package.json", JSON.stringify({ name: "gleanery", version }));
  // 版は source の中に置く（entry 直下にも置くと Claude Code が黙って plugin.json を優先する）。
  write(
    dir,
    ".claude-plugin/marketplace.json",
    JSON.stringify({
      plugins: [{ name: "gleanery", source: { source: "npm", package: "gleanery", version } }],
    }),
  );
  write(dir, "plugin/.claude-plugin/plugin.json", JSON.stringify({ version }));
  write(dir, "plugin/.codex-plugin/plugin.json", JSON.stringify({ version }));
}

function bumpPackage(dir: string, version: string) {
  write(dir, "plugin/package.json", JSON.stringify({ name: "gleanery", version }));
}

function check(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
}

// CI は checkout 直後で index が HEAD と同じなので、基準の commit と比べないと常に素通りする。
test("基準を渡すと、その後に plugin を変えて版を上げていない範囲を落とす", () => {
  const r = repo();
  try {
    bump(r.dir, "1.0.0");
    write(r.dir, "plugin/skills/a.md", "a");
    write(r.dir, "README.md", "r");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");

    write(r.dir, "plugin/skills/a.md", "b");
    r.git("commit", "-qam", "plugin だけ変える");
    const missed = check(r.dir, "--base", base);
    assert.equal(missed.status, 1, missed.stderr);
    assert.match(missed.stderr, /plugin\/skills\/a\.md/);

    bump(r.dir, "1.0.1");
    r.git("commit", "-qam", "版を上げる");
    const bumped = check(r.dir, "--base", base);
    assert.equal(bumped.status, 0, bumped.stderr);

    const head = r.git("rev-parse", "HEAD");
    write(r.dir, "README.md", "s");
    r.git("commit", "-qam", "plugin 以外だけ変える");
    const other = check(r.dir, "--base", head);
    assert.equal(other.status, 0, other.stderr);
  } finally {
    r.done();
  }
});

test("基準が無ければ、index に入った plugin の変更を HEAD の版と比べる", () => {
  const r = repo();
  try {
    bump(r.dir, "1.0.0");
    write(r.dir, "plugin/skills/a.md", "a");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");

    write(r.dir, "plugin/skills/a.md", "b");
    const unstaged = check(r.dir);
    assert.equal(unstaged.status, 0, unstaged.stderr);

    r.git("add", "-A");
    assert.equal(check(r.dir).status, 1);

    // 版上げを stage し忘れると、commit には版上げが入らない。
    bump(r.dir, "1.0.1");
    assert.equal(check(r.dir).status, 1);

    bump(r.dir, "1.0.1");
    r.git("add", "-A");
    const bumped = check(r.dir);
    assert.equal(bumped.status, 0, bumped.stderr);
  } finally {
    r.done();
  }
});

test("以前 npm だけで出していた server.ts でも、npm package のバージョンだけを上げれば止め、plugin channel と揃えれば通す", () => {
  const r = repo();
  try {
    bump(r.dir, "1.0.0");
    write(r.dir, "server/src/server.ts", "a");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");

    write(r.dir, "server/src/server.ts", "b");
    bumpPackage(r.dir, "1.0.1");
    r.git("add", "-A");
    const packageOnly = check(r.dir, "--base", base);
    assert.equal(packageOnly.status, 1, packageOnly.stderr);
    assert.match(packageOnly.stderr, /揃って上がっていない/);

    bump(r.dir, "1.0.1");
    r.git("add", "-A");
    const bumped = check(r.dir, "--base", base);
    assert.equal(bumped.status, 0, bumped.stderr);
  } finally {
    r.done();
  }
});
