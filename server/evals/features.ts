#!/usr/bin/env node
// Checks the exact-match features (substring, phrase, prefix, regex) of features.json against a reference scan of the measured DB.
// The reference is plain JavaScript over heading, body, and reason, so it shares no code with the search it checks.
//   GLEANERY_DB=<copy> bun run evals:features -- [--split dev|holdout] [--use phrase=phrase --use prefix=prefix --use regex=regex]
// --use says which recall match value a setup offers for a feature; without it, substring and phrase go to exact and prefix and regex to words.
// Two values are not match values: quoted sends `"pattern"` and star sends `pattern*`, both in words mode (for setups that read that syntax).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openReader } from "../src/db.ts";
import { KINDS } from "../src/knowledge.ts";
import { searchKnowledge } from "../src/search.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Feature = "substring" | "phrase" | "prefix" | "regex";
type Case = { type: Feature; pattern: string };
const LIMIT = 10;

const { values } = parseArgs({
  options: { split: { type: "string", default: "dev" }, use: { type: "string", multiple: true } },
});
const use: Record<Feature, string> = { substring: "exact", phrase: "exact", prefix: "words", regex: "words" };
for (const u of values.use ?? []) {
  const [f, m] = u.split("=");
  if (!f || !m || !(f in use)) throw new Error(`--use takes <feature>=<match> (${u})`);
  use[f as Feature] = m;
}
const cases = (
  JSON.parse(fs.readFileSync(path.join(HERE, "features.json"), "utf8")) as { cases: Case[] }
).cases.filter((_, i) => (values.split === "holdout" ? i % 2 === 1 : i % 2 === 0));

const db = openReader();
const rows = await db
  .selectFrom("knowledge")
  .select(["id", "kind", "status", "heading", "body", "reason"])
  .execute();
// The same records normal search may return (search.ts knowledgeFilters without the kind filter)
const live = rows.filter(
  (r) =>
    !(r.kind === "option" && (r.status === "chosen" || r.status === "was_chosen")) &&
    !(r.kind === "decision" && r.status === "superseded") &&
    r.status !== "retired" &&
    r.status !== "resolved",
);
// Spaces between two non-ASCII characters carry no meaning in Japanese text (a spaced phrase equals the unspaced one)
const flat = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .replace(/(?<=[^\p{ASCII}]) (?=[^\p{ASCII}])/gu, "")
    .toLowerCase();
const texts = live.map((r) => ({
  ref: `k:${r.id}`,
  text: [r.heading ?? "", r.body, r.reason ?? ""].join("\n"),
}));
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function reference(c: Case): Set<string> {
  const test =
    c.type === "regex"
      ? (t: string) => new RegExp(c.pattern, "i").test(t)
      : c.type === "prefix"
        ? (t: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${literal(c.pattern)}`, "iu").test(t)
        : (t: string) => flat(t).includes(flat(c.pattern));
  return new Set(texts.filter((t) => test(t.text)).map((t) => t.ref));
}

type Row = { precision: number; recall: number; ms: number };
const by = new Map<Feature, Row[]>();
const misses: string[] = [];
for (const c of cases) {
  const want = reference(c);
  const t0 = performance.now();
  let got: string[] = [];
  let error = "";
  try {
    const how = use[c.type];
    const hits = await searchKnowledge(db, {
      question: how === "quoted" ? `"${c.pattern}"` : how === "star" ? `${c.pattern}*` : c.pattern,
      projects: null,
      kinds: [...KINDS],
      // A setup that lacks a match value fails here, which counts as finding nothing
      match: (how === "quoted" || how === "star" ? "words" : how) as "words" | "exact",
      limit: LIMIT,
    });
    got = hits.map((h) => h.ref);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const ms = performance.now() - t0;
  const right = got.filter((r) => want.has(r)).length;
  const precision = got.length ? right / got.length : want.size ? 0 : 1;
  const recall = want.size ? right / Math.min(want.size, LIMIT) : got.length ? 0 : 1;
  by.set(c.type, [...(by.get(c.type) ?? []), { precision, recall, ms }]);
  if (precision < 1 || recall < 1)
    misses.push(
      `  [${c.type} via ${use[c.type]}] ${c.pattern}: ${right} right of ${got.length} returned, ${want.size} in the DB${error ? ` (${error})` : ""}`,
    );
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
console.table(
  Object.fromEntries(
    [...by].map(([f, rs]) => [
      `${f} via ${use[f]}`,
      {
        cases: rs.length,
        precision: `${Math.round(mean(rs.map((r) => r.precision)) * 100)}%`,
        recall: `${Math.round(mean(rs.map((r) => r.recall)) * 100)}%`,
        "mean ms": Math.round(mean(rs.map((r) => r.ms)) * 10) / 10,
      },
    ]),
  ),
);
if (misses.length) console.log(`\n${misses.join("\n")}`);
await db.destroy();
