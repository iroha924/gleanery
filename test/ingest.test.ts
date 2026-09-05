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
