import assert from "node:assert/strict";
import { test } from "node:test";
import { commitMessageProblems } from "../../scripts/lib/commit-msg.mjs";

const ok = (m: string) => assert.deepEqual(commitMessageProblems(m), [], m);
const bad = (m: string, re: RegExp) => assert.match(commitMessageProblems(m).join("\n"), re, m);

test("accepts one Conventional Commits line in English", () => {
  ok("feat: add a check\n");
  ok("fix(tui)!: keep the selected row visible");
  ok(
    "docs: note the release steps\n\n# Please enter the commit message\n# Lines starting with '#' are ignored\n",
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

test("lets Git's own merge and revert messages through, but not with Japanese", () => {
  ok("Merge pull request #145 from iroha924/biome-config\n\nbuild: lint every tracked source");
  ok('Revert "feat: add a check"\n\nThis reverts commit 0123456789abcdef.');
  bad("Merge pull request #1 from x/y\n\n検査を足す", /English/);
  bad("Mergeable: not generated", /start with <type>/);
});
