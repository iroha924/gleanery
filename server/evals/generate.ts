#!/usr/bin/env node
// 事実の質問をデータから作る。
//
// **単純な引き出しは作らない。**「#N の著者は？」のような問いは、事実文字列を
// そのまま出せば通るので満点が続き、何も検出しない（Codex の指摘）。
// RAG が本当に苦しむのは次の 4 つなので、そこを狙って作る。
//
//   1. 複合条件（リポジトリ × 著者 × 状態 × 期間）— 絞り込みを間違えると数が合わない
//   2. 情報源またぎ（PR ↔ issue）— 片方だけ見ていると答えられない
//   3. 干渉（似た番号が近くにある）— 埋め込みが取り違える型
//   4. 過去と現在の差（状態が変わった issue）— 古いコメントを現在形で読む型
//
// 正解は DB が持っているので裏取りが要らない。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, loadEnv } from "../src/db.ts";

const env = loadEnv(process.cwd());
const c = await connect(env, { as: "read" });

type Case = { q: string; must: string[]; mustNot: string[]; any?: boolean; why: string; auto: true };
const cases: Case[] = [];

// --- 1. 複合条件。数が合うかで判定する ---
const combos = await c.query<{ repo: string; author: string; ym: string; n: number }>(
  `select s.label as repo, n.actor_name as author, to_char(n.at, 'YYYY-MM') as ym, count(*)::int as n
   from node n join scope s on s.id = n.scope_id
   where n.kind='event' and n.subkind='pr' and n.status='merged' and n.deleted_at is null
     and n.actor_name not like '%[bot]%' and n.at is not null
   group by 1,2,3 having count(*) between 3 and 40
   order by random() limit 6`,
);
for (const r of combos.rows) {
  const [y, m] = r.ym.split("-");
  const repo = r.repo.split("/")[1] ?? r.repo;
  cases.push({
    q: `${repo} で ${r.author} が ${y}年${Number(m)}月にマージした PR は何件？`,
    must: [String(r.n)],
    mustNot: [],
    why: `DB の実測: ${r.repo} × ${r.author} × ${r.ym} = ${r.n} 件。**3 条件の絞り込みを間違えると数が合わない**`,
    auto: true,
  });
}

// --- 2. 情報源またぎ。PR の本文にある issue 番号を当てさせる ---
const linked = await c.query<{ pr: number; repo: string; issue: string; title: string }>(
  `select (n.attrs->>'pr')::int as pr, s.label as repo,
          (regexp_match(n.text, 'OT-[0-9]{4}'))[1] as issue, n.attrs->>'prTitle' as title
   from node n join scope s on s.id = n.scope_id
   where n.kind='event' and n.subkind='pr' and n.deleted_at is null
     and n.text ~ 'OT-[0-9]{4}' and length(n.attrs->>'prTitle') > 25
   order by random() limit 5`,
);
for (const r of linked.rows) {
  const repo = r.repo.split("/")[1] ?? r.repo;
  cases.push({
    q: `${repo} の #${r.pr} はどの issue の作業？`,
    must: [r.issue],
    mustNot: ["記録にありません", "紐づく issue は"],
    why: `PR 本文に ${r.issue} が書かれている。**PR と issue をまたいで見ること**`,
    auto: true,
  });
}

// --- 3. 干渉。番号が近い別の issue と取り違えないか ---
const ids = (
  await c.query<{ id: string; status: string }>(
    `select replace(id,'linear:','') as id, raw->>'status' as status from record where id like 'linear:%'`,
  )
).rows;
for (const a of ids.slice(0, 4)) {
  // 番号が最も近い別の issue を、間違い候補として置く
  const near = ids
    .filter((x) => x.id !== a.id)
    .sort(
      (x, y) =>
        Math.abs(Number(x.id.slice(3)) - Number(a.id.slice(3))) -
        Math.abs(Number(y.id.slice(3)) - Number(a.id.slice(3))),
    )[0];
  if (!near) continue;
  cases.push({
    q: `${a.id} の状態は？`,
    must: [a.status],
    // **近い番号の issue の題名を混ぜていたら誤り。**埋め込みは番号を見分けられない
    mustNot: [near.id],
    why: `${a.id} は ${a.status}。**${near.id} と取り違えないこと**（番号が近い）`,
    auto: true,
  });
}

// --- 4. 過去と現在の差。完了した issue を、古いコメントで語らせない ---
const done = await c.query<{ id: string; status: string }>(
  `select replace(id,'linear:','') as id, raw->>'status' as status
   from record where id like 'linear:%' and raw->>'status' in ('Done','Canceled')
   order by random() limit 3`,
);
for (const r of done.rows) {
  cases.push({
    q: `${r.id} はまだ作業が残ってる？`,
    must: [r.status === "Done" ? "完了" : "中止", ...(r.status === "Done" ? ["Done"] : ["Canceled"])],
    any: true,
    mustNot: ["レビュー待ちです", "作業中です", "進行中です"],
    why: `${r.id} は ${r.status}。**古いコメントを現在形で読むと落ちる**`,
    auto: true,
  });
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(HERE, "answers-auto.json");
fs.writeFileSync(
  out,
  `${JSON.stringify({ note: "データから機械的に作る。**単純な引き出しは作らない** — 複合条件・情報源またぎ・干渉・時系列の差だけ。", cases }, null, 2)}\n`,
);
console.log(
  `${cases.length} 問を書いた（複合 ${combos.rows.length} / またぎ ${linked.rows.length} / 干渉 4 / 時系列 ${done.rows.length}）`,
);
await c.end();
