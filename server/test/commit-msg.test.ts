import assert from "node:assert/strict";
import { test } from "node:test";
import { commitMessageProblems } from "../../scripts/lib/commit-msg.mjs";

type Opts = { merge?: boolean; hook?: boolean; commentChar?: string };
const ok = (m: string, opts: Opts = {}) => assert.deepEqual(commitMessageProblems(m, opts), [], m);
const bad = (m: string, re: RegExp, opts: Opts = {}) =>
  assert.match(commitMessageProblems(m, opts).join("\n"), re, m);
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SCISSORS = "------------------------ >8 ------------------------";

test("accepts one Conventional Commits line in English", () => {
  ok("feat: add a check\n");
  ok("fix(tui)!: keep the selected row visible");
});

test("in the hook, ignores the editor template and the verbose diff, with the configured comment character", () => {
  const hook = { hook: true };
  ok(
    "docs: note the release steps\n\n# Please enter the commit message\n# Lines starting with '#' are ignored\n",
    hook,
  );
  ok(
    `feat: add one\n\n# Please enter the commit message\n# ${SCISSORS}\n# Do not modify.\ndiff --git a/x b/x\n+added\n`,
    hook,
  );
  ok(`feat: add one\n\n; Please enter the commit message\n; ${SCISSORS}\ndiff --git a/x b/x\n`, {
    hook: true,
    commentChar: ";",
  });
  bad("feat: add a check\n# second line", /one-line subject/, hook);
});

test("checks stored messages as they are, scissors and comment lines included", () => {
  bad(`feat: valid subject\n\n# ${SCISSORS}\n\n日本語 body`, /English/);
  bad("docs: note\n\n# kept by git commit -m", /one-line subject/);
});

test("rejects bodies, other shapes, Japanese, and long subjects", () => {
  bad("feat: add a check\n\nMore detail", /one-line subject/);
  bad("Add a check", /start with <type>/);
  bad("feature: add a check", /start with <type>/);
  bad("feat(TUI): add a check", /start with <type>/);
  bad("feat: 検査を足す", /English/);
  bad(`feat: ${"x".repeat(100)}`, /within 100 characters/);
});

test("lets through only the exact shapes Git writes for merges and reverts", () => {
  ok("Merge pull request #145 from iroha924/biome-config\n\nbuild: lint every tracked source", {
    merge: true,
  });
  ok("Merge branches 'one' and 'two'", { merge: true });
  ok(`Revert "feat: add a check"\n\nThis reverts commit ${SHA}.`);
  bad("Merge pull request #145 from iroha924/biome-config\n\nmore", /one-line subject/);
  bad('Revert "not generated"\n\nAn arbitrary body', /one-line subject/);
  bad("Merge pull request #1 from x/y\n\n検査を足す", /English/, { merge: true });
});
