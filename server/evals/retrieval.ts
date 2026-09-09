#!/usr/bin/env node
// 検索の精度を測る。目視ではなく、正解が分かる質問で数える。
//
// 測るのは recall@k（正解が上位 k に入った割合）と MRR（正解の順位の逆数の平均）。
// 方式を変えて同じ質問に当て、どれが効いてどれが効かないかを出す。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, embed, vec } from "../src/db.ts";
// **出荷している labelOf をそのまま使う。**eval 側で別の札を定義すると、
// 測っているのは出荷していない経路になる。
import { labelOf, search } from "../src/search.ts";

type Case = { q: string; kind: string; expect: string[] };
type Row = {
  key: string;
  kind: string;
  subkind: string | null;
  polarity: string;
  text: string;
  ex: string;
  record_id: string;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(fs.readFileSync(path.join(HERE, "retrieval.json"), "utf8")) as { cases: Case[] };
const env = (await import("../src/db.ts")).loadEnv(process.cwd());
// iterative_scan は connect() がセッションへ入れる。ここで足すと、
// 本番と違う設定で測ることになる（実際に食い違っていた）。
const c = await connect(env);

const K = 5;
const POOL = 30;

async function vectorSearch(qv: number[], limit: number): Promise<Row[]> {
  const r = await c.query<Row>(
    `select key, kind, subkind, polarity, text, record_id,
            coalesce(attrs->>'whyNot', attrs->>'context','') ex
     from node where deleted_at is null
     order by embedding <#> $1::extensions.vector limit $2`,
    [vec(qv), limit],
  );
  return r.rows;
}

// 日本語の語彙検索。ベクトルが苦手な「固有の語の完全一致」を埋める。
//
// **この行の top1 と MRR は読めない。**語彙側は候補集合を作るのが仕事で、順位は
// 後段の再ランクが付ける。ここから読めるのは recall@5、つまり
// **一致集合に正解が入るか**だけである。
//
// **質問文をそのまま渡してはいけない。**語ごとに分けて当てる。
// 「ドキュメントに使ってはいけない記号は？」を 1 つの式として投げると 0 件になる（実測）。
// 語に割ってから OR で繋ぐ。
const STOP = [
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
  "いけない",
  "ある",
  "する",
  "どう",
  "やる",
  "決めた",
  "使って",
];
function terms(q: string): string[] {
  return (
    (q.match(/[A-Za-z][A-Za-z0-9_.-]{2,}|[ぁ-んァ-ヴー]{2,}|[一-龠]{2,}|[ァ-ヴー]{2,}/g) ?? [])
      // 助詞や汎用語だけになった語は落とす。全体に当たって順位を壊す。
      .filter((t) => !STOP.includes(t))
      .slice(0, 8)
  );
}

async function lexicalSearch(q: string, limit: number): Promise<Row[]> {
  const ts = terms(q);
  if (ts.length === 0) return [];
  const r = await c.query<Row>(
    `select key, kind, subkind, polarity, text, record_id,
            coalesce(attrs->>'whyNot', attrs->>'context','') ex,
            (select max(extensions.similarity(text, w)) from unnest($1::text[]) as w) as score
     from node
     where deleted_at is null
       and exists (select 1 from unnest($1::text[]) as w where text ilike '%' || w || '%')
     order by score desc nulls last, key limit $2`,
    [ts, limit],
  );
  return r.rows;
}

// Reciprocal Rank Fusion。スコアの尺度が違う 2 つを混ぜる標準的な方法。
function rrf(lists: Row[][], k = 60): Row[] {
  // key は記録の中でしか一意でない。記録をまたいで同じ key があるので、
  // key だけで束ねると別の記録の行が 1 つに潰れる。
  const acc = new Map<string, { row: Row; s: number }>();
  for (const list of lists) {
    list.forEach((row, i) => {
      const id = `${row.record_id}|${row.kind}|${row.key}`;
      const cur = acc.get(id) ?? { row, s: 0 };
      cur.s += 1 / (k + i + 1);
      acc.set(id, cur);
    });
  }
  return [...acc.values()].sort((a, b) => b.s - a.s).map((x) => x.row);
}

async function rerank(q: string, rows: Row[], topK: number, model = "rerank-3"): Promise<Row[]> {
  if (rows.length === 0) return rows;
  const docs = rows.map((x) => (labelOf(x) + x.text + (x.ex ? ` — ${x.ex}` : "")).slice(0, 1500));
  const res = await fetch("https://api.voyageai.com/v1/rerank", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.VOYAGE_API_KEY}` },
    body: JSON.stringify({ model, query: q, documents: docs, top_k: Math.min(topK, rows.length) }),
  });
  if (!res.ok) throw new Error(`rerank ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { data: { index: number }[] };
  return j.data.flatMap((d) => {
    const row = rows[d.index];
    return row ? [row] : [];
  });
}

const strategies: Record<string, (q: string, qv: number[], cs: Case) => Promise<{ key: string }[]>> = {
  ベクトルのみ: async (_q, qv) => vectorSearch(qv, K),
  "語彙のみ(pg_trgm)": async (q) => lexicalSearch(q, K),
  "ハイブリッド(RRF)": async (q, qv) =>
    rrf([await vectorSearch(qv, POOL), await lexicalSearch(q, POOL)]).slice(0, K),
  "ベクトル+rerank-3": async (q, qv) => rerank(q, await vectorSearch(qv, POOL), K),
  "ハイブリッド+rerank-3": async (q, qv) =>
    rerank(q, rrf([await vectorSearch(qv, POOL), await lexicalSearch(q, POOL)]).slice(0, POOL), K),
  "ハイブリッド+rerank-2.5": async (q, qv) =>
    rerank(
      q,
      rrf([await vectorSearch(qv, POOL), await lexicalSearch(q, POOL)]).slice(0, POOL),
      K,
      "rerank-2.5",
    ),
  // **出荷している関数そのものを測る。**上の系列は eval が組み立てた経路であって、
  // MCP が実際に呼ぶものではない。順位の比較には使えるが、水準はこちらでしか分からない。
  "出荷: search()": async (q) => (await search(c, env, { question: q, limit: K })).rows,
  // 出荷時に掛かるフィルタ付き。否定形の 6 問はこの経路で引かれる。
  "出荷: dont 絞り込み": async (q, _qv, cs) =>
    (
      await search(
        c,
        env,
        cs.kind === "否定形" ? { question: q, limit: K, polarity: "dont" } : { question: q, limit: K },
      )
    ).rows,
};

const results: Record<string, Record<string, string | number>> = {};
const perCase: Record<string, Record<string, number | "—">> = {};
for (const [name, fn] of Object.entries(strategies)) {
  let hit1 = 0;
  let hitK = 0;
  let mrrSum = 0;
  let ms = 0;
  for (const cs of cases) {
    const qv = (await embed(env, [cs.q], "query"))[0];
    if (!qv) throw new Error("埋め込みが空");
    const t0 = Date.now();
    const rows = await fn(cs.q, qv, cs);
    ms += Date.now() - t0;
    const idx = rows.findIndex((r) => cs.expect.includes(r.key));
    if (idx === 0) hit1++;
    if (idx >= 0 && idx < K) {
      hitK++;
      mrrSum += 1 / (idx + 1);
    }
    let row = perCase[cs.q];
    if (!row) {
      row = {};
      perCase[cs.q] = row;
    }
    row[name] = idx < 0 ? "—" : idx + 1;
  }
  const n = cases.length;
  results[name] = {
    top1: `${((hit1 / n) * 100).toFixed(0)}%`,
    [`recall@${K}`]: `${((hitK / n) * 100).toFixed(0)}%`,
    MRR: (mrrSum / n).toFixed(3),
    平均ms: Math.round(ms / n),
  };
}

const total = await c.query<{ n: number }>("select count(*)::int n from node where deleted_at is null");
console.log(`質問 ${cases.length} 件 / node ${total.rows[0]?.n ?? 0} 件\n`);
console.table(results);
console.log("※ 「語彙のみ(pg_trgm)」と「ハイブリッド」の top1 / MRR は順位として読めない。");
console.log("   語彙側は候補集合を作るのが仕事で、順位は後段の再ランクが付ける。読めるのは recall@5 だけ。");

console.log("\n=== 種別ごとの recall@5 ===");
const byKind: Record<string, Record<string, { hit: number; n: number }>> = {};
for (const cs of cases) {
  for (const name of Object.keys(strategies)) {
    let kind = byKind[cs.kind];
    if (!kind) {
      kind = {};
      byKind[cs.kind] = kind;
    }
    let bucket = kind[name];
    if (!bucket) {
      bucket = { hit: 0, n: 0 };
      kind[name] = bucket;
    }
    bucket.n++;
    if (perCase[cs.q]?.[name] !== "—") bucket.hit++;
  }
}
console.table(
  Object.fromEntries(
    Object.entries(byKind).map(([k, v]) => [
      k,
      Object.fromEntries(Object.entries(v).map(([n, x]) => [n, `${x.hit}/${x.n}`])),
    ]),
  ),
);

console.log("\n=== 外した質問（最良の方式でも上位 5 に入らなかったもの）===");
const best = "ハイブリッド+rerank-3";
let missed = 0;
for (const cs of cases) {
  if (perCase[cs.q]?.[best] === "—") {
    console.log(`  [${cs.kind}] ${cs.q}\n      期待: ${cs.expect.join(", ")}`);
    missed++;
  }
}
if (missed === 0) console.log("  無し");

await c.end();
