#!/usr/bin/env node
// 語彙アームの候補選抜だけを測る。
//
// **recall@5 では見えない壊れ方があるから作った。**出荷経路の recall@5 は 20 問しか無く、
// 1 問が 5% を動かす。2026-09-09 に「並び順を変えたら 95% → 90%」を追ったところ、
// 落ちた 1 問の正解は `node.id` = 84（DB で 2 番目に古い行）で、質問から取れる語は
// 「意図」「箇所」の 2 つ、一致したのは 3,176 行中 233 行だった。
// **当たっていたのは順位付けではなく、正解がたまたま最古の側にあったからである。**
//
// ここで測るのは端から端までの精度ではなく、`pool` 件で切る前後の順位そのもの。
// 正解が候補集合に残るかは並び順で決まり、その決まり方はコーパスが伸びると変わる。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, loadEnv } from "../src/db.ts";
import { DEFAULT_EXCLUDED, ILIKE_PATTERN, lexicalTerms } from "../src/search.ts";

const POOL = 30;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const cases: Array<{ q: string; expect: string[]; kind: string }> = JSON.parse(
  fs.readFileSync(path.join(HERE, "retrieval.json"), "utf8"),
).cases;

const c = await connect(loadEnv(process.cwd()), { as: "read" });

type Row = { id: number; key: string; kind: string; hits: number; len: number };

/** 出荷経路と同じ絞り込みで、一致した行を全部返す（`limit` を掛けない）。 */
async function matched(words: string[]): Promise<Row[]> {
  const r = await c.query<{ id: string; key: string; kind: string; hits: string; len: string }>(
    `select n.id::text, n.key, n.kind, m.hits::text, length(n.text)::text as len
     from node n
     cross join lateral (
       select count(*) as hits from unnest($1::text[]) as t
       where n.text ilike ${ILIKE_PATTERN}
     ) m
     where n.deleted_at is null and ${DEFAULT_EXCLUDED.join(" and ")} and m.hits > 0`,
    [words],
  );
  return r.rows.map((x) => ({
    id: Number(x.id),
    key: x.key,
    kind: x.kind,
    hits: Number(x.hits),
    len: Number(x.len),
  }));
}

const ORDERS: Record<string, (a: Row, b: Row) => number> = {
  "id昇順(最古)": (a, b) => a.id - b.id,
  "id降順(最新)": (a, b) => b.id - a.id,
  "hits降+id降": (a, b) => b.hits - a.hits || b.id - a.id,
  "hits降+短い順(出荷)": (a, b) => b.hits - a.hits || a.len - b.len || b.id - a.id,
  短い順: (a, b) => a.len - b.len,
  "hits/長さ降順": (a, b) => b.hits / b.len - a.hits / a.len,
};

/** 並べたときの、正解の最良順位（1 始まり）。正解が一致していなければ null。 */
const rankOf = (rows: Row[], cmp: (a: Row, b: Row) => number, want: string[]): number | null => {
  const i = [...rows].sort(cmp).findIndex((r) => want.includes(r.key));
  return i < 0 ? null : i + 1;
};

const orders = Object.entries(ORDERS);
const inPool = new Map(orders.map(([n]) => [n, 0]));
let reachable = 0;
const noise: string[] = [];

console.log(`\n=== 語彙アームの候補選抜（pool=${POOL}、${cases.length} 問）===\n`);
console.log(
  `${"問い".padEnd(30)} ${"一致".padStart(5)} ${"正解の古さ".padStart(10)}  ${orders
    .map(([n]) => n.padStart(16))
    .join(" ")}`,
);

for (const cs of cases) {
  const words = lexicalTerms(cs.q);
  const rows = words.length ? await matched(words) : [];
  const hit = rows.find((r) => cs.expect.includes(r.key));
  const q = cs.q.length > 28 ? `${cs.q.slice(0, 27)}…` : cs.q;
  if (!hit) {
    console.log(
      `${q.padEnd(30)} ${String(rows.length).padStart(5)} ${"—".padStart(10)}  ${"語彙側に無い".padStart(16)}`,
    );
    continue;
  }
  reachable++;
  const byKind = [
    ...rows.reduce((m, r) => m.set(r.kind, (m.get(r.kind) ?? 0) + 1), new Map<string, number>()),
  ]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, n]) => `${k}${n}`)
    .join(" ");
  noise.push(
    `  ${(cs.q.length > 24 ? `${cs.q.slice(0, 23)}…` : cs.q).padEnd(26)} 一致 ${String(rows.length).padStart(4)}  ${byKind}  / 正解 ${hit.kind} ${hit.hits}語 ${hit.len}字`,
  );
  // 一致した行のうち、正解より古いものの割合。**`id昇順` の順位はこれで決まる。**
  const older = rows.filter((r) => r.id < hit.id).length;
  const pct = Math.round((older / Math.max(rows.length - 1, 1)) * 100);
  const cells = orders.map(([n, cmp]) => {
    const rank = rankOf(rows, cmp, cs.expect);
    if (rank !== null && rank <= POOL) inPool.set(n, (inPool.get(n) ?? 0) + 1);
    return `${rank === null ? "—" : `${rank}位${rank <= POOL ? "" : " ✗"}`}`.padStart(16);
  });
  console.log(
    `${q.padEnd(30)} ${String(rows.length).padStart(5)} ${`${pct}%`.padStart(10)}  ${cells.join(" ")}`,
  );
}

console.log(`\n語彙側に正解が一致した問い: ${reachable} / ${cases.length}`);
for (const [n, k] of inPool) {
  console.log(`  ${n.padEnd(18)} pool に残った ${k} / ${reachable}`);
}
console.log(`
「正解の古さ」は、一致した行のうち正解より古いものの割合。
**\`id昇順\` の順位はこの値と一致件数の積で決まる**ので、コーパスが伸びると
古さ 0% に近い記録（＝新しく取り込んだもの）から順に pool から落ちる。
いまのコーパスで落ちていないのは、問いの正解が古い側に偏っているからにすぎない。`);

console.log(`\n=== 一致行の内訳（何が候補を埋めているか）===`);
for (const l of noise) console.log(l);

await c.end();
