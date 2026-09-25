import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Budget, fixedDb, runDir } from "../evals/agentic/run.ts";
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
    result("d", framed(`k:9: not found\n\nthe answer`)),
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
  ...o,
});
const three = (o: Partial<Conditions> = {}) => [cond(o), cond(o), cond(o)];

test("setups compare only on 3+ runs each with matching conditions", () => {
  assert.deepEqual(ineligible(three(), three({ bundle: "b2" })), []);
  assert.deepEqual(ineligible(three(), [cond(), cond()]), ["fewer than 3 runs"]);
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
