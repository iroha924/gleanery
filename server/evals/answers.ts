#!/usr/bin/env node
// **答えが事実として正しいかを測る。**検索の recall とは別物。
//
// 判定は決定的にする。LLM を審判にする方法もあり、人間との一致は 90% ほどと報告されているが、
// **審判自体の校正が要る**うえに実行のたびに揺れる。ここで測りたい答えには
// PR 番号・日付・状態のような検証可能な語が必ず含まれるので、突き合わせで足りる。
//
// - must: すべて含まれること（any: true なら 1 つでも含まれれば可）
// - mustNot: 含まれてはいけない。**「記録にありません」で諦める型を捕まえる**
//
// 事実はすべて GitHub / Linear / DB で確認済み。**推測で期待値を書かない。**

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chat } from "../src/chat.ts";
import { connect, loadEnv } from "../src/db.ts";
import { scopeFamily } from "../src/search.ts";

type Case = { q: string; must: string[]; mustNot: string[]; any?: boolean; why: string; from?: string };

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 引数で測る束を選ぶ。既定は全部。**分けて持つのは、作り方が違うから** —
// answers は手書きの事実、auto はデータから生成、judgment は正解が 1 つに決まらない問い。
const files = process.argv.slice(2).filter((x) => x.endsWith(".json"));
const load = (f: string): Case[] =>
  (JSON.parse(fs.readFileSync(path.join(HERE, f), "utf8")) as { cases: Case[] }).cases.map((c) => ({
    ...c,
    from: f.replace(/^answers-?|\.json$/g, "") || "事実",
  }));
const cases = (files.length ? files : ["answers.json", "answers-auto.json", "answers-judgment.json"]).flatMap(
  load,
);
const env = loadEnv(process.cwd());
const c = await connect(env, { as: "read" });

// **束の名前とファイル名は同じ位置に来る。**argv[2] をそのまま束名にすると
// `answers.ts recheck.json` が「recheck.json という束」を探して落ちる（実測）。
const group = process.argv.slice(2).find((x) => !x.endsWith(".json")) ?? "Example Org";
const g = await c.query<{ id: number }>(
  `select s.id::int as id from scope s
   join group_member m on m.scope_id = s.id
   join scope_group gr on gr.id = m.group_id
   where gr.name = $1`,
  [group],
);
const scopeIds = [...new Set((await Promise.all(g.rows.map((r) => scopeFamily(c, r.id)))).flat())];
if (scopeIds.length === 0) throw new Error(`${group} が見つからない`);

let ok = 0;
let citeBad = 0;
const failed: { q: string; why: string; miss: string[]; said: string }[] = [];

for (const [i, cs] of cases.entries()) {
  let answer = "";
  let sources: { n: number; text: string }[] = [];
  try {
    for await (const ev of chat(c, env, { question: cs.q, scopeIds })) {
      if (ev.type === "text") answer += ev.text;
      else if (ev.type === "sources") sources = ev.sources.map((x) => ({ n: x.n, text: x.text }));
    }
  } catch (e) {
    answer = `（失敗: ${e instanceof Error ? e.message : e}）`;
  }

  // **引用が実在するかを見る。**文字列一致だけだと「Done」という語が答えにあれば通るが、
  // それが別のチケットの話でも通ってしまう（Codex の指摘）。
  // 完全な検証はできないが、**存在しない番号を引いていないこと**は機械的に確かめられる。
  const cited = [...new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))];
  const have = new Set(sources.map((x) => x.n));
  const ghosts = cited.filter((x) => !have.has(x));
  if (ghosts.length) citeBad++;
  // **`re:` で始まる期待は正規表現。**素の部分一致では実体と述語を結び付けられず、
  // 正しい答えを落とす。実測: 「ABC-456 の状態は？」に `mustNot: ["ABC-457"]` と書いたが、
  // ABC-457 は 4856 の子なので、正しく子として挙げただけで不合格になった。
  // 捕まえたいのは「4856 の状態を QA（=4858 の状態）と言う」取り違えなので、
  // `re:ABC-456(?:(?!OT-)[^。\n]){0,25}QA` のように**間に別の issue が挟まらない範囲**で束縛する。
  const has = (s: string) =>
    s.startsWith("re:")
      ? new RegExp(s.slice(3), "i").test(answer)
      : answer.toLowerCase().includes(s.toLowerCase());
  const missing = cs.any ? (cs.must.some(has) ? [] : cs.must) : cs.must.filter((m) => !has(m));
  const forbidden = cs.mustNot.filter(has);
  const pass = missing.length === 0 && forbidden.length === 0 && ghosts.length === 0;
  if (pass) ok++;
  else {
    failed.push({
      q: cs.q,
      why: cs.why,
      miss: [
        ...missing.map((m) => `無い: ${m}`),
        ...forbidden.map((m) => `言ってはいけない: ${m}`),
        ...ghosts.map((g) => `存在しない根拠を引いた: [${g}]`),
      ],
      said: answer.replace(/\n/g, " ").slice(0, 160),
    });
  }
  process.stderr.write(`${pass ? "○" : "×"} [${i + 1}/${cases.length}] ${cs.q}\n`);
}

console.log(`\n正答 ${ok} / ${cases.length}（${((ok / cases.length) * 100).toFixed(0)}点）`);
// 束ごとの内訳。どの型で落ちているかが分からないと直せない。
const groups = [...new Set(cases.map((x) => x.from ?? ""))];
for (const g of groups) {
  const idx = cases.map((x, i) => (x.from === g ? i : -1)).filter((i) => i >= 0);
  const got = idx.filter((i) => !failed.some((f) => f.q === cases[i]?.q)).length;
  console.log(`  ${g.padEnd(10)} ${got} / ${idx.length}`);
}
console.log(`存在しない根拠を引いた回答: ${citeBad} 件`);
console.log(
  "※ must / mustNot は文字列一致であって、事実の正しさそのものではない。" +
    "「Done」が別チケットの話でも通る。回帰の検出には使えるが、正しさの証明にはならない。",
);
for (const f of failed) {
  console.log(`\n× ${f.q}`);
  console.log(`   期待: ${f.why}`);
  console.log(`   結果: ${f.miss.join(" / ")}`);
  console.log(`   答え: ${f.said}…`);
}
await c.end();
