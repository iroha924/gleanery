import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { candidates, identify, normalizeRemote } from "../src/scope.ts";

test("ssh と https の remote が同じ識別子へ揃う", () => {
  const want = "github.com/iroha924/hir4ta-developer";
  assert.equal(normalizeRemote("git@github.com:iroha924/hir4ta-developer.git"), want);
  assert.equal(normalizeRemote("https://github.com/iroha924/hir4ta-developer.git"), want);
  assert.equal(normalizeRemote("https://github.com/iroha924/hir4ta-developer"), want);
});

test("remote に埋まった資格情報は識別子へ持ち込まない", () => {
  // この文字列は scope.ident / scope.label として DB へ平文で入る。
  // 「最初の @ まで」で切ると、パスワードに @ があるとき断片が残る（curl も git も最後の @ が区切り）。
  const secrets = [
    "https://user:ghp_secret@github.com/o/r.git",
    "https://user:tok@en@github.com/o/r",
    "https://user:p@ss@github.com/o/r.git",
    "https://x-access-token:AKIAsecret/withslash@github.com/o/r.git",
    "https://user:pass@host:2222/o/r.git",
  ];
  for (const url of secrets) {
    const got = normalizeRemote(url) ?? "";
    for (const leak of ["ghp_secret", "AKIAsecret", "tok", "p@ss", "pass", "@"]) {
      assert.ok(!got.includes(leak), `${url} → ${got} に ${leak} が残っている`);
    }
  }
});

test("資格情報つきの remote でも、解釈できたものは正しい識別子になる", () => {
  assert.equal(normalizeRemote("https://user:ghp_secret@github.com/o/r.git"), "github.com/o/r");
  assert.equal(normalizeRemote("https://user:tok@en@github.com/o/r"), "github.com/o/r");
  assert.equal(normalizeRemote("ssh://git@github.com/o/r.git"), "github.com/o/r");
  // ポートは identity ではない。付けると同じリポジトリが 2 つの作業場所に割れる。
  assert.equal(normalizeRemote("https://user:pass@host:2222/o/r.git"), "host/o/r");
});

test("remote が無いときは null", () => {
  assert.equal(normalizeRemote(null), null);
  assert.equal(normalizeRemote(""), null);
});

test("ネストしたグループを潰さない", () => {
  assert.equal(normalizeRemote("git@gitlab.com:org/team/repo.git"), "gitlab.com/org/team/repo");
});

// **識別子と置き場所は同じ基点でなければならない。**git は親方向へ `.git` を探すので
// remote は根まで遡る。パスだけ遡らないと、リポジトリの途中で読み取り系のコマンドを
// 叩くだけで「この作業場所の置き場所」がサブディレクトリに書き換わり、
// 翌朝の同期がそこを根として読んで、根から取った節を全部墓標にする。
test("リポジトリの途中を指しても、置き場所は根を返す", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mitos-scope-"));
  try {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, "a", "b"), { recursive: true });
    execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/o/r.git"], {
      stdio: "ignore",
    });
    const root = fs.realpathSync(repo);
    for (const d of [repo, path.join(repo, "a"), path.join(repo, "a", "b")]) {
      const got = identify(d);
      assert.equal(got.ident, "git:github.com/o/r");
      assert.equal(fs.realpathSync(got.absPath), root, `${d} で根を返さなかった`);
    }
    // git 管理外は渡されたパスのまま
    assert.equal(identify(tmp).identKind, "abs-path");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// **remote が無いリポジトリの識別子はパスそのもの。**基点がずれると
// 同じリポジトリが別の作業場所として登録され、過去が 1 件も引けなくなる。
test("remote の無いリポジトリでも、識別子はどこから見ても同じ", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mitos-noremote-")));
  try {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, "a"), { recursive: true });
    execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
    const fromRoot = identify(repo);
    const fromSub = identify(path.join(repo, "a"));
    assert.equal(fromRoot.identKind, "abs-path");
    assert.equal(fromSub.ident, fromRoot.ident, "サブディレクトリから別の識別子になった");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// **走査する根が無いホストでは、束ねる候補は空になる。**
// 空を「選ぶものが無い」と読める形にしておかないと、壊れているのか区別が付かない。
test("走査する根が無ければ、束ねる候補は空", () => {
  assert.deepEqual(candidates(["/no/such/directory/for/mitos-test"]), []);
});
