#!/usr/bin/env node
// 答えの質を測る。**LLM に採点させない層を先に置く。**
//
// ここで見るのは 2 つだけ:
//   1. 引用の健全性 — 本文の [n] が根拠に実在するか。存在しない番号は捏造である
//   2. 語の含有 — 記録にある語が答えに出るか、出てはいけない語が出ていないか
//
// どちらも文字列の検査で、判定モデルも含意判定も要らない。壊れたら必ず壊れたと分かる。
// これを通さないうちに faithfulness のような主観指標へ進むと、
// 「番号が捏造されている」ことに気付けないまま点数だけが動く。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chat } from "../src/chat.ts";
import { connect, loadEnv } from "../src/db.ts";

type Word = string | string[];
type Case = { q: string; must?: Word[]; mustNot?: Word[]; noAnswer?: boolean };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(fs.readFileSync(path.join(HERE, "chat.json"), "utf8")) as { cases: Case[] };
const env = loadEnv(process.cwd());
const client = await connect(env, { as: "read" });

const scopeIds = (
  await client.query<{ id: number }>("select id::int as id from scope order by id limit 1")
).rows.map((r) => r.id);

type Row = {
  質問: string;
  引用: string;
  含む: string;
  含まない: string;
  ms: number;
  字: number;
};

const rows: Row[] = [];
let bad = 0;
let cost = 0;
let soft = 0;

for (const cs of cases) {
  const t0 = Date.now();
  let answer = "";
  let sourceCount = 0;
  for await (const chunk of chat(client, env, { question: cs.q, scopeIds })) {
    if (chunk.type === "sources") sourceCount = chunk.sources.length;
    else if (chunk.type === "text") answer += chunk.text;
    else cost += chunk.question;
  }
  const ms = Date.now() - t0;

  // 1. 引用の健全性
  // **数字以外の引用も認める。**指示で [全体像] を許しているので、
  // 数字だけを引用とみなすと、指示に従った答えを不合格にしてしまう（実測で誤検出した）。
  const marks = [...answer.matchAll(/\[([^\]]{1,8})\]/g)].map((m) => m[1] ?? "");
  const nums = marks.filter((m) => /^\d+$/.test(m)).map(Number);
  const fabricated = [...new Set(nums)].filter((n) => n < 1 || n > sourceCount);
  const citeOk = fabricated.length === 0 && (cs.noAnswer || marks.length > 0 || sourceCount === 0);

  // 2. 語の含有
  // 一語の完全一致は脆い。言い回しが変わるだけで落ちる（実測: 「外した」対「使わないと決めています」）。
  // 「どれか 1 つ含めばよい」を候補の配列で表す。
  const has = (w: string | string[]) =>
    Array.isArray(w) ? w.some((x) => answer.includes(x)) : answer.includes(w);
  const missing = (cs.must ?? []).filter((w) => !has(w)).map((w) => (Array.isArray(w) ? w[0] : w));
  const forbidden = (cs.mustNot ?? []).filter((w) => has(w)).map((w) => (Array.isArray(w) ? w[0] : w));

  // **合否は引用の健全性だけで決める。**
  // 語句の一致は言い回しで揺れる（実測: 同じ質問で実行ごとに落ちる件が変わった）。
  // 揺れる指標を合否にすると、直っていないのに通ったり、正しいのに落ちたりする。
  // 語句は「気付くための目印」として表に出すだけにする。
  if (!citeOk) bad++;
  if (missing.length || forbidden.length) soft++;
  rows.push({
    質問: cs.q.slice(0, 26),
    引用: citeOk ? `✓ ${marks.length}` : fabricated.length ? `✗ 捏造 ${fabricated.join(",")}` : "✗ 引用なし",
    含む: missing.length ? `✗ ${missing.join(",")}` : "✓",
    含まない: forbidden.length ? `✗ ${forbidden.join(",")}` : "✓",
    ms,
    字: answer.length,
  });
}

console.table(rows);
const t = rows.length;
console.log(`\n引用の健全性: ${t - bad} / ${t} 件が通過（これが合否）`);
console.log(`語句の目印  : ${t - soft} / ${t} 件が一致（揺れるので合否にしない）`);
console.log(`平均 ${Math.round(rows.reduce((a, r) => a + r.ms, 0) / t)} ms / 費用 $${cost.toFixed(4)}`);
console.log("\n※ 合否にしているのは引用の健全性だけ — 本文の [n] が根拠に実在するか。");
console.log("   これは決定的に測れる。答えが正しいかは測っていない。");
console.log("   n=8 では方式の差も検出できない（19/20 の 95% 信頼区間は [0.76, 0.99]）。");
await client.end();
process.exit(bad === 0 ? 0 : 1);
