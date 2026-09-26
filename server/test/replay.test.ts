import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { callsOf, replay, sessionOf } from "../evals/agentic/session.ts";
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
