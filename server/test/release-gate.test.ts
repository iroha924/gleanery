import assert from "node:assert/strict";
import { test } from "node:test";
import { gateProblems } from "../../scripts/lib/release-gate.mjs";

const COMMIT = "a".repeat(40);
const REPO = "iroha924/gleanery";
const versions = { package: "1.2.3", claude: "1.2.3", codex: "1.2.3", marketplace: "1.2.3" };
const pull = {
  state: "open",
  number: 7,
  base: { ref: "main" },
  head: { sha: COMMIT, repo: { full_name: REPO } },
};
const run = (name: string, conclusion = "success", id = 1) => ({
  id,
  name,
  event: "pull_request",
  head_sha: COMMIT,
  status: "completed",
  conclusion,
  pull_requests: [{ number: 7, base: { ref: "main" } }],
});
const ok = {
  tag: "v1.2.3",
  commit: COMMIT,
  repo: REPO,
  versions,
  mainIsAncestor: true,
  tagCommit: COMMIT,
  pulls: [pull],
  runs: [run("check"), run("pr-body")],
};

test("tag・全 version・PR・CI が揃えば通り、PR の番号を返す", () => {
  assert.deepEqual(gateProblems(ok), { problems: [], pull: 7 });
});

test("tag と version の食い違いを拒む", () => {
  assert.match(gateProblems({ ...ok, tag: "v1.2.4" }).problems.join("\n"), /tag v1\.2\.4/);
  for (const key of ["package", "claude", "codex", "marketplace"] as const)
    assert.match(
      gateProblems({ ...ok, versions: { ...versions, [key]: "1.2.2" } }).problems.join("\n"),
      new RegExp(key),
      key,
    );
  assert.match(gateProblems({ ...ok, tag: "1.2.3" }).problems.join("\n"), /v<version>/);
});

test("main を取り込んでいない commit を拒む", () => {
  assert.match(gateProblems({ ...ok, mainIsAncestor: false }).problems.join("\n"), /main/);
});

test("main へ向かう open な同じリポジトリの PR の head でなければ拒む", () => {
  for (const pulls of [
    [],
    [{ ...pull, state: "closed" }],
    [{ ...pull, base: { ref: "other" } }],
    [{ ...pull, head: { sha: COMMIT, repo: { full_name: "someone/fork" } } }],
    [{ ...pull, head: { sha: "b".repeat(40), repo: { full_name: REPO } } }],
  ])
    assert.match(gateProblems({ ...ok, pulls }).problems.join("\n"), /PR/);
  assert.match(gateProblems({ ...ok, pulls: [pull, { ...pull, number: 8 }] }).problems.join("\n"), /PR/);
});

test("その commit の check と pr-body が最後の実行で成功していなければ拒む", () => {
  assert.match(gateProblems({ ...ok, runs: [run("check")] }).problems.join("\n"), /pr-body/);
  assert.match(
    gateProblems({ ...ok, runs: [run("check", "failure"), run("pr-body")] }).problems.join("\n"),
    /check/,
  );
  assert.match(
    gateProblems({
      ...ok,
      runs: [run("check", "success", 1), run("check", "failure", 2), run("pr-body")],
    }).problems.join("\n"),
    /check/,
  );
  assert.deepEqual(
    gateProblems({ ...ok, runs: [run("check", "failure", 1), run("check", "success", 2), run("pr-body")] })
      .problems,
    [],
  );
  assert.match(
    gateProblems({
      ...ok,
      runs: [{ ...run("check"), status: "in_progress", conclusion: null }, run("pr-body")],
    }).problems.join("\n"),
    /check/,
  );
  assert.match(
    gateProblems({
      ...ok,
      runs: [{ ...run("check"), head_sha: "b".repeat(40) }, run("pr-body")],
    }).problems.join("\n"),
    /check/,
  );
  assert.match(
    gateProblems({ ...ok, runs: [{ ...run("check"), event: "push" }, run("pr-body")] }).problems.join("\n"),
    /check/,
  );
});

test("別の PR の run は数えない", () => {
  const other = (name: string) => ({
    ...run(name),
    pull_requests: [{ number: 9, base: { ref: "release" } }],
  });
  assert.match(
    gateProblems({ ...ok, runs: [other("check"), other("pr-body")] }).problems.join("\n"),
    /check/,
  );
  assert.match(
    gateProblems({ ...ok, runs: [{ ...run("check"), pull_requests: [] }, run("pr-body")] }).problems.join(
      "\n",
    ),
    /check/,
  );
});

test("remote の tag が今もその commit を指していなければ拒む", () => {
  assert.match(gateProblems({ ...ok, tagCommit: "b".repeat(40) }).problems.join("\n"), /tag/);
  assert.match(gateProblems({ ...ok, tagCommit: null }).problems.join("\n"), /tag/);
});
