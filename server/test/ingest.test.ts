import assert from "node:assert/strict";
import { test } from "node:test";
import { flatten, type Ir } from "../src/ingest.ts";

const base: Ir = {
  schema: "progress/1",
  meta: {
    id: "r1",
    title: "T",
    status: "active",
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
  },
};

test("極性は種別と場所から決まる。宣言に頼らない", () => {
  const ir: Ir = {
    ...base,
    background: { nonGoals: ["やらない"], constraints: ["触らない"] },
    decisions: [
      {
        id: "d1",
        decision: "採る",
        at: "2026-01-01T00:00:00Z",
        status: "accepted",
        options: [
          { option: "A", chosen: true },
          { option: "B", whyNot: "遅い" },
        ],
      },
    ],
    events: [
      { id: "e1", kind: "dead_end", text: "駄目だった", at: "2026-01-01T00:00:00Z" },
      { id: "e2", kind: "debt", text: "残した", at: "2026-01-01T00:00:00Z" },
      { id: "e3", kind: "note", text: "ただの経過", at: "2026-01-01T00:00:00Z" },
    ],
  };
  const by = new Map(flatten(ir).map((n) => [n.key, n.polarity]));
  assert.equal(by.get("d1"), "do");
  assert.equal(by.get("d1:0"), "do", "採用した案は do");
  assert.equal(by.get("d1:1"), "dont", "棄却した案は dont");
  assert.equal(by.get("e1"), "dont", "行き止まりは dont");
  assert.equal(by.get("e2"), "dont", "直しにいかない負債は dont");
  assert.equal(by.get("e3"), "na");
  // boundary が dont から外れると whatAboutPath（polarity = 'dont' で絞る）が恒久的に 0 件になり、
  // check_path と PreToolUse フックが「記録はありません」と正常応答し続ける。
  const boundaries = flatten(ir).filter((n) => n.kind === "boundary");
  assert.equal(boundaries.length, 2);
  for (const b of boundaries) assert.equal(b.polarity, "dont", `${b.key} が dont でない`);
  assert.equal([...by.keys()].filter((k) => k.startsWith("non-goal:")).length, 1);
});

test("本文が同じ「やらないこと」と「制約」は別のノードとして入る", () => {
  // どちらも kind=boundary なので content_hash は一致する。潰れないのはキーが分けているから。
  const ir: Ir = { ...base, background: { nonGoals: ["同じ文"], constraints: ["同じ文"] } };
  const [a, b] = flatten(ir);
  assert.ok(a && b);
  assert.equal(a.subkind, "non-goal");
  assert.equal(b.subkind, "constraint");
  assert.notEqual(a.key, b.key, "同じキーになると片方が上書きで消える");
});

test("空の IR でも落ちない", () => {
  assert.deepEqual(flatten(base), []);
});

test("trace 済みセッションの会話は発言者と元セッション ID を保つ", () => {
  const ir: Ir = {
    ...base,
    schema: "session/3",
    session: { id: "550e8400-e29b-41d4-a716-446655440000", host: "codex" },
    utterances: [
      { key: "u-human", ordinal: 0, at: "2026-01-01T00:00:00Z", role: "human", text: "依頼" },
      { key: "u-ai", ordinal: 1, at: "2026-01-01T00:00:01Z", role: "ai", text: "回答" },
    ],
  };
  const nodes = flatten(ir);
  assert.deepEqual(
    nodes.map((node) => ({ key: node.key, actorKind: node.actorKind, actorName: node.actorName })),
    [
      { key: "u-human", actorKind: "human", actorName: null },
      { key: "u-ai", actorKind: "ai", actorName: "codex" },
    ],
  );
  assert.equal(nodes[0]?.attrs?.session, "550e8400-e29b-41d4-a716-446655440000");
  assert.ok(
    nodes.every((node) => !node.searchable),
    "完全な会話は保持するが横断検索へは出さない",
  );
});

test("セッションは明示した知識だけを横断検索へ昇格する", () => {
  const ir: Ir = {
    ...base,
    schema: "session/3",
    knowledge: ["b-promoted", "d-promoted", "e-promoted", "v-promoted", "q-promoted"],
    background: {
      constraints: [
        { id: "b-promoted", text: "変えてはいけない境界" },
        { id: "b-detail-only", text: "この回だけの境界" },
      ],
    },
    decisions: [
      {
        id: "d-promoted",
        decision: "再利用する判断",
        at: "2026-01-01T00:00:00Z",
        options: [
          { option: "採用案", chosen: true },
          { option: "棄却案", whyNot: "再び選ばない理由" },
        ],
      },
      { id: "d-detail-only", decision: "この回だけの判断", at: "2026-01-01T00:00:00Z" },
    ],
    events: [
      { id: "e-promoted", kind: "dead_end", text: "再発する行き止まり", at: "2026-01-01T00:00:00Z" },
      { id: "e-detail-only", kind: "work", text: "作業ログ", at: "2026-01-01T00:00:00Z" },
    ],
    verification: [
      { id: "v-promoted", what: "再利用する検証結果", at: "2026-01-01T00:00:00Z" },
      { id: "v-detail-only", what: "通常のテスト結果", at: "2026-01-01T00:00:00Z" },
    ],
    openQuestions: [
      { id: "q-promoted", q: "別の回にも持ち越す問い", at: "2026-01-01T00:00:00Z" },
      { id: "q-detail-only", q: "この回だけの問い", at: "2026-01-01T00:00:00Z" },
    ],
  };
  const by = new Map(flatten(ir).map((node) => [node.key, node.searchable]));
  assert.equal(by.get("d-promoted"), true);
  assert.equal(by.get("d-promoted:0"), false, "採用案は決定本文と重複する");
  assert.equal(by.get("d-promoted:1"), true, "棄却理由は決定と一緒に検索できる");
  assert.equal(by.get("d-detail-only"), false);
  assert.equal(by.get("e-promoted"), true);
  assert.equal(by.get("e-detail-only"), false);
  assert.equal(by.get("v-promoted"), true);
  assert.equal(by.get("v-detail-only"), false);
  assert.equal(by.get("q-promoted"), true);
  assert.equal(by.get("q-detail-only"), false);
  assert.equal(by.get("b-promoted"), true);
  assert.equal(by.get("b-detail-only"), false);
});

test("旧セッションを再取り込みしても全件を検索対象へ戻さない", () => {
  const ir: Ir = {
    ...base,
    schema: "session/2",
    decisions: [{ id: "d-old", decision: "旧記録", at: "2026-01-01T00:00:00Z" }],
  };
  assert.equal(flatten(ir)[0]?.searchable, false);
});

test("記録の題を変えると再取得されるように、ハッシュが埋め込み文を覆う", () => {
  // ハッシュが embed_text の一部を見落とすと、古い題で作った埋め込みが残り続ける。
  const withTitle = (title: string): Ir => ({
    ...base,
    meta: { ...base.meta, title },
    background: { constraints: ["触らない"] },
  });
  const a = flatten(withTitle("題 A"))[0];
  const b = flatten(withTitle("題 B"))[0];
  const again = flatten(withTitle("題 A"))[0];
  assert.ok(a && b && again);
  assert.notEqual(a.contentHash, b.contentHash, "題が変われば再取得されないといけない");
  assert.equal(a.contentHash, again.contentHash, "変わっていなければ取り直さない");
});

test("決定の status ごとに極性が分かれる", () => {
  // accepted 以外を do にすると、却下した決定と覆した決定が「採用済み」として返る。
  const withStatus = (status: string): Ir => ({
    ...base,
    decisions: [{ id: "d1", decision: "認証のここは触らない", at: "2026-01-01T00:00:00Z", status }],
  });
  const polarity = (status: string) => flatten(withStatus(status))[0]?.polarity;
  assert.equal(polarity("accepted"), "do");
  assert.equal(polarity("superseded"), "dont", "覆した決定を現役の決定と同じに見せない");
  assert.equal(polarity("rejected"), "dont", "却下した決定を採用済みに見せない");
  assert.equal(polarity("proposed"), "na", "提案どまりは採否のどちらでもない");
});
