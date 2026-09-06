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

type Case = { q: string; must: string[]; mustNot: string[]; any?: boolean; why: string };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(fs.readFileSync(path.join(HERE, "answers.json"), "utf8")) as { cases: Case[] };
const env = loadEnv(process.cwd());
const c = await connect(env, { as: "read" });

const group = process.argv[2] ?? "macbee planet";
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
const failed: { q: string; why: string; miss: string[]; said: string }[] = [];

for (const [i, cs] of cases.entries()) {
  let answer = "";
  try {
    for await (const ev of chat(c, env, { question: cs.q, scopeIds })) {
      if (ev.type === "text") answer += ev.text;
    }
  } catch (e) {
    answer = `（失敗: ${e instanceof Error ? e.message : e}）`;
  }
  const has = (s: string) => answer.toLowerCase().includes(s.toLowerCase());
  const missing = cs.any ? (cs.must.some(has) ? [] : cs.must) : cs.must.filter((m) => !has(m));
  const forbidden = cs.mustNot.filter(has);
  const pass = missing.length === 0 && forbidden.length === 0;
  if (pass) ok++;
  else {
    failed.push({
      q: cs.q,
      why: cs.why,
      miss: [...missing.map((m) => `無い: ${m}`), ...forbidden.map((m) => `言ってはいけない: ${m}`)],
      said: answer.replace(/\n/g, " ").slice(0, 160),
    });
  }
  process.stderr.write(`${pass ? "○" : "×"} [${i + 1}/${cases.length}] ${cs.q}\n`);
}

console.log(`\n正答 ${ok} / ${cases.length}（${((ok / cases.length) * 100).toFixed(0)}点）`);
for (const f of failed) {
  console.log(`\n× ${f.q}`);
  console.log(`   期待: ${f.why}`);
  console.log(`   結果: ${f.miss.join(" / ")}`);
  console.log(`   答え: ${f.said}…`);
}
await c.end();
