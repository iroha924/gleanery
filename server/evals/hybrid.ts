#!/usr/bin/env node
// ベクトルだけ／語彙だけ／融合／融合+再ランクを、同じ質問に当てて比べる。
//
// **前回の判断を測り直すために書いた。**当時は「pgroonga_score が全行に 1 を返すので
// 順位が付かない」と観測してハイブリッドを見送ったが、それはノード 127 件のときの話で、
// いま（26,000 件）は得点が 1〜40 に分布する。データが変わったので結論を測り直す。
//
// 正解は「その質問の答えに必ず出てくる語」で判定する。key で指定しないのは、
// 同じことが PR 本体・レビュー・issue の複数の node に書かれていて、どれでも正解だから。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, embed, loadEnv, vec } from "../src/db.ts";
import { labelOf } from "../src/search.ts";

type Case = { q: string; must: string[]; type: string };
type Row = { key: string; record_id: string; kind: string; subkind: string | null; text: string; ex: string };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(fs.readFileSync(path.join(HERE, "hybrid.json"), "utf8")) as { cases: Case[] };
const env = loadEnv(process.cwd());
const c = await connect(env);

const K = 5;
const POOL = 30;

const hit = (rows: Row[], must: string[], k: number): number => {
  for (let i = 0; i < Math.min(k, rows.length); i++) {
    const t = `${rows[i]?.text ?? ""} ${rows[i]?.ex ?? ""}`.toLowerCase();
    if (must.some((m) => t.includes(m.toLowerCase()))) return i + 1;
  }
  return 0;
};

const COLS = `key, record_id, kind, subkind, text,
              coalesce(attrs->>'whyNot', attrs->>'context','') ex`;

async function vector(qv: number[], limit: number): Promise<Row[]> {
  const r = await c.query<Row>(
    `select ${COLS} from node where deleted_at is null
     order by embedding <#> $1::extensions.vector limit $2`,
    [vec(qv), limit],
  );
  return r.rows;
}

// **質問文をそのまま渡さない。**`&@~` は文全体を 1 つの式として扱うので 0 件になる。
const STOP = new Set([
  "ため",
  "こと",
  "もの",
  "とき",
  "など",
  "これ",
  "それ",
  "どこ",
  "どれ",
  "なに",
  "ある",
  "する",
  "どう",
  "何を",
  "何の",
  "使う",
  "決まった",
  "気をつける",
]);
const terms = (q: string): string[] =>
  (q.match(/[A-Za-z][A-Za-z0-9_.#-]{2,}|[ァ-ヴー]{2,}|[一-龠]{2,}|OT-\d+|#\d+/g) ?? [])
    .filter((t) => !STOP.has(t))
    .slice(0, 8);

async function lexical(q: string, limit: number): Promise<Row[]> {
  const ts = terms(q);
  if (!ts.length) return [];
  const r = await c.query<Row>(
    `select ${COLS}, pgroonga_score(tableoid, ctid) as score
     from node where deleted_at is null and text &@~ $1
     order by score desc, key limit $2`,
    [ts.map((t) => JSON.stringify(t)).join(" OR "), limit],
  );
  return r.rows;
}

/** Reciprocal Rank Fusion。尺度の違う 2 つを順位だけで混ぜる。 */
function rrf(lists: Row[][], k = 60): Row[] {
  const acc = new Map<string, { row: Row; s: number }>();
  for (const list of lists) {
    list.forEach((row, i) => {
      // key は記録の中でしか一意でない。記録をまたぐと潰れる。
      const id = `${row.record_id}|${row.kind}|${row.key}`;
      const cur = acc.get(id) ?? { row, s: 0 };
      cur.s += 1 / (k + i + 1);
      acc.set(id, cur);
    });
  }
  return [...acc.values()].sort((a, b) => b.s - a.s).map((x) => x.row);
}

async function rerank(q: string, rows: Row[], topK: number): Promise<Row[]> {
  if (!rows.length) return rows;
  const docs = rows.map((x) => (labelOf(x) + x.text + (x.ex ? ` — ${x.ex}` : "")).slice(0, 1500));
  const res = await fetch("https://api.voyageai.com/v1/rerank", {
    signal: AbortSignal.timeout(30_000),
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.VOYAGE_API_KEY}` },
    body: JSON.stringify({
      model: "rerank-3",
      query: q,
      documents: docs,
      top_k: Math.min(topK, docs.length),
    }),
  });
  if (!res.ok) throw new Error(`rerank が ${res.status}`);
  const j = (await res.json()) as { data: { index: number }[] };
  return j.data.map((d) => rows[d.index]).filter((x): x is Row => Boolean(x));
}

type Score = { name: string; r5: number; r10: number; mrr: number; miss: string[] };
const score = (name: string, ranks: number[], cs: Case[]): Score => ({
  name,
  r5: ranks.filter((r) => r > 0 && r <= 5).length / ranks.length,
  r10: ranks.filter((r) => r > 0 && r <= 10).length / ranks.length,
  mrr: ranks.reduce((a, r) => a + (r > 0 ? 1 / r : 0), 0) / ranks.length,
  miss: ranks.map((r, i) => (r === 0 ? (cs[i]?.q ?? "") : "")).filter(Boolean),
});

// **現行本番は「ベクトル+再ランク」。**そこを基準にしないと、効果を過大に見せることになる。
const runs: Record<string, number[]> = {
  ベクトル: [],
  語彙: [],
  "ベクトル+再ランク": [],
  融合: [],
  "融合+再ランク": [],
};
for (const cs of cases) {
  const [qv] = await embed(env, [cs.q], "query");
  if (!qv) throw new Error("埋め込みが空");
  const v = await vector(qv, POOL);
  const l = await lexical(cs.q, POOL);
  const f = rrf([v, l]);
  runs.ベクトル?.push(hit(v, cs.must, 10));
  runs.語彙?.push(hit(l, cs.must, 10));
  runs["ベクトル+再ランク"]?.push(hit(await rerank(cs.q, v.slice(0, POOL), K), cs.must, 10));
  runs.融合?.push(hit(f, cs.must, 10));
  runs["融合+再ランク"]?.push(hit(await rerank(cs.q, f.slice(0, POOL), K), cs.must, 10));
}

console.log(`${cases.length} 問\n`);
console.log("方式             recall@5  recall@10   MRR");
const results = Object.entries(runs).map(([n, r]) => score(n, r, cases));
for (const s of results) {
  console.log(
    `${s.name.padEnd(16)} ${(s.r5 * 100).toFixed(0).padStart(6)}%  ${(s.r10 * 100).toFixed(0).padStart(7)}%  ${s.mrr.toFixed(3)}`,
  );
}
// 種別ごとに、どこで効いたかを出す。
const types = [...new Set(cases.map((x) => x.type))];
console.log("\n種別ごとの recall@5");
console.log(`${"".padEnd(10)}${results.map((s) => s.name.padStart(14)).join("")}`);
for (const t of types) {
  const idx = cases.map((x, i) => (x.type === t ? i : -1)).filter((i) => i >= 0);
  const cells = Object.values(runs).map((r) => {
    const got = idx.filter((i) => (r[i] ?? 0) > 0 && (r[i] ?? 0) <= 5).length;
    return `${got}/${idx.length}`.padStart(14);
  });
  console.log(`${t.padEnd(10)}${cells.join("")}`);
}
const best = results.reduce((a, b) => (b.r5 > a.r5 ? b : a));
if (best.miss.length) console.log(`\n${best.name} でも取れなかった質問:\n  ${best.miss.join("\n  ")}`);
await c.end();
