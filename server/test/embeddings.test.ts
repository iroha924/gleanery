import assert from "node:assert/strict";
import { test } from "node:test";
import { fillKnowledge } from "../src/embeddings.ts";

/** ready でない知識の行を返し、書き戻しと失敗の記録を覚える偽の DB。 */
function fakeDb(ids: string[]) {
  const rejected: string[] = [];
  const stored: string[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes("from mitos.knowledge_embedding e join")) {
      const skip = new Set(params[2] as string[]);
      return {
        rows: ids
          .filter((id) => !skip.has(id))
          .map((id) => ({
            id,
            kind: "finding",
            heading: null,
            body: `本文 ${id}`,
            reason: null,
            source_hash: Buffer.alloc(32),
          })),
      };
    }
    if (sql.includes("set status = 'error'")) {
      rejected.push(String(params[0]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("set embedding")) {
      stored.push(...(params[0] as string[]));
      return { rows: [], rowCount: (params[0] as string[]).length };
    }
    throw new Error(`想定外の SQL: ${sql}`);
  };
  return { rejected, stored, db: { query } as never };
}

/** Voyage を差し替える。bad に入った本文だけを 400 で拒み、status を渡すと全部をその status で返す。 */
function stubVoyage(opts: { bad?: string[]; status?: number }): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const input = JSON.parse(init.body).input as string[];
    if (opts.status) return new Response("{}", { status: opts.status });
    if (input.some((t) => opts.bad?.some((b) => t.includes(b)))) return new Response("{}", { status: 400 });
    return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [0.1] })) }));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

// 行の責任でない失敗を数えると、障害の間に回した同期だけで行が意味検索から永久に外れる。
test("鍵が無い・認証や障害の失敗では試行回数を数えずに止める", async () => {
  const none = fakeDb(["1", "2"]);
  assert.match((await fillKnowledge(none.db, {})).stopped ?? "", /VOYAGE_API_KEY/);
  const restore = stubVoyage({ status: 401 });
  try {
    const f = fakeDb(["1", "2"]);
    const r = await fillKnowledge(f.db, { VOYAGE_API_KEY: "k" });
    assert.match(r.stopped ?? "", /401/);
    assert.deepEqual(f.rejected, []);
  } finally {
    restore();
  }
});

test("本文を受け付けない行だけを数え、残りは埋める", async () => {
  const restore = stubVoyage({ bad: ["本文 2"] });
  try {
    const f = fakeDb(["1", "2", "3"]);
    const r = await fillKnowledge(f.db, { VOYAGE_API_KEY: "k" });
    assert.deepEqual([r.embedded, r.failed, r.stopped], [2, 1, undefined]);
    assert.deepEqual(f.rejected, ["2"]);
    assert.deepEqual(f.stored.sort(), ["1", "3"]);
  } finally {
    restore();
  }
});

// モデル名や引数の誤りは全部の本文を 400 にする。数えると、設定を直しても本文が変わるまで二度と送らない。
test("短い本文も拒まれるなら要求全体の問題とみなし、行が 1 つでも数えずに止める", async () => {
  const restore = stubVoyage({ status: 400 });
  try {
    for (const ids of [["1", "2", "3"], ["1"]]) {
      const f = fakeDb(ids);
      const r = await fillKnowledge(f.db, { VOYAGE_API_KEY: "k" });
      assert.match(r.stopped ?? "", /どの本文も受け付けられなかった/);
      assert.deepEqual(f.rejected, []);
    }
  } finally {
    restore();
  }
});

// 未処理が不正な行だけでも、行の問題なら数える（数えないと、毎回の同期が「止めた」と報告し続ける）。
test("全行が拒まれても短い本文が通るなら、行の問題として数える", async () => {
  const restore = stubVoyage({ bad: ["本文"] });
  try {
    const f = fakeDb(["1", "2"]);
    const r = await fillKnowledge(f.db, { VOYAGE_API_KEY: "k" });
    assert.deepEqual([r.embedded, r.failed, r.stopped], [0, 2, undefined]);
    assert.deepEqual(f.rejected.sort(), ["1", "2"]);
  } finally {
    restore();
  }
});
