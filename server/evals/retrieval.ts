#!/usr/bin/env node
// 検索の精度を測る。目視ではなく、正解が分かる問いで数える。
//
// **出荷している関数そのものを測る。**eval が組み立てた経路は原因の切り分けにしか使わない。
// 測るのは recall@k（正解が上位 k に入った割合）と MRR（正解の順位の逆数の平均）と top1。
//
// **実 DB と外部 API へ繋ぐので `bun run verify` に入れない。**手で叩く（`bun run evals:retrieval`）。
// 比較したいときは、変更の前後で同じ retrieval.json を使う。問いを作り直すと比較にならない。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { loadEnv, open } from "../src/db.ts";
import { fuse, type Hit, searchKnowledge, searchMessages } from "../src/search.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Case = { q: string; expect: string[]; kind: string; source: string };
const { cases } = JSON.parse(fs.readFileSync(path.join(HERE, "retrieval.json"), "utf8")) as { cases: Case[] };

const K = 5;
const env = loadEnv();
const db = open(env, "reader");

// ref（k:12 / m:uuid）から、正解と突き合わせる鍵へ直す。
// **id では突き合わせない。**入れ直しで変わるので、前後の比較が壊れる。
const keyOf = new Map<string, string>();
for (const r of await db.selectFrom("gleanery.knowledge").select(["id", "source_key"]).execute())
  keyOf.set(`k:${r.id}`, r.source_key);
for (const r of await db.selectFrom("gleanery.message").select("id").execute()) keyOf.set(`m:${r.id}`, r.id);

const rank = (hits: Hit[], expect: string[]): number =>
  hits.findIndex((h) => {
    const k = keyOf.get(h.ref);
    return k !== undefined && expect.includes(k);
  });

type Strategy = (c: Case) => Promise<Hit[]>;
const ship = (q: string, kinds?: string[]) =>
  searchKnowledge(db, env, { question: q, projects: null, limit: K, ...(kinds ? { kinds } : {}) });

const strategies: Record<string, Strategy> = {
  "出荷: recall（知識）": (c) =>
    c.source === "message"
      ? Promise.resolve([])
      : ship(c.q, c.kind === "document" ? ["document"] : undefined),
  "出荷: recall（発言）": (c) =>
    c.source === "message"
      ? searchMessages(db, env, { question: c.q, projects: null, limit: K })
      : Promise.resolve([]),
  // 原因の切り分け用。出荷の経路ではないが、前後で同じコードなので比較には使える。
  "参考: 語彙のみ": async (c) => (c.source === "message" ? [] : await lexicalOnly(c.q)),
  "参考: 意味のみ": async (c) => (c.source === "message" ? [] : await denseOnly(c.q)),
  "参考: 融合（rerank 無し）": async (c) =>
    c.source === "message" ? [] : fuse([await denseOnly(c.q), await lexicalOnly(c.q)]).slice(0, K),
};

async function lexicalOnly(q: string): Promise<Hit[]> {
  const { tsquery } = await import("../src/text.ts");
  const words = tsquery(q);
  if (!words) return [];
  const rows = await db
    .selectFrom("gleanery.knowledge as k")
    .select(["k.id", "k.kind", "k.status", "k.stance", "k.heading", "k.body", "k.reason", "k.occurred_at"])
    .where(sql<boolean>`k.lexemes @@ ${words}::tsquery`)
    .orderBy(sql`ts_rank_cd(k.lexemes, ${words}::tsquery)`, "desc")
    .limit(K)
    .execute();
  return rows.map(bare);
}

async function denseOnly(q: string): Promise<Hit[]> {
  const { embed, vec } = await import("../src/db.ts");
  const qv = (await embed(env, [q], "query"))[0];
  if (!qv) return [];
  const rows = await db
    .selectFrom("gleanery.knowledge as k")
    .innerJoin("gleanery.knowledge_embedding as e", (j) =>
      j.onRef("e.knowledge_id", "=", "k.id").on("e.status", "=", "ready"),
    )
    .select(["k.id", "k.kind", "k.status", "k.stance", "k.heading", "k.body", "k.reason", "k.occurred_at"])
    .orderBy(sql`e.embedding operator(extensions.<#>) ${vec(qv)}::extensions.halfvec`)
    .limit(K)
    .execute();
  return rows.map(bare);
}

/** 参考の系列は順位しか見ないので、Hit の形だけ整える。 */
function bare(r: {
  id: string | number;
  kind: string;
  status: string | null;
  stance: string;
  heading: string | null;
  body: string;
  reason: string | null;
  occurred_at: Date;
}): Hit {
  return {
    ref: `k:${r.id}`,
    kind: r.kind,
    status: r.status,
    stance: r.stance as Hit["stance"],
    label: "",
    heading: r.heading,
    text: r.body,
    reason: r.reason,
    confirmation: null,
    downsides: [],
    successor: null,
    project: "",
    at: r.occurred_at,
    speaker: null,
    context: null,
    url: null,
    truncated: false,
    originalBytes: null,
    relevance: null,
  };
}

const table: Record<string, Record<string, string | number>> = {};
const perCase: Record<string, Record<string, number | "—">> = {};
for (const [name, fn] of Object.entries(strategies)) {
  let hit1 = 0,
    hitK = 0,
    mrr = 0,
    ms = 0,
    n = 0;
  for (const c of cases) {
    const t0 = Date.now();
    const hits = await fn(c);
    if (
      hits.length === 0 &&
      ((name.includes("知識") && c.source === "message") ||
        (name.includes("発言") && c.source !== "message") ||
        (name.startsWith("参考") && c.source === "message"))
    )
      continue;
    ms += Date.now() - t0;
    n++;
    const i = rank(hits, c.expect);
    if (i === 0) hit1++;
    if (i >= 0) {
      hitK++;
      mrr += 1 / (i + 1);
    }
    const row = perCase[c.q] ?? {};
    perCase[c.q] = row;
    row[name] = i < 0 ? "—" : i + 1;
  }
  if (n === 0) continue;
  table[name] = {
    問: n,
    top1: `${((hit1 / n) * 100).toFixed(0)}%`,
    [`recall@${K}`]: `${((hitK / n) * 100).toFixed(0)}%`,
    MRR: (mrr / n).toFixed(3),
    平均ms: Math.round(ms / n),
  };
}

const total = await db.selectFrom("gleanery.knowledge").select(db.fn.countAll().as("n")).executeTakeFirst();
console.log(`問い ${cases.length} 件 / knowledge ${total?.n ?? 0} 件\n`);
console.table(table);

console.log("\n=== 種別ごとの recall@5（出荷の経路） ===");
const byKind: Record<string, { hit: number; n: number }> = {};
for (const c of cases) {
  const name = c.source === "message" ? "出荷: recall（発言）" : "出荷: recall（知識）";
  const b = byKind[c.kind] ?? { hit: 0, n: 0 };
  byKind[c.kind] = b;
  b.n++;
  if (perCase[c.q]?.[name] !== "—" && perCase[c.q]?.[name] !== undefined) b.hit++;
}
console.table(
  Object.fromEntries(
    Object.entries(byKind).map(([k, v]) => [
      k,
      { 問: v.n, "recall@5": `${((v.hit / v.n) * 100).toFixed(0)}%` },
    ]),
  ),
);

const missed = cases.filter((c) => {
  const name = c.source === "message" ? "出荷: recall（発言）" : "出荷: recall（知識）";
  return perCase[c.q]?.[name] === "—";
});
if (missed.length) {
  console.log(`\n=== 上位 ${K} に入らなかった ${missed.length} 問 ===`);
  for (const c of missed) console.log(`  [${c.kind}] ${c.q}  → 正解 ${c.expect[0]}`);
}
await db.destroy();
