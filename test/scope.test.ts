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
  assert.equal(
    normalizeRemote("https://user:ghp_secret@github.com/iroha924/hir4ta-developer.git"),
    "github.com/iroha924/hir4ta-developer",
  );
  assert.equal(normalizeRemote("https://token@gitlab.com/team/infra.git"), "gitlab.com/team/infra");
});

test("remote が無いときは null", () => {
  assert.equal(normalizeRemote(null), null);
  assert.equal(normalizeRemote(""), null);
});

test("ネストしたグループを潰さない", () => {
  assert.equal(normalizeRemote("git@gitlab.com:org/team/repo.git"), "gitlab.com/org/team/repo");
});
