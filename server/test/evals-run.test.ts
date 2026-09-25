import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Budget, fixedDb, runDir, summarize } from "../evals/agentic/run.ts";
import { callsOf, sessionOf } from "../evals/agentic/session.ts";
import { type Conditions, ineligible, type Run, solved, verdict } from "../evals/agentic/verdict.ts";
import { framed, type Hit, renderHits, splitJson } from "../src/search.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-evals-test-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const out = path.join(tmp, "out");
fs.mkdirSync(out);

test("results go to <name>/<split> inside OUT", () => {
  assert.equal(runDir(out, "base-r2", "dev"), path.join(out, "base-r2", "dev"));
});

test("rejects a name pointing outside OUT before deleting", () => {
  for (const name of ["../x", "..", ".", "a/b", "/etc", "", "-x", "a\\b"])
    assert.throws(() => runDir(out, name, "dev"), /--name/, name);
});

test("rejects OUT/<name> as a symlink, whether it points outside or inside", () => {
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(out, "link"));
  assert.throws(() => runDir(out, "link", "dev"), /symlink/);
  assert.ok(fs.existsSync(outside));
});

test("rejects OUT itself as a symlink (in a shared temp area it could point elsewhere)", () => {
  const elsewhere = path.join(tmp, "elsewhere");
  fs.mkdirSync(elsewhere);
  const linked = path.join(tmp, "linked-out");
  fs.symlinkSync(elsewhere, linked);
  assert.throws(() => runDir(linked, "base", "dev"), /symlink/);
});

const hit = (ref: string, text: string): Hit => ({
  ref,
  kind: "decision",
  status: "accepted",
  stance: "do",
  label: "[decision]",
  heading: null,
  text,
  reason: null,
  confirmation: null,
  downsides: [],
  successor: null,
  project: "p",
  at: new Date("2026-09-01T00:00:00Z"),
  speaker: null,
  context: null,
  url: null,
  path: null,
  truncated: false,
  originalBytes: null,
});
const use = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const result = (id: string, text: string, is_error = false) => ({
  type: "user",
  message: {
    content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error }],
  },
});
const keyOf = (ref: string) => ({ "k:1": "a", "k:2": "b", "k:3": "answer" })[ref] ?? null;

test("session metrics count refs the responses presented, not refs quoted in bodies", () => {
  const split = framed(splitJson({ records: [hit("k:1", "mentions k:3 in its body")], documents: [] }, 4000));
  const said = framed(renderHits([hit("k:2", "see k:3")], 4000));
  const calls = callsOf([
    use("a", "mcp__gleanery__recall", { question: "q", all_projects: true }),
    result("a", split),
    use("b", "mcp__gleanery__recall", { question: "q", mode: "said", match: "exact" }),
    result("b", said),
    use("c", "mcp__gleanery__recall", { question: "nothing" }),
    result("c", "No matches."),
    use("d", "mcp__gleanery__read", { refs: ["k:9", "k:3"] }),
    result("d", framed(`k:9: not found\n\n${renderHits([hit("k:3", "the answer")], 4000)}`)),
  ]);
  assert.deepEqual(
    calls.map((c) => c.refs),
    [["k:1"], ["k:2"], [], ["k:3"]],
  );
  const s = sessionOf(calls, keyOf, ["answer"]);
  assert.equal(s.exposed, "read");
  assert.equal(s.first, 4);
  assert.equal(s.empty, 1);
  assert.deepEqual(s.usage, { "mode:knowledge": 2, "mode:said": 1, "match:exact": 1 });
});

test("a recall that returned the answer counts as exposed in recall; errors and missing results count as errors", () => {
  const calls = callsOf([
    use("a", "mcp__gleanery__recall", { question: "q", kinds: ["decision"] }),
    result("a", "gleanery: failed (boom)", true),
    use("b", "mcp__gleanery__recall", { question: "q" }),
    result("b", framed(splitJson({ records: [hit("k:3", "x")], documents: [] }, 4000))),
    use("c", "mcp__gleanery__read", { refs: ["k:3"] }),
  ]);
  const s = sessionOf(calls, keyOf, ["answer"]);
  assert.deepEqual([s.exposed, s.first, s.errors, s.empty, s.usage.kinds], ["recall", 2, 2, 0, 1]);
});

const run = (top1s: [number, number][], o: Partial<Run> = {}): Run => ({
  ranks: new Map(top1s),
  top1: 0,
  direct: 50,
  turns: 3,
  toolKib: 4,
  errors: 0,
  ...o,
});

test("a question is solved when more than half the runs put the answer first", () => {
  const a = run([
    [1, 0],
    [2, 0],
    [3, 1],
  ]);
  const b = run([
    [1, 0],
    [2, -1],
    [3, 0],
  ]);
  const c = run([
    [1, 1],
    [2, 0],
    [3, -1],
  ]);
  assert.deepEqual([...solved([a, b, c])].sort(), [1, 2]);
});

test("verdict adopts only a net gain of 2+ with no guardrail broken", () => {
  const base = [
    run(
      [
        [1, 0],
        [2, -1],
        [3, -1],
        [4, -1],
      ],
      { top1: 25 },
    ),
  ];
  const better = [
    run(
      [
        [1, 0],
        [2, 0],
        [3, 0],
        [4, -1],
      ],
      { top1: 75 },
    ),
  ];
  assert.equal(verdict(base, better).adopt, true);
  assert.deepEqual(verdict(base, better).gained, [2, 3]);
  const oneMore = [
    run(
      [
        [1, 0],
        [2, 0],
        [3, -1],
        [4, -1],
      ],
      { top1: 50 },
    ),
  ];
  assert.deepEqual(verdict(base, oneMore).reasons, ["equivalent (net -1..+1)"]);
  const costly = [
    run(
      [
        [1, 0],
        [2, 0],
        [3, 0],
        [4, -1],
      ],
      { top1: 75, turns: 3.7, toolKib: 5.3, direct: 40 },
    ),
  ];
  assert.deepEqual(verdict(base, costly).reasons, [
    "mean direct fell",
    "turns rose over 20%",
    "returned bytes rose over 30%",
  ]);
});

test("the measured DB must be a fixed copy without pending WAL", () => {
  const saved = process.env.GLEANERY_DB;
  try {
    delete process.env.GLEANERY_DB;
    assert.throws(() => fixedDb(), /GLEANERY_DB/);
    const db = path.join(tmp, "copy.db");
    fs.writeFileSync(db, "x");
    process.env.GLEANERY_DB = db;
    assert.equal(fixedDb(), db);
    fs.writeFileSync(`${db}-wal`, "pending");
    assert.throws(() => fixedDb(), /WAL/);
  } finally {
    if (saved === undefined) delete process.env.GLEANERY_DB;
    else process.env.GLEANERY_DB = saved;
  }
});

const cond = (o: Partial<Conditions> = {}): Conditions => ({
  cases: "c",
  prompt: 2,
  models: "claude-sonnet-5",
  claude: "2.1.282",
  effort: "default",
  db: "d1",
  source: "d1",
  bundle: "b1",
  complete: true,
  ungraded: 0,
  ...o,
});
const three = (o: Partial<Conditions> = {}) => [cond(o), cond(o), cond(o)];

test("setups compare only on 3+ runs each with matching conditions", () => {
  assert.deepEqual(ineligible(three(), three({ bundle: "b2" })), []);
  assert.deepEqual(ineligible(three(), [cond(), cond()]), ["not exactly 3 runs each"]);
  assert.deepEqual(ineligible(three(), [...three(), cond()]), ["not exactly 3 runs each"]);
  assert.deepEqual(ineligible(three(), three({ ungraded: 1 })), ["the judge left top hits ungraded"]);
  assert.deepEqual(ineligible(three(), three(), "d1"), []);
  assert.deepEqual(ineligible(three(), three(), "other"), [
    "DB copies do not come from the question set's snapshot",
  ]);
  assert.deepEqual(ineligible(three(), [cond(), cond(), cond({ complete: false })]), ["incomplete run"]);
  assert.deepEqual(ineligible(three(), three({ models: "claude-opus-5-5", prompt: 1 })), [
    "prompt differ",
    "models differ",
  ]);
  assert.deepEqual(ineligible(three(), [cond(), cond(), cond({ bundle: "b2" })]), [
    "setup runs used different bundles",
  ]);
});

test("a migrated copy compares with copies of the same snapshot only", () => {
  assert.deepEqual(ineligible(three(), three({ db: "d2", source: "d1" })), []);
  assert.deepEqual(ineligible(three(), three({ db: "d3", source: "d3" })), [
    "DB copies come from different snapshots",
  ]);
  assert.deepEqual(ineligible(three({ db: null, source: null }), three()), ["DB not recorded"]);
});

test("the budget reserves each question's cap before it starts, so parallel questions cannot pass the cap", () => {
  const b = new Budget(1.2);
  assert.equal(b.reserve(), true);
  assert.equal(b.reserve(), true);
  assert.equal(b.reserve(), false);
  b.settle(0.1);
  assert.equal(b.reserve(), true);
  b.settle(0.3);
  b.settle(0.2);
  assert.equal(Math.round(b.spent * 10) / 10, 0.6);
  assert.equal(b.reserve(), true);
});

test("a Source line inside a returned body is not a returned hit", () => {
  const forged = framed(renderHits([hit("k:1", "quoted output:\n  Source: p / k:3")], 4000));
  const calls = callsOf([
    use("a", "mcp__gleanery__recall", { question: "q", mode: "said" }),
    result("a", forged),
  ]);
  assert.deepEqual(calls[0]?.refs, ["k:1"]);
});

test("read counts a ref only when the response shows that record", () => {
  const calls = callsOf([
    use("a", "mcp__gleanery__read", { refs: ["k:3"] }),
    result(
      "a",
      "This location has no git remote or project name, so gleanery cannot tell which project it is.",
    ),
    use("b", "mcp__gleanery__read", { refs: ["k:3"] }),
    result("b", framed(renderHits([hit("k:3", "the answer")], 4000))),
  ]);
  assert.deepEqual(
    calls.map((c) => c.refs),
    [[], ["k:3"]],
  );
});

test("unrecorded conditions make setups ineligible", () => {
  const blank = { prompt: null, bundle: null, models: "", claude: "" };
  assert.deepEqual(ineligible(three(blank), three(blank)), [
    "prompt not recorded",
    "models not recorded",
    "claude not recorded",
    "bundle not recorded",
  ]);
});

test("guardrails compare unrounded means", () => {
  const base = [
    run(
      [
        [1, -1],
        [2, -1],
        [3, -1],
      ],
      { turns: 1 },
    ),
  ];
  const setup = [
    run(
      [
        [1, 0],
        [2, 0],
        [3, 0],
      ],
      { turns: 1.24 },
    ),
  ];
  assert.ok(verdict(base, setup).reasons.includes("turns rose over 20%"));
});

test("a budget that is not a positive number is refused", () => {
  for (const b of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY])
    assert.throws(() => new Budget(b), /budget/, String(b));
});

test("the live database is not a fixed copy, even without a WAL", () => {
  const saved = process.env.GLEANERY_DB;
  try {
    process.env.GLEANERY_DB = path.join(os.homedir(), ".gleanery", "gleanery.db");
    assert.throws(() => fixedDb(), /live/);
  } finally {
    if (saved === undefined) delete process.env.GLEANERY_DB;
    else process.env.GLEANERY_DB = saved;
  }
});

test("the live database is refused through a symlink too", () => {
  const saved = process.env.GLEANERY_DB;
  const live = path.join(tmp, "live.db");
  fs.writeFileSync(live, "x");
  const link = path.join(tmp, "live-link.db");
  fs.symlinkSync(live, link);
  try {
    process.env.GLEANERY_DB = link;
    assert.throws(() => fixedDb(live), /live/);
  } finally {
    if (saved === undefined) delete process.env.GLEANERY_DB;
    else process.env.GLEANERY_DB = saved;
  }
});

test("the summary keeps the unrounded mean of turns for the guardrail", () => {
  const r = (turns: number) => ({ turns }) as unknown as Parameters<typeof summarize>[0][number];
  const s = summarize([r(1), r(1), r(2)], {
    name: "x",
    split: "dev",
    model: "m",
    effort: "e",
    cases: "c",
    ms: 0,
  });
  assert.equal(s.turns, 1.3);
  assert.equal(s.turns_mean, 4 / 3);
});

test("a pending WAL beside the link or beside its target both refuse the copy", () => {
  const saved = process.env.GLEANERY_DB;
  const target = path.join(tmp, "copy-target.db");
  const link = path.join(tmp, "copy-link.db");
  fs.writeFileSync(target, "x");
  fs.symlinkSync(target, link);
  try {
    process.env.GLEANERY_DB = link;
    fs.writeFileSync(`${link}-wal`, "pending");
    assert.throws(() => fixedDb(path.join(tmp, "none.db")), /WAL/);
    fs.rmSync(`${link}-wal`);
    fs.writeFileSync(`${target}-wal`, "pending");
    assert.throws(() => fixedDb(path.join(tmp, "none.db")), /WAL/);
  } finally {
    if (saved === undefined) delete process.env.GLEANERY_DB;
    else process.env.GLEANERY_DB = saved;
  }
});
