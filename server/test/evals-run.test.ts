import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  Budget,
  codexArgs,
  fixedDb,
  probeLeaks,
  QuestionCap,
  runDir,
  summarize,
} from "../evals/agentic/run.ts";
import { type Conditions, ineligible, type Run, solved, verdict } from "../evals/agentic/verdict.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-evals-test-")));
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
  const saved = process.env.SPHICA_DB;
  try {
    delete process.env.SPHICA_DB;
    assert.throws(() => fixedDb(), /SPHICA_DB/);
    const db = path.join(tmp, "copy.db");
    fs.writeFileSync(db, "x");
    process.env.SPHICA_DB = db;
    assert.equal(fixedDb(), db);
    fs.writeFileSync(`${db}-wal`, "pending");
    assert.throws(() => fixedDb(), /WAL/);
  } finally {
    if (saved === undefined) delete process.env.SPHICA_DB;
    else process.env.SPHICA_DB = saved;
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
  memo: null,
  host: "claude",
  violations: 0,
  complete: true,
  ungraded: 0,
  ...o,
});
const three = (o: Partial<Conditions> = {}) => [cond(o), cond(o), cond(o)];

test("setups compare only on 3+ runs each with matching conditions", () => {
  assert.deepEqual(ineligible(three(), three({ bundle: "b2" })), []);
  assert.deepEqual(ineligible(three(), three({ memo: "m1" })), [], "base and setup may use different memos");
  assert.deepEqual(ineligible(three(), [cond({ memo: "m1" }), cond({ memo: "m1" }), cond({ memo: "m2" })]), [
    "setup runs used different memos",
  ]);
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
  const saved = process.env.SPHICA_DB;
  try {
    process.env.SPHICA_DB = path.join(os.homedir(), ".sphica", "sphica.db");
    assert.throws(() => fixedDb(), /live/);
  } finally {
    if (saved === undefined) delete process.env.SPHICA_DB;
    else process.env.SPHICA_DB = saved;
  }
});

test("the live database is refused through a symlink too", () => {
  const saved = process.env.SPHICA_DB;
  const live = path.join(tmp, "live.db");
  fs.writeFileSync(live, "x");
  const link = path.join(tmp, "live-link.db");
  fs.symlinkSync(live, link);
  try {
    process.env.SPHICA_DB = link;
    assert.throws(() => fixedDb(live), /live/);
  } finally {
    if (saved === undefined) delete process.env.SPHICA_DB;
    else process.env.SPHICA_DB = saved;
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
  const saved = process.env.SPHICA_DB;
  const target = path.join(tmp, "copy-target.db");
  const link = path.join(tmp, "copy-link.db");
  fs.writeFileSync(target, "x");
  fs.symlinkSync(target, link);
  try {
    process.env.SPHICA_DB = link;
    fs.writeFileSync(`${link}-wal`, "pending");
    assert.throws(() => fixedDb(path.join(tmp, "none.db")), /WAL/);
    fs.rmSync(`${link}-wal`);
    fs.writeFileSync(`${target}-wal`, "pending");
    assert.throws(() => fixedDb(path.join(tmp, "none.db")), /WAL/);
  } finally {
    if (saved === undefined) delete process.env.SPHICA_DB;
    else process.env.SPHICA_DB = saved;
  }
});

test("runs of two hosts, or runs whose tool use was not cleared from traces, are never compared", () => {
  assert.deepEqual(ineligible(three(), three({ host: "codex" })), ["host differ"]);
  assert.deepEqual(ineligible(three({ violations: null }), three()), [
    "tool use not counted from the traces",
  ]);
  assert.deepEqual(ineligible(three(), [cond(), cond(), cond({ violations: 1 })]), [
    "a run used another tool or had calls whose replay did not match",
  ]);
});

test("a Codex run is capped by the questions it starts, and an unknown Claude cost is charged its whole cap", () => {
  const cap = new QuestionCap(2);
  assert.deepEqual([cap.reserve(), cap.reserve(), cap.reserve()], [true, true, false]);
  assert.equal(cap.spent, null);
  for (const n of [0, 1.5, Number.NaN]) assert.throws(() => new QuestionCap(n), /--questions/);
  const b = new Budget(1);
  assert.equal(b.reserve(), true);
  b.settle(null);
  assert.equal(b.spent, 0.5);
});

test("a run with a question of unknown cost reports no total cost rather than a partial one", () => {
  const r = {
    i: 0,
    q: "q",
    kind: "k",
    rank: 0,
    refs: [],
    keys: [],
    turns: 1,
    ms: 1,
    resolved: { model: null, claude: null },
  };
  const meta = { name: "n", split: "dev", model: "m", effort: "e", cases: "c", ms: 1 };
  assert.equal(
    summarize(
      [
        { ...r, cost: null },
        { ...r, cost: 0.1 },
      ] as never,
      meta,
    ).cost_usd_list,
    null,
  );
  assert.equal(summarize([{ ...r, cost: 0.1 }] as never, meta).cost_usd_list, 0.1);
});

test("a Codex question runs read-only with the shell off and only sphica's recall and read", () => {
  const args = codexArgs("/b/mcp.js", "/d/copy.db", "gpt-6-sol", undefined);
  for (const a of [
    "features.shell_tool=false",
    "features.unified_exec=false",
    "features.multi_agent=false",
    'web_search="disabled"',
    'mcp_servers.sphica.enabled_tools=["recall","read"]',
    'mcp_servers.sphica.env={SPHICA_DB="/d/copy.db"}',
    'model_reasoning_effort="high"',
  ])
    assert.ok(args.includes(a), a);
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), [
    "--sandbox",
    "read-only",
  ]);
  assert.equal(args.at(-1), "-");
});

test("the Codex probe fails on any other tool that completed, or when it never finished", () => {
  const done = { type: "turn.completed", usage: {} };
  const ran = { type: "item.completed", item: { type: "command_execution", status: "completed" } };
  const refused = { type: "item.completed", item: { type: "command_execution", status: "failed" } };
  // A failed item is no proof that it did not run (a shell command that exited nonzero fails too)
  assert.equal(probeLeaks([refused, done]).length, 1);
  assert.equal(probeLeaks([ran, done]).length, 1);
  const listed = {
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "codex",
      tool: "list_mcp_resources",
      arguments: {},
      status: "completed",
      result: { content: [{ type: "text", text: '{"resources":[]}' }] },
    },
  };
  assert.deepEqual(probeLeaks([listed, done]), []);
  assert.deepEqual(probeLeaks([done]), []);
  assert.ok(probeLeaks([]).includes("the probe did not finish"));
});
