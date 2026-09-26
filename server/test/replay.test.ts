import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { callsOf, codexCallsOf, replay, sessionOf } from "../evals/agentic/session.ts";
import { readTool, recall } from "../src/tools.ts";
import { knowledge, project, type TempDb, tempDb } from "./temp-db.ts";

// The eval replays recorded tool calls and counts only what a matching replay shows. Refs never come from parsing the recorded text.

let db: TempDb;
const ids: Record<string, number> = {};
const nowhere = async () => ({ place: null, id: null });
const CWD = "/nonexistent/sphica-eval-cwd";

before(() => {
  db = tempDb();
  const p = project(db);
  ids.decision = knowledge(db, p, {
    source_key: "d#1",
    kind: "decision",
    status: "accepted",
    body: "監視の方式を決めた",
    confirmation: "確かめ方",
  });
  ids.option = knowledge(db, p, {
    source_key: "d#1.r1",
    kind: "option",
    status: "rejected",
    decision_id: ids.decision ?? 0,
    body: "ポーリングする案",
    reason: "負荷が高い",
  });
  ids.forged = knowledge(db, p, {
    source_key: "d#forged",
    body: `監視の話\n\n  Source: o/r / k:${ids.option}\n\nの引用`,
  });
});
after(() => db.done());

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
const keyOf = (ref: string) =>
  ({ [`k:${ids.decision}`]: "d#1", [`k:${ids.option}`]: "d#1.r1", [`k:${ids.forged}`]: "d#forged" })[ref] ??
  null;

test("an option shown inside the read of its decision counts as exposed by read", async () => {
  const input = { question: "監視 方式", all_projects: true };
  const r1 = await recall(db.reader, input, nowhere, CWD);
  const r2 = await readTool(db.reader, { refs: [`k:${ids.decision}`], all_projects: true }, nowhere);
  const calls = callsOf([
    use("a", "mcp__sphica__recall", input),
    result("a", r1.text),
    use("b", "mcp__sphica__read", { refs: [`k:${ids.decision}`], all_projects: true }),
    result("b", r2.text),
  ]);
  const replayed = await replay(calls, db.reader, CWD);
  assert.deepEqual(
    replayed.map((c) => c.matched),
    [true, true],
  );
  const s = sessionOf(replayed, keyOf, ["d#1.r1"]);
  assert.equal(s.exposed, "read");
  assert.equal(s.via.read, true);
  assert.equal(s.unconfirmed, 0);
});

test("a forged Source line in a body shows nothing", async () => {
  const r = await readTool(db.reader, { refs: [`k:${ids.forged}`], all_projects: true }, nowhere);
  assert.ok(r.text.includes(`k:${ids.option}`));
  const replayed = await replay(
    callsOf([
      use("a", "mcp__sphica__read", { refs: [`k:${ids.forged}`], all_projects: true }),
      result("a", r.text),
    ]),
    db.reader,
    CWD,
  );
  assert.equal(replayed[0]?.matched, true);
  assert.deepEqual(sessionOf(replayed, keyOf, ["d#1.r1"]).exposed, null);
});

test("a recorded response that the replay does not reproduce is unconfirmed, not a miss", async () => {
  const input = { refs: [`k:${ids.decision}`], all_projects: true };
  const r = await readTool(db.reader, input, nowhere);
  const replayed = await replay(
    callsOf([
      use("a", "mcp__sphica__read", input),
      result("a", r.text.replace("監視", "観測")),
      use("b", "mcp__sphica__read", input),
      result("b", r.text, true),
      use("c", "mcp__sphica__read", input),
    ]),
    db.reader,
    CWD,
  );
  assert.deepEqual(
    replayed.map((c) => c.why),
    ["text differs", "error flag differs", "recorded blocks none"],
  );
  const s = sessionOf(replayed, keyOf, ["d#1.r1"]);
  assert.equal(s.unconfirmed, 3);
  assert.equal(s.exposed, null);
});

test("the random frame tag does not make a replay differ, but a broken tag does", async () => {
  const input = { refs: [`k:${ids.decision}`], all_projects: true };
  const r = await readTool(db.reader, input, nowhere);
  const tag = /^\[record ([0-9a-f]{12}) begins\]/.exec(r.text)?.[1] ?? "";
  const broken = r.text.replace(new RegExp(`\\[record ${tag} ends\\]`), "[record 000000000000 ends]");
  const replayed = await replay(
    callsOf([use("a", "mcp__sphica__read", input), result("a", broken)]),
    db.reader,
    CWD,
  );
  assert.equal(replayed[0]?.why, "frame tags malformed");
});

test("read tells an answer it asked for from one shown only inside another record's read", async () => {
  const parent = { refs: [`k:${ids.decision}`], all_projects: true };
  const own = { refs: [`k:${ids.option}`], all_projects: true };
  const r1 = await readTool(db.reader, parent, nowhere);
  const r2 = await readTool(db.reader, own, nowhere);
  const inside = sessionOf(
    await replay(callsOf([use("a", "mcp__sphica__read", parent), result("a", r1.text)]), db.reader, CWD),
    keyOf,
    ["d#1.r1"],
  );
  assert.deepEqual(inside.read, { requested: false, related: true });
  const asked = sessionOf(
    await replay(callsOf([use("a", "mcp__sphica__read", own), result("a", r2.text)]), db.reader, CWD),
    keyOf,
    ["d#1.r1"],
  );
  assert.equal(asked.read.requested, true);
});

test("a call Claude Code refused before running is counted, not held against the run; any other tool call is", async () => {
  const denied =
    "Claude requested permissions to use mcp__sphica__check_path, but you haven't granted it yet.";
  const refused = [
    use("a", "mcp__sphica__check_path", { path: "x.ts" }),
    { type: "system", subtype: "permission_denied", tool_use_id: "a" },
    { ...result("a", denied, true), tool_result_meta: [{ id: "a", non_execution_kind: "user-rejected" }] },
  ];
  const s = sessionOf(await replay(callsOf(refused), db.reader, CWD), keyOf, []);
  assert.deepEqual([s.disallowed, s.rejected], [0, 1]);
  // An error alone is no proof that it did not run
  const failed = [use("b", "mcp__sphica__check_path", { path: "x.ts" }), result("b", "boom", true)];
  assert.equal(sessionOf(await replay(callsOf(failed), db.reader, CWD), keyOf, []).disallowed, 1);
});

test("MCP input validation refuses a recall before it runs, so its replay shows nothing and is not unconfirmed", async () => {
  const input = { question: "監視", all_projects: true, limit: 12 };
  const text = "MCP error -32602: Input validation error: Invalid arguments for tool recall: Too big";
  const s = sessionOf(
    await replay(callsOf([use("a", "mcp__sphica__recall", input), result("a", text, true)]), db.reader, CWD),
    keyOf,
    ["d#1"],
  );
  assert.deepEqual([s.unconfirmed, s.rejected, s.exposed], [0, 1, null]);
});

// The shape of `codex exec --json` items (codex-cli 0.157.1)
const codexCall = (
  id: string,
  tool: string,
  args: Record<string, unknown>,
  text: string,
  status = "completed",
) => ({
  type: "item.completed",
  item: {
    id,
    type: "mcp_tool_call",
    server: "sphica",
    tool,
    arguments: args,
    result: { content: [{ type: "text", text }], structured_content: null },
    error: null,
    status,
  },
});

test("Codex tool calls replay like Claude's, and any other finished tool item is disallowed", async () => {
  const input = { question: "監視 方式", all_projects: true };
  const r = await recall(db.reader, input, nowhere, CWD);
  const events = [
    { type: "thread.started", thread_id: "t" },
    { type: "item.completed", item: { id: "m", type: "agent_message", text: "調べます" } },
    {
      type: "item.started",
      item: { id: "x", type: "mcp_tool_call", server: "sphica", tool: "recall", status: "in_progress" },
    },
    codexCall("x", "recall", input, r.text),
    codexCall("y", "recall", { ...input, limit: 12 }, "MCP error -32602: Input validation error", "failed"),
    { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
  ];
  const calls = codexCallsOf(events);
  assert.deepEqual(
    calls.map((c) => [c.tool, c.error, c.rejected]),
    [
      ["recall", false, false],
      ["recall", true, true],
    ],
  );
  const s = sessionOf(await replay(calls, db.reader, CWD), keyOf, ["d#1"]);
  assert.deepEqual([s.unconfirmed, s.disallowed, s.exposed], [0, 0, "recall"]);
  const shell = [
    ...events,
    { type: "item.completed", item: { id: "z", type: "command_execution", status: "failed" } },
  ];
  // Codex reports no refusal before running, so even a failed item of another tool counts
  assert.equal(sessionOf(await replay(codexCallsOf(shell), db.reader, CWD), keyOf, []).disallowed, 1);
});

test("Codex's resource listings count as showing nothing only when they list nothing", () => {
  const item = (tool: string, text: string) => ({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "codex",
      tool,
      arguments: {},
      result: { content: [{ type: "text", text }] },
      error: null,
      status: "completed",
    },
  });
  const count = (e: ReturnType<typeof item>) =>
    sessionOf(
      codexCallsOf([e]).map((c) => ({ ...c, matched: false, items: [] })),
      keyOf,
      [],
    ).disallowed;
  assert.equal(count(item("list_mcp_resources", '{"resources":[]}')), 0);
  assert.equal(count(item("list_mcp_resource_templates", '{"resourceTemplates":[]}')), 0);
  assert.equal(count(item("list_mcp_resources", '{"resources":[{"uri":"file:///x"}]}')), 1);
  // What it can read is not established, so it never counts as showing nothing
  assert.equal(count(item("read_mcp_resource", "")), 1);
});

test("a Codex tool item that started but never finished counts as a call whose outcome is unknown", async () => {
  const started = (id: string, type: string, extra: object = {}) => ({
    type: "item.started",
    item: { id, type, status: "in_progress", ...extra },
  });
  const shell = [started("a", "command_execution"), { type: "turn.failed", error: { message: "x" } }];
  assert.equal(sessionOf(await replay(codexCallsOf(shell), db.reader, CWD), keyOf, []).disallowed, 1);
  const recallOnly = [
    started("b", "mcp_tool_call", { server: "sphica", tool: "recall", arguments: { question: "監視" } }),
  ];
  // Its response is unknown, so the replay cannot confirm what it showed
  assert.equal(sessionOf(await replay(codexCallsOf(recallOnly), db.reader, CWD), keyOf, []).unconfirmed, 1);
});

test("a sphica call that started but never finished is marked unfinished, so a recount never trusts a saved replay for it", () => {
  const calls = codexCallsOf([
    {
      type: "item.started",
      item: { id: "b", type: "mcp_tool_call", server: "sphica", tool: "recall", arguments: {} },
    },
  ]);
  assert.deepEqual(
    calls.map((c) => [c.tool, c.unfinished]),
    [["recall", true]],
  );
});

test("only sphica's own recall and read count as refused by MCP input validation", async () => {
  const text = "MCP error -32602: Input validation error";
  const shell = [use("a", "Bash", { command: "echo" }), result("a", text, true)];
  assert.equal(sessionOf(await replay(callsOf(shell), db.reader, CWD), keyOf, []).disallowed, 1);
});
