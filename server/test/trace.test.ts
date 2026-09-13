import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTrace, rows, type Trace } from "../src/trace.ts";

const at = "2026-09-13T10:00:00+09:00";
const base = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  schema: "trace/1",
  session: { host: "claude-code", id: "s1" },
  items,
  ...extra,
});
const decision = (over: Record<string, unknown> = {}) => ({
  key: "d-halfvec",
  kind: "decision",
  status: "accepted",
  at,
  text: "埋め込みは halfvec(1024) で持つ",
  context: "容量を半分にしたい",
  options: [
    { text: "halfvec", chosen: true },
    { text: "vector", chosen: false, why: "容量が倍" },
  ],
  confirmation: "schema.sql の型が halfvec",
  ...over,
});
const problems = (raw: unknown) => checkTrace(raw).problems.join("\n");

test("通る記録は、決定の案を option の行にし、key を session で一意にする", () => {
  const r = checkTrace(
    base([decision()], {
      work: { key: "rebuild", title: "作り直し", goal: "13 表", current: "実装中", status: "active" },
    }),
  );
  assert.deepEqual(r.problems, []);
  const out = rows(r.trace as Trace);
  assert.deepEqual(
    out.map((x) => [x.key, x.kind, x.status, x.parent]),
    [
      ["claude-code:s1#d-halfvec", "decision", "accepted", null],
      ["claude-code:s1#d-halfvec:o1", "option", "chosen", "claude-code:s1#d-halfvec"],
      ["claude-code:s1#d-halfvec:o2", "option", "rejected", "claude-code:s1#d-halfvec"],
    ],
  );
  assert.equal(out[2]?.reason, "容量が倍");
});

// 決定の価値は捨てた案にある。棄却理由の無い決定は、同じ案を再検討させる。
test("棄却した案と理由・確かめ方の無い決定を通さない", () => {
  assert.match(
    problems(base([decision({ options: [{ text: "halfvec", chosen: true }] })])),
    /棄却した案と、その理由/,
  );
  assert.match(
    problems(
      base([
        decision({
          options: [
            { text: "a", chosen: true },
            { text: "b", chosen: false },
          ],
        }),
      ]),
    ),
    /why を書く/,
  );
  assert.match(problems(base([decision({ confirmation: undefined })])), /confirmation/);
});

test("根拠の無い fact と、理由の無い未実行の検証を通さない", () => {
  assert.match(
    problems(base([{ key: "f-1", kind: "finding", at, text: "Neon は 18", confidence: "fact" }])),
    /fact には refs か evidence/,
  );
  assert.deepEqual(
    checkTrace(
      base([
        {
          key: "f-1",
          kind: "finding",
          at,
          text: "Neon は 18",
          confidence: "fact",
          refs: ["cmd:psql -c 'select version()'"],
        },
      ]),
    ).problems,
    [],
  );
  assert.match(
    problems(base([{ key: "v-1", kind: "verification", at, text: "E2E", status: "not_run" }])),
    /reason/,
  );
});

test("参照は、この記録の決定か別の session の key だけ", () => {
  assert.match(
    problems(
      base([{ key: "v-1", kind: "verification", at, text: "型", status: "passed", verifies: "d-none" }]),
    ),
    /d-none はこの記録の決定に無い/,
  );
  assert.deepEqual(
    checkTrace(
      base([
        { key: "v-1", kind: "verification", at, text: "型", status: "passed", verifies: "codex:t9#d-old" },
      ]),
    ).problems,
    [],
  );
});

// 後継の無い superseded は、何に置き換わったのかが分からず迷子になる。
test("superseded は、この記録の別の決定が覆していなければならない", () => {
  assert.match(problems(base([decision({ status: "superseded" })])), /supersedes でこの key を指す/);
  const ok = checkTrace(
    base([
      decision({ status: "superseded" }),
      decision({ key: "d-vector", text: "vector に戻す", supersedes: "d-halfvec" }),
    ]),
  );
  assert.deepEqual(ok.problems, []);
  const out = rows(ok.trace as Trace);
  const old = out.find((x) => x.key === "claude-code:s1#d-halfvec");
  assert.equal(old?.supersededBy, "claude-code:s1#d-vector");
  // 覆された決定で採った案を、採用のまま返さない。
  assert.equal(out.find((x) => x.key === "claude-code:s1#d-halfvec:o1")?.status, "was_chosen");
});

test("知らない欄と、形の違う日時・パスを弾く", () => {
  assert.match(problems(base([decision({ extra: 1 })])), /Unrecognized key|extra/);
  assert.match(problems(base([decision({ at: "2026-09-13" })])), /ISO 8601/);
  assert.match(
    problems(
      base([
        {
          key: "c-1",
          kind: "constraint",
          status: "active",
          at,
          text: "x",
          files: [{ path: "/abs/x.ts", role: "applies_to" }],
        },
      ]),
    ),
    /相対パス/,
  );
  assert.match(problems(base([decision(), decision()])), /重複/);
});
