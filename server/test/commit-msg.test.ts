import assert from "node:assert/strict";
import { test } from "node:test";
import { commitMessageProblems } from "../../scripts/lib/commit-msg.mjs";

const ok = (m: string, merge = false) => assert.deepEqual(commitMessageProblems(m, { merge }), [], m);
const bad = (m: string, re: RegExp, merge = false) =>
  assert.match(commitMessageProblems(m, { merge }).join("\n"), re, m);
const SHA = "0123456789abcdef0123456789abcdef01234567";

test("accepts one Conventional Commits line in English", () => {
  ok("feat: add a check\n");
  ok("fix(tui)!: keep the selected row visible");
  ok(
    "docs: note the release steps\n\n# Please enter the commit message\n# Lines starting with '#' are ignored\n",
  );
});

test("drops the verbose diff below Git's scissors line", () => {
  ok(
    "feat: add one\n\n# Please enter the commit message\n# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\ndiff --git a/x b/x\n+added line\n",
  );
});

test("rejects bodies, other shapes, Japanese, and long subjects", () => {
  bad("feat: add a check\n\nMore detail", /one-line subject/);
  bad("feat: add a check\n# second line", /one-line subject/);
  bad("Add a check", /start with <type>/);
  bad("feature: add a check", /start with <type>/);
  bad("feat(TUI): add a check", /start with <type>/);
  bad("feat: 検査を足す", /English/);
  bad(`feat: ${"x".repeat(100)}`, /within 100 characters/);
});

test("lets through only the exact shapes Git writes for merges and reverts", () => {
  ok("Merge pull request #145 from iroha924/biome-config\n\nbuild: lint every tracked source", true);
  ok(`Revert "feat: add a check"\n\nThis reverts commit ${SHA}.`);
  bad("Merge pull request #145 from iroha924/biome-config\n\nmore", /one-line subject/);
  bad('Revert "not generated"\n\nAn arbitrary body', /one-line subject/);
  bad("Merge pull request #1 from x/y\n\n検査を足す", /English/, true);
});
