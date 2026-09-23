#!/usr/bin/env node
// 検索の精度を測る。目視ではなく、正解が分かる問いで数える。
//
// **出荷している関数そのものを測る。**eval が組み立てた経路は原因の切り分けにしか使わない。
// 測るのは recall@k（正解が上位 k に入った割合）と MRR（正解の順位の逆数の平均）と top1。
//
// **持ち主の記録を読むので `bun run verify` に入れない。**手で叩く（`bun run evals:retrieval`）。
// DB は `GLEANERY_DB` で指せる（評価用に写した SQLite を測るとき）。
// 比較したいときは、変更の前後で同じ retrieval.json を使う。問いを作り直すと比較にならない。
//
// これは agent を通らない一発の検索を測る。agent にツールとして使わせた精度は agentic/run.ts が測り、そこでは
// 知識の問いを偶数番（開発用）と奇数番（検証用、ゲートでだけ流す）に分けている。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openReader } from "../src/db.ts";
import { type Hit, searchKnowledge, searchMessages, searchSplit } from "../src/search.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Case = { q: string; expect: string[]; kind: string; source: string };
const { cases } = JSON.parse(fs.readFileSync(path.join(HERE, "retrieval.json"), "utf8")) as { cases: Case[] };

const K = 5;
const db = openReader();

// ref（k:12 / m:uuid）から、正解と突き合わせる鍵へ直す。
// **id では突き合わせない。**入れ直しで変わるので、前後の比較が壊れる。
const keyOf = new Map<string, string>();
// **出所は指標として持つ。**同じファイルの節や同じ作業の記録が上位を埋めていないかを、
// top1 や recall と一緒に毎回出す（手元の一回限りの測定にすると、次に誰も再現できない）。
const originOf = new Map<string, string>();
for (const r of await db
  .selectFrom("knowledge as k")
  .leftJoin("source_item as s", "s.id", "k.source_item_id")
  .select(["k.id", "k.source_key", "k.work_item_id", "s.path"])
  .execute()) {
  keyOf.set(`k:${r.id}`, r.source_key);
  originOf.set(
    `k:${r.id}`,
    r.path ??
      (r.work_item_id !== null ? `work:${r.work_item_id}` : (r.source_key.split("#")[0] ?? `k:${r.id}`)),
  );
}
for (const r of await db.selectFrom("message").select("id").execute()) keyOf.set(`m:${r.id}`, r.id);

const rank = (hits: Hit[], expect: string[]): number =>
  hits.findIndex((h) => {
    const k = keyOf.get(h.ref);
    return k !== undefined && expect.includes(k);
  });

type Strategy = (c: Case) => Promise<Hit[]>;

// `gleanery search` と端末の画面と同じ関数・同じ並び（種類を省けば判断の記録の後に文書の節）。
const strategies: Record<string, Strategy> = {
  "出荷: 一発の検索（知識）": async (c) => {
    if (c.source === "message") return [];
    if (c.kind === "document")
      return searchKnowledge(db, { question: c.q, projects: null, kinds: ["document"], limit: K });
    const { records, documents } = await searchSplit(db, { question: c.q, projects: null, limit: K });
    return [...records, ...documents];
  },
  "出荷: 一発の検索（発言）": (c) =>
    c.source === "message"
      ? searchMessages(db, { question: c.q, projects: null, limit: K })
      : Promise.resolve([]),
};

const table: Record<string, Record<string, string | number>> = {};
const perCase: Record<string, Record<string, number | "—">> = {};
for (const [name, fn] of Object.entries(strategies)) {
  let hit1 = 0,
    hitK = 0,
    mrr = 0,
    ms = 0,
    n = 0,
    crowded = 0,
    kinds = 0,
    spread = 0;
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
    if (name.startsWith("出荷") && c.source !== "message") {
      const by = new Map<string, number>();
      for (const h of hits) {
        const o = originOf.get(h.ref) ?? h.ref;
        by.set(o, (by.get(o) ?? 0) + 1);
      }
      kinds += by.size;
      if (Math.max(0, ...by.values()) >= 3) crowded++;
      spread++;
    }
  }
  if (n === 0) continue;
  // 上位に同じ出所が並んでいないか。出荷の経路（知識）だけで数える。
  const diversity: Record<string, string> =
    spread > 0
      ? {
          "同じ出所 3 件以上": `${((crowded / spread) * 100).toFixed(0)}%`,
          出所の種類: (kinds / spread).toFixed(1),
        }
      : {};
  table[name] = {
    ...diversity,
    問: n,
    top1: `${((hit1 / n) * 100).toFixed(0)}%`,
    [`recall@${K}`]: `${((hitK / n) * 100).toFixed(0)}%`,
    MRR: (mrr / n).toFixed(3),
    平均ms: Math.round(ms / n),
  };
}

const total = await db.selectFrom("knowledge").select(db.fn.countAll().as("n")).executeTakeFirst();
console.log(`問い ${cases.length} 件 / knowledge ${total?.n ?? 0} 件\n`);
console.table(table);

console.log("\n=== 種別ごとの recall@5（出荷の経路） ===");
const byKind: Record<string, { hit: number; n: number }> = {};
for (const c of cases) {
  const name = c.source === "message" ? "出荷: 一発の検索（発言）" : "出荷: 一発の検索（知識）";
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
  const name = c.source === "message" ? "出荷: 一発の検索（発言）" : "出荷: 一発の検索（知識）";
  return perCase[c.q]?.[name] === "—";
});
if (missed.length) {
  console.log(`\n=== 上位 ${K} に入らなかった ${missed.length} 問 ===`);
  for (const c of missed) console.log(`  [${c.kind}] ${c.q}  → 正解 ${c.expect[0]}`);
}
await db.destroy();
