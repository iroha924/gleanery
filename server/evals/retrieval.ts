#!/usr/bin/env node

// Measures search accuracy by counting over questions with known answers, not by eye.
//
// **Measures the shipped functions themselves.** Paths built by the eval are only for isolating causes.
// It measures recall@k (share of answers in the top k), MRR (mean reciprocal rank of the answer), and top1.
//
// **It reads the owner's records, so it is not part of `bun run verify`.** Run it by hand (`bun run evals:retrieval`).
// Point `GLEANERY_DB` at a database (for measuring a SQLite copy made for evaluation).
// To compare, use the same retrieval.json and the same DB copy before and after a change. Rebuilt questions are not comparable,
// and a different DB scores a different set (questions whose answer is missing are listed, not scored).
//
// This measures one-shot search without an agent. agentic/run.ts measures accuracy when an agent uses the tools, and
// splits knowledge questions into even indexes (development) and odd indexes (validation, run only at the gate).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openReader } from "../src/db.ts";
import { type Hit, searchKnowledge, searchMessages, searchSplit } from "../src/search.ts";
import { fixedDb } from "./agentic/run.ts";
import { SPLITS, type Split, splitStale } from "./cases.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Case = { q: string; expect: string[]; kind: string; source: string };
// --split takes the same questions as the agentic eval. It defaults to dev, so holdout questions are read only when asked for (the gate)
const { values } = parseArgs({ options: { split: { type: "string", default: "dev" } } });
const split = values.split as Split;
if (!(split in SPLITS)) throw new Error(`--split must be one of ${Object.keys(SPLITS).join(" / ")}`);
const allCases = (
  JSON.parse(fs.readFileSync(path.join(HERE, "retrieval.json"), "utf8")) as { cases: Case[] }
).cases.filter((c, i) => SPLITS[split](c, i));

const K = 5;
const db = openReader(fixedDb());

// Maps a ref (k:12 / m:uuid) to the key used to match answers.
// **Do not match by id.** Ids change on reimport, which breaks before and after comparisons.
const keyOf = new Map<string, string>();
// **Source is tracked as a metric.** Every run reports whether sections of one file or records of one work item fill the top,
// alongside top1 and recall (a one-off local measurement is something nobody can reproduce later).
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
const { live: cases, stale } = splitStale(allCases, new Set(keyOf.values()));

const rank = (hits: Hit[], expect: string[]): number =>
  hits.findIndex((h) => {
    const k = keyOf.get(h.ref);
    return k !== undefined && expect.includes(k);
  });

type Strategy = (c: Case) => Promise<Hit[]>;

// The same functions and order as `gleanery search` and the terminal screen (without kinds, decision records come before document sections).
const strategies: Record<string, Strategy> = {
  "shipped: one-shot search (knowledge)": async (c) => {
    if (c.source === "message") return [];
    if (c.kind === "document")
      return searchKnowledge(db, { question: c.q, projects: null, kinds: ["document"], limit: K });
    const { records, documents } = await searchSplit(db, { question: c.q, projects: null, limit: K });
    return [...records, ...documents];
  },
  "shipped: one-shot search (messages)": (c) =>
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
      ((name.includes("knowledge") && c.source === "message") ||
        (name.includes("messages") && c.source !== "message") ||
        (name.startsWith("reference") && c.source === "message"))
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
    if (name.startsWith("shipped") && c.source !== "message") {
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
  // Whether one source crowds the top. Counted only on the shipped knowledge path.
  const diversity: Record<string, string> =
    spread > 0
      ? {
          "3+ from one source": `${((crowded / spread) * 100).toFixed(0)}%`,
          "distinct sources": (kinds / spread).toFixed(1),
        }
      : {};
  table[name] = {
    ...diversity,
    questions: n,
    top1: `${((hit1 / n) * 100).toFixed(0)}%`,
    [`recall@${K}`]: `${((hitK / n) * 100).toFixed(0)}%`,
    MRR: (mrr / n).toFixed(3),
    "mean ms": Math.round(ms / n),
  };
}

const total = await db.selectFrom("knowledge").select(db.fn.countAll().as("n")).executeTakeFirst();
console.log(`${cases.length} questions / ${total?.n ?? 0} knowledge records\n`);
if (stale.length) {
  console.log(`${stale.length} questions not scored: their answer is not in this DB`);
  for (const c of stale) console.log(`  [${c.kind}] ${c.q}  → expected ${c.expect[0]}`);
  console.log("");
}
console.table(table);

console.log("\n=== recall@5 by kind (shipped path) ===");
const byKind: Record<string, { hit: number; n: number }> = {};
for (const c of cases) {
  const name =
    c.source === "message" ? "shipped: one-shot search (messages)" : "shipped: one-shot search (knowledge)";
  const b = byKind[c.kind] ?? { hit: 0, n: 0 };
  byKind[c.kind] = b;
  b.n++;
  if (perCase[c.q]?.[name] !== "—" && perCase[c.q]?.[name] !== undefined) b.hit++;
}
console.table(
  Object.fromEntries(
    Object.entries(byKind).map(([k, v]) => [
      k,
      { questions: v.n, "recall@5": `${((v.hit / v.n) * 100).toFixed(0)}%` },
    ]),
  ),
);

const missed = cases.filter((c) => {
  const name =
    c.source === "message" ? "shipped: one-shot search (messages)" : "shipped: one-shot search (knowledge)";
  return perCase[c.q]?.[name] === "—";
});
if (missed.length) {
  console.log(`\n=== ${missed.length} questions missed the top ${K} ===`);
  for (const c of missed) console.log(`  [${c.kind}] ${c.q}  → expected ${c.expect[0]}`);
}
await db.destroy();
