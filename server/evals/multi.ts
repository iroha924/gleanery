#!/usr/bin/env node
// 多ターンの会話を測る。
//
// **一問一答では出ない失敗がある。**実際の使い方は「source側は？」「それぞれどのissueか？」
// のように前を引き継ぐ形で、そこで指示語の解決・直前の一覧の記憶・話題の切り替えが要る。
// 履歴を渡さずに測ると、この面が丸ごと抜ける。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chat } from "../src/chat.ts";
import { connect, loadEnv } from "../src/db.ts";
import { scopeFamily } from "../src/search.ts";

type Turn = {
  q: string;
  must: string[];
  mustNot: string[];
  any?: boolean;
  why: string;
  /** そのターンで出た実体（PR 番号や issue 番号）を覚えておく名前 */
  remember?: string;
  /** 覚えた実体と食い違っていないかを見る。**会話としての整合性はターン単位では測れない** */
  consistentWith?: string;
};
type Case = { name: string; turns: Turn[]; note?: string };

/** 答えに出てくる PR / issue の番号。会話をまたいで同じものを指しているかの判定に使う。 */
const entitiesOf = (s: string): Set<string> =>
  new Set([...s.matchAll(/OT-\d{3,5}|#\d{2,5}/g)].map((m) => m[0]));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(fs.readFileSync(path.join(HERE, "answers-multi.json"), "utf8")) as {
  cases: Case[];
};
const env = loadEnv(process.cwd());
const c = await connect(env, { as: "read" });

const g = await c.query<{ id: number }>(
  `select s.id::int as id from scope s
   join group_member m on m.scope_id = s.id
   join scope_group gr on gr.id = m.group_id
   where gr.name = $1`,
  [process.argv[2] ?? "macbee planet"],
);
const scopeIds = [...new Set((await Promise.all(g.rows.map((r) => scopeFamily(c, r.id)))).flat())];

let ok = 0;
let total = 0;
const failed: string[] = [];

for (const cs of cases) {
  // **会話ごとに履歴を作り直す。**跨ぐと前の会話の文脈が混ざり、測りたいものが変わる。
  const history: { role: "user" | "assistant"; content: string }[] = [];
  // 会話の中で「何の話をしているか」を覚えておく。**ターンをまたぐ整合性を測るため。**
  const remembered = new Map<string, Set<string>>();
  console.log(`\n── ${cs.name}`);
  for (const [i, t] of cs.turns.entries()) {
    let answer = "";
    try {
      for await (const ev of chat(c, env, { question: t.q, scopeIds, history })) {
        if (ev.type === "text") answer += ev.text;
      }
    } catch (e) {
      answer = `（失敗: ${e instanceof Error ? e.message : e}）`;
    }
    history.push({ role: "user", content: t.q }, { role: "assistant", content: answer });

    // `re:` で始まる期待は正規表現（判定規則は answers.ts と同じ）。
    const has = (s: string) =>
      s.startsWith("re:")
        ? new RegExp(s.slice(3), "i").test(answer)
        : answer.toLowerCase().includes(s.toLowerCase());
    const missing =
      t.must.length === 0 ? [] : t.any ? (t.must.some(has) ? [] : t.must) : t.must.filter((m) => !has(m));
    const forbidden = t.mustNot.filter(has);

    const found = entitiesOf(answer);
    if (t.remember) remembered.set(t.remember, found);
    // **前のターンで挙げたものと同じ実体を指しているか。**
    // 「それぞれどの issue？」で、直前に挙げた PR とは別の PR の話を始めたら誤り。
    const drift: string[] = [];
    if (t.consistentWith) {
      const before = remembered.get(t.consistentWith) ?? new Set<string>();
      const prs = [...before].filter((x) => x.startsWith("#"));
      const now = [...found].filter((x) => x.startsWith("#"));
      if (prs.length > 0) {
        // **重なりが 1 つでもあれば可、では緩い。**話をすり替えても 1 件かすれば通ってしまう。
        // 不変条件は「同じ集合の話を続けていること」なので、両向きで見る。
        if (!prs.some((x) => found.has(x)))
          drift.push(`前に挙げた ${prs.slice(0, 3).join(" ")} のどれにも触れていない`);
        // **混入は「会話に一度も出ていない」ものだけを見る。**直前の集合とだけ比べると、
        // 1 手目で挙げたものへ戻る正しい答えを落とす（実測: 「それぞれどの issue に紐づく？」に
        // アクティブな 8 本すべてで答えたのを、誤って混入と判定した）。
        const seen = new Set([...remembered.values()].flatMap((x) => [...x]));
        const extra = now.filter((x) => !seen.has(x));
        if (extra.length > 0) drift.push(`会話に出ていない ${extra.slice(0, 3).join(" ")} を混ぜている`);
      }
    }
    const pass = missing.length === 0 && forbidden.length === 0 && drift.length === 0;
    total++;
    if (pass) ok++;
    else
      failed.push(
        `${cs.name} / ${i + 1} 手目「${t.q.slice(0, 30)}…」: ${[...missing.map((m) => `無い:${m}`), ...forbidden.map((m) => `禁止:${m}`), ...drift].join(" ")}`,
      );
    console.log(`  ${pass ? "○" : "×"} ${i + 1}. ${t.q.slice(0, 40)}`);
    if (!pass) console.log(`     期待: ${t.why}`);
    if (!pass) console.log(`     答え: ${answer.replace(/\n/g, " ").slice(0, 140)}…`);
  }
}

console.log(`\n正答 ${ok} / ${total}（${((ok / total) * 100).toFixed(0)}点）`);
for (const f of failed) console.log(`  × ${f}`);
await c.end();
