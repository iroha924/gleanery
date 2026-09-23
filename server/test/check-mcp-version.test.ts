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
  // バージョンは source の中に置く（entry 直下にも置くと Claude Code が黙って plugin.json を優先する）。
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
test("基準を渡すと、その後に plugin を変えてバージョンを上げていない範囲を落とす", () => {
  const r = repo();
  try {
    bump(r.dir, "1.0.0");
    write(r.dir, "plugin/skills/a.md", "a");
    write(r.dir, "README.ja.md", "r");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");

    write(r.dir, "plugin/skills/a.md", "b");
    r.git("commit", "-qam", "plugin だけ変える");
    const missed = check(r.dir, "--base", base);
    assert.equal(missed.status, 1, missed.stderr);
    assert.match(missed.stderr, /plugin\/skills\/a\.md/);

    bump(r.dir, "1.0.1");
    r.git("commit", "-qam", "バージョンを上げる");
    const bumped = check(r.dir, "--base", base);
    assert.equal(bumped.status, 0, bumped.stderr);

    const head = r.git("rev-parse", "HEAD");
    write(r.dir, "README.ja.md", "s");
    r.git("commit", "-qam", "plugin 以外だけ変える");
    const other = check(r.dir, "--base", head);
    assert.equal(other.status, 0, other.stderr);
  } finally {
    r.done();
  }
});

test("基準が無ければ、index に入った plugin の変更を HEAD のバージョンと比べる", () => {
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

    // バージョン上げを stage し忘れると、commit にはバージョン上げが入らない。
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

test("marketplace の取得元だけを変えてバージョンを上げていない commit を落とす", () => {
  const r = repo();
  try {
    bump(r.dir, "1.0.0");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");
    write(
      r.dir,
      ".claude-plugin/marketplace.json",
      JSON.stringify({
        plugins: [
          { name: "gleanery", source: { source: "npm", package: "gleanery-fork", version: "1.0.0" } },
        ],
      }),
    );
    r.git("commit", "-qam", "取得元だけを変える");
    const missed = check(r.dir, "--base", base);
    assert.equal(missed.status, 1, missed.stderr);
    assert.match(missed.stderr, /marketplace\.json/);
  } finally {
    r.done();
  }
});

test("バージョンを下げる commit を、配布物が変わっていなくても落とす", () => {
  const r = repo();
  try {
    bump(r.dir, "1.2.0");
    write(r.dir, "plugin/skills/a.md", "a");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");

    bump(r.dir, "1.1.9");
    r.git("commit", "-qam", "バージョンだけを下げる");
    const down = check(r.dir, "--base", base);
    assert.equal(down.status, 1, down.stderr);
    assert.match(down.stderr, /下げ/);

    write(r.dir, "plugin/skills/a.md", "b");
    r.git("commit", "-qam", "配布物も変える");
    const changed = check(r.dir, "--base", base);
    assert.equal(changed.status, 1, changed.stderr);

    // 数で比べる（文字列では 1.10.0 < 1.9.0 になる）
    bump(r.dir, "1.10.0");
    r.git("commit", "-qam", "上げる");
    const up = check(r.dir, "--base", base);
    assert.equal(up.status, 0, up.stderr);
  } finally {
    r.done();
  }
});

test("4 箇所のバージョンだけを揃えて上げた commit は、配布物の変更に数えず通す", () => {
  const r = repo();
  try {
    bump(r.dir, "1.0.0");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");
    bump(r.dir, "1.0.1");
    r.git("commit", "-qam", "バージョンだけ");
    const only = check(r.dir, "--base", base);
    assert.equal(only.status, 0, only.stderr);
  } finally {
    r.done();
  }
});

test("基準が無ければ、作業ブランチでは main から分かれた点と比べる（ブランチの中で 1 回上げれば、後の commit を積める）", () => {
  const r = repo();
  try {
    bump(r.dir, "1.0.0");
    write(r.dir, "plugin/skills/a.md", "a");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    r.git("branch", "-M", "main");
    r.git("update-ref", "refs/remotes/origin/main", "HEAD");

    r.git("switch", "-q", "-c", "feature");
    write(r.dir, "plugin/skills/a.md", "b");
    bump(r.dir, "1.0.1");
    r.git("add", "-A");
    r.git("commit", "-qm", "変えて上げる");

    write(r.dir, "plugin/skills/a.md", "c");
    r.git("add", "-A");
    const next = check(r.dir);
    assert.equal(next.status, 0, next.stderr);

    // 分かれた後に main が同じバージョンを出していたら、それを超えるまで落とす（CI は今の main と比べる）
    r.git("reset", "-q", "--hard");
    r.git("switch", "-q", "main");
    bump(r.dir, "1.0.1");
    write(r.dir, "plugin/skills/b.md", "main");
    r.git("add", "-A");
    r.git("commit", "-qm", "main が同じ番号を出す");
    r.git("switch", "-q", "feature");
    write(r.dir, "plugin/skills/a.md", "c2");
    r.git("add", "-A");
    assert.equal(check(r.dir).status, 1);
    r.git("reset", "-q", "--hard");

    // ブランチの中での下げは、分かれた点より大きくても落とす
    bump(r.dir, "1.0.2");
    r.git("add", "-A");
    r.git("commit", "-qm", "もう一度上げる");
    bump(r.dir, "1.0.1");
    r.git("add", "-A");
    assert.equal(check(r.dir).status, 1);

    // ブランチの中で一度も上げていなければ落とす
    r.git("reset", "-q", "--hard");
    r.git("switch", "-q", "-c", "other", "main");
    write(r.dir, "plugin/skills/a.md", "d");
    r.git("add", "-A");
    assert.equal(check(r.dir).status, 1);

    // main の上では、これまでどおり HEAD と比べる
    r.git("reset", "-q", "--hard");
    r.git("switch", "-q", "main");
    write(r.dir, "plugin/skills/a.md", "e");
    r.git("add", "-A");
    assert.equal(check(r.dir).status, 1);
  } finally {
    r.done();
  }
});
