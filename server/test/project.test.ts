import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { identify, localRoots, nameLocal, normalizeRemote, patchPaths, relativeTo } from "../src/project.ts";

// HOME を差し替えて本物の名前の対応表を守っている。bun の os.homedir() は差し替えに追従せず、本物の対応表を書き換える。
if (process.versions.bun) throw new Error("このテストは node --test で走らせる（bun run test）");

test("ssh と https の remote が同じ key へ揃う", () => {
  const want = "github.com/iroha924/hir4ta-developer";
  assert.equal(normalizeRemote("git@github.com:iroha924/hir4ta-developer.git"), want);
  assert.equal(normalizeRemote("https://github.com/iroha924/hir4ta-developer.git"), want);
  assert.equal(normalizeRemote("https://github.com/iroha924/hir4ta-developer"), want);
  assert.equal(normalizeRemote("ssh://git@github.com/iroha924/hir4ta-developer.git"), want);
});

// key は DB へ平文で入る。「最初の @ まで」で切ると、パスワードに @ があるとき断片が残る。
test("remote に埋まった資格情報は key へ持ち込まない", () => {
  for (const url of [
    "https://user:ghp_secret@github.com/o/r.git",
    "https://user:tok@en@github.com/o/r",
    "https://user:p@ss@github.com/o/r.git",
    "https://x-access-token:AKIAsecret/withslash@github.com/o/r.git",
    "https://user:pass@host:2222/o/r.git",
  ]) {
    const got = normalizeRemote(url) ?? "";
    for (const leak of ["ghp_secret", "AKIAsecret", "tok", "p@ss", "pass", "@"]) {
      assert.ok(!got.includes(leak), `${url} → ${got} に ${leak} が残っている`);
    }
  }
  // ポートは識別子ではない。付けると同じリポジトリが 2 つの作業場所に割れる。
  assert.equal(normalizeRemote("https://user:pass@host:2222/o/r.git"), "host/o/r");
  assert.equal(normalizeRemote("git@gitlab.com:org/team/repo.git"), "gitlab.com/org/team/repo");
  assert.equal(normalizeRemote(""), null);
});

function repo(remote: string | null): { dir: string; done: () => void } {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mitos-project-")));
  const dir = path.join(tmp, "repo");
  fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  if (remote) execFileSync("git", ["-C", dir, "remote", "add", "origin", remote], { stdio: "ignore" });
  return { dir, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

// 相対パスの基点がサブディレクトリにずれると、同じファイルが別の path として記録される。
test("リポジトリの途中から見ても、根と key は同じ", () => {
  const r = repo("https://github.com/o/r.git");
  try {
    for (const d of [r.dir, path.join(r.dir, "a"), path.join(r.dir, "a", "b")]) {
      const got = identify(d);
      assert.equal(got?.key, "git:github.com/o/r");
      assert.equal(got?.root, r.dir, d);
      assert.equal(got?.name, "o/r");
    }
  } finally {
    r.done();
  }
});

// remote も名前も無い場所の会話を、どこかの作業場所へ推測で入れない。
test("remote も名前も無い場所は作業場所にならない", () => {
  const r = repo(null);
  try {
    assert.equal(identify(r.dir), null);
    assert.equal(identify(os.tmpdir()), null);
  } finally {
    r.done();
  }
});

test("相対パスは根からの形にし、根の外は null", () => {
  assert.equal(relativeTo("/w/repo", "/w/repo/server/src/db.ts"), "server/src/db.ts");
  assert.equal(relativeTo("/w/repo", "src/db.ts", "/w/repo/server"), "server/src/db.ts");
  assert.equal(relativeTo("/w/repo", "/w/other/x.ts"), null);
  assert.equal(relativeTo("/w/repo", "../x.ts"), null);
  assert.equal(relativeTo("/w/repo", "/w/repo"), null);
  // `..` で始まる名前は根の中にある。
  assert.equal(relativeTo("/w/repo", "/w/repo/..config/a.ts"), "..config/a.ts");
  assert.equal(relativeTo("/w/repo", "/w/repo/..."), "...");
});

// 空とみなして書き戻すと、ほかの作業場所の名前が全部消える。
test("名前の対応表が壊れていたら読み飛ばさずに止め、remote のある場所には名前を付けない", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mitos-map-")));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  const r = repo(null);
  try {
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude", "mitos-projects.json"), '{"/x": "a",');
    assert.throws(() => nameLocal(r.dir, "notes"), /JSON の対応表として読めない/);
    assert.throws(() => identify(r.dir), /JSON の対応表として読めない/);
    fs.rmSync(path.join(home, ".claude", "mitos-projects.json"));
    const remote = repo("git@github.com:o/r.git");
    try {
      assert.throws(() => nameLocal(remote.dir, "notes"), /git remote を持つ/);
    } finally {
      remote.done();
    }
    assert.equal(nameLocal(r.dir, "notes").key, "local:notes");
  } finally {
    r.done();
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// 同じ remote のクローンが 2 つあると、並び順で先に来た方へ黙って同期してしまう。
test("同じ key の置き場所が 2 つあれば選ばない", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mitos-roots-")));
  // この PC の名前の対応表を読ませない（名前を付けた作業場所が found に混ざる）。
  const realHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    for (const n of ["one", "two"]) {
      const d = path.join(tmp, n);
      execFileSync("git", ["init", "-q", d], { stdio: "ignore" });
      execFileSync("git", ["-C", d, "remote", "add", "origin", "git@github.com:o/same.git"], {
        stdio: "ignore",
      });
    }
    const solo = path.join(tmp, "solo");
    execFileSync("git", ["init", "-q", solo], { stdio: "ignore" });
    execFileSync("git", ["-C", solo, "remote", "add", "origin", "git@github.com:o/solo.git"], {
      stdio: "ignore",
    });
    const { found, ambiguous } = localRoots([tmp]);
    assert.equal(found.get("git:github.com/o/solo"), solo);
    assert.equal(found.has("git:github.com/o/same"), false);
    assert.deepEqual(ambiguous.get("git:github.com/o/same")?.sort(), [
      path.join(tmp, "one"),
      path.join(tmp, "two"),
    ]);
    assert.deepEqual([...localRoots(["/no/such/dir"]).found], []);
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// patch の本文（ファイルの中身）から path を拾うと、書いた文字列次第で好きな path を名乗れる。
test("Codex の patch は見出しの 4 形だけから編集先を読む", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: server/src/db.ts",
    "@@",
    "-*** Update File: not/a/header.ts",
    "+x",
    "*** Add File: docs/new.md",
    "+*** Delete File: also/not.ts",
    "*** Delete File: old.ts",
    "*** Update File: a.ts",
    "*** Move to: b.ts",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(patchPaths(patch), ["server/src/db.ts", "docs/new.md", "old.ts", "a.ts", "b.ts"]);
});
