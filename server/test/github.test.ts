import assert from "node:assert/strict";
import { test } from "node:test";
import { type Get, isFiller, LIMITS, parts, readPull, repoOf } from "../src/github.ts";

const pull = {
  id: 9001,
  number: 12,
  title: "Keep one SQLite file",
  body: "We drop Postgres.",
  html_url: "https://github.com/o/r/pull/12",
  state: "closed",
  merged_at: "2026-09-12T00:00:00Z",
  created_at: "2026-09-10T00:00:00Z",
  user: { login: "owner" },
  commits: 2,
  changed_files: 3,
};

/** A fake GitHub: each path returns its fixture; list paths return arrays. */
function fake(over: Record<string, unknown> = {}): { get: Get; paths: string[] } {
  const paths: string[] = [];
  const data: Record<string, unknown> = {
    "pulls/12": pull,
    "issues/12/comments": [
      { id: 1, body: "LGTM", user: { login: "a" }, created_at: "2026-09-10T02:00:00Z", html_url: "u1" },
      {
        id: 2,
        body: "Why not Postgres?",
        user: { login: "a" },
        created_at: "2026-09-10T01:00:00Z",
        html_url: "u2",
      },
    ],
    "pulls/12/reviews": [
      {
        id: 3,
        body: "",
        user: { login: "b" },
        state: "CHANGES_REQUESTED",
        submitted_at: "2026-09-10T03:00:00Z",
        html_url: "u3",
      },
    ],
    "pulls/12/comments": [
      {
        id: 4,
        body: "This path breaks on Windows",
        user: { login: "b" },
        created_at: "2026-09-10T03:00:01Z",
        html_url: "u4",
        path: "src/db.ts",
        line: 7,
      },
    ],
    "pulls/12/commits": [
      {
        sha: "abcdef0123456789",
        commit: { message: "fix: use path.join", author: { date: "2026-09-10T04:00:00Z" } },
      },
    ],
    "issues/12/timeline": [
      {
        event: "cross-referenced",
        created_at: "2026-09-10T05:00:00Z",
        source: { issue: { number: 3, title: "Windows paths" } },
      },
      { event: "labeled", created_at: "2026-09-10T05:00:01Z" },
    ],
    ...over,
  };
  return {
    paths,
    get: async (path) => {
      paths.push(path);
      const key = path.split("?")[0] ?? path;
      if (!(key in data)) throw new Error(`unexpected ${path}`);
      return data[key];
    },
  };
}

test("reads the pull request whole, in time order, without filler", async () => {
  const f = fake();
  const { pr, text } = await readPull("o/r", 12, f.get);
  assert.deepEqual(pr, {
    number: 12,
    githubId: 9001,
    title: "Keep one SQLite file",
    url: pull.html_url,
    state: "merged",
  });
  assert.match(text, /^# #12: Keep one SQLite file/);
  assert.match(text, /We drop Postgres\./);
  assert.doesNotMatch(text, /LGTM/);
  const order = [
    "Why not Postgres?",
    "CHANGES_REQUESTED",
    "src/db.ts:7",
    "fix: use path.join",
    "issue #3 (Windows paths)",
  ];
  const at = order.map((s) => text.indexOf(s));
  assert.ok(
    at.every((x) => x > 0),
    text,
  );
  assert.deepEqual(
    [...at].sort((a, b) => a - b),
    at,
    text,
  );
  assert.doesNotMatch(text, /labeled/);
  // Every list is read in full (all pages)
  assert.ok(f.paths.filter((p) => p !== "pulls/12").every((p) => p.includes("per_page=100")));
});

// GitHub lists stop at these sizes, so a larger pull request would be harvested from part of it
test("refuses a pull request it cannot read whole", async () => {
  const f = fake({ "pulls/12": { ...pull, commits: LIMITS.commits + 1 } });
  await assert.rejects(readPull("o/r", 12, f.get), /cannot be read whole/);
  assert.deepEqual(f.paths, ["pulls/12"], "stops before reading the lists");
  // The file list is never read, so a pull request changing many files is read as usual
  assert.match(
    (await readPull("o/r", 12, fake({ "pulls/12": { ...pull, changed_files: 5000 } }).get)).text,
    /We drop Postgres/,
  );
  const huge = fake({ "pulls/12": { ...pull, body: "x".repeat(LIMITS.bytes) } });
  await assert.rejects(readPull("o/r", 12, huge.get), /cannot be read whole/);
});

test("reports an open pull request and one closed without merging", async () => {
  const state = async (over: object) =>
    (await readPull("o/r", 12, fake({ "pulls/12": { ...pull, ...over } }).get)).pr.state;
  assert.equal(await state({ merged_at: null }), "closed");
  assert.equal(await state({ merged_at: null, state: "open" }), "open");
});

test("harvest reads only GitHub repositories", () => {
  assert.equal(repoOf("git:github.com/o/r"), "o/r");
  assert.equal(repoOf("git:gitlab.com/o/r"), null);
  assert.equal(repoOf("local:notes"), null);
});

test("drops only filler replies", () => {
  assert.equal(isFiller("LGTM!"), true);
  assert.equal(isFiller("了解です。"), true);
  assert.equal(isFiller("![img](https://x)"), true);
  assert.equal(isFiller("これは DBT 側で"), false);
});

test("splits long text into parts at line ends, each within the limit, losing nothing", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `${i}: ${"あ".repeat(30)}`);
  const text = lines.join("\n");
  const ps = parts(text, 400);
  assert.ok(ps.length > 1);
  assert.ok(ps.every((p) => Buffer.byteLength(p) <= 400));
  assert.equal(ps.join("\n"), text);
  // A single line longer than the limit is cut without breaking a character
  const long = parts("い".repeat(300), 100);
  assert.ok(long.every((p) => Buffer.byteLength(p) <= 100 && !p.includes("�")));
  assert.equal(long.join(""), "い".repeat(300));
  assert.deepEqual(parts("short", 400), ["short"]);
});

// A bare "fixed" reply or a link to the fix can be the only sign that a finding was handled
test("keeps replies that say something was fixed, and links", () => {
  assert.equal(isFiller("修正しました"), false);
  assert.equal(isFiller("対応しました。"), false);
  assert.equal(isFiller("[reason](https://example.com/review)"), false);
});
