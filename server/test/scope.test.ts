import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRemote } from "../src/scope.ts";

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
