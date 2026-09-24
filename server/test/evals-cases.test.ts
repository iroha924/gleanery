import assert from "node:assert/strict";
import { test } from "node:test";
import { splitStale } from "../evals/cases.ts";

test("questions whose answer is not in the DB are split off instead of scored as misses", () => {
  const known = new Set(["doc:a.md#setup", "claude-code:s#k", "133dcea3-e023-875b-98bb-fc047531b916"]);
  const cases = [
    { q: "section", expect: ["doc:a.md#setup"] },
    { q: "record", expect: ["claude-code:s#k"] },
    { q: "message", expect: ["133dcea3-e023-875b-98bb-fc047531b916"] },
    { q: "heading renamed", expect: ["doc:a.md#old-heading"] },
    { q: "record removed", expect: ["claude-code:s#other"] },
  ];
  const { live, stale } = splitStale(cases, known);
  assert.deepEqual(
    live.map((c) => c.q),
    ["section", "record", "message"],
  );
  assert.deepEqual(
    stale.map((c) => c.q),
    ["heading renamed", "record removed"],
  );
});
