#!/usr/bin/env node
// 検索を測る問いを、実データから一度だけ作る。**出来た JSON を正本として commit し、毎回作り直さない。**
// 作り直すと、前回との比較が「検索が変わった」のか「問いが変わった」のか分からなくなる。
//
// **正解は source_key で持つ。**DB の id は入れ直しで変わる（SQLite への移行でも変わる）。
// 問いは記録の本文から LLM に作らせるので、**同じ本文を書いた者が問いも作ったのと同じ偏り**がある。
// ここで測れるのは下限（ここで落ちるものは実運用でも落ちる）であって、実運用の精度ではない。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import OpenAI from "openai";
import { loadEnv, open } from "../src/db.ts";
import { TITLE_MODEL } from "../src/titles.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "retrieval.json");
/** 種別ごとに何問作るか。合計 100 問。 */
const QUOTA = {
  decision: 20,
  finding: 15,
  dead_end: 10,
  option: 10,
  other: 10,
  document: 25,
  message: 10,
} as const;

type Case = { q: string; expect: string[]; kind: string; source: string };

const env = loadEnv();
if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY が無い");
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const db = open(env, "reader");

/** 本文から、その記録にだけ当たる問いを 1 つ作らせる。 */
async function ask(body: string, hint: string): Promise<string | null> {
  const r = await openai.responses.create({
    model: TITLE_MODEL,
    input: [
      {
        role: "developer",
        content:
          "過去の記録を探すための問いを 1 つだけ作る。日本語で 40 字以内。\n" +
          "- **本文の言い回しをそのまま写さない。**別の言葉で同じことを尋ねる\n" +
          "- その記録にだけ当たる固有の語（ファイル名・コマンド・製品名）は 1 つまで残してよい\n" +
          "- 「〜は？」「〜どうした？」のように、人が検索窓へ打つ形にする\n" +
          "- 問いだけを返す。前置きも引用符も付けない",
      },
      { role: "user", content: `種別: ${hint}\n本文:\n${body.slice(0, 1200)}` },
    ],
  });
  const q = r.output_text?.trim().replace(/^["「『]|["」』]$/g, "");
  return q && q.length >= 4 && q.length <= 60 ? q : null;
}

const cases: Case[] = [];

// 1. 知識（trace 由来と文書の節）
const rows = await db
  .selectFrom("gleanery.knowledge as k")
  .select(["k.source_key", "k.kind", "k.status", "k.body", "k.heading"])
  .where("k.body", "is not", null)
  .orderBy(sql`random()`)
  .execute();

const want: Record<string, number> = { ...QUOTA };
for (const r of rows) {
  // **採った案（chosen / was_chosen）は、どの検索にも出ない。**決定と同じ内容なので決定だけを返す設計
  // （server/src/search.ts の knowledgeFilters）。ここを正解にすると、仕様上絶対に当たらない問いになる。
  // 実測で 4 問がこれで落ち、いずれも親の決定は上位に返っていた。期待値は親の決定にする。
  if (r.kind === "option" && (r.status === "chosen" || r.status === "was_chosen")) continue;
  const bucket =
    r.kind === "document"
      ? "document"
      : r.kind === "decision" || r.kind === "finding" || r.kind === "dead_end" || r.kind === "option"
        ? r.kind
        : "other";
  if ((want[bucket] ?? 0) <= 0) continue;
  if (r.body.length < 40) continue;
  const q = await ask(`${r.heading ? `${r.heading}\n` : ""}${r.body}`, r.kind);
  if (!q) continue;
  cases.push({ q, expect: [r.source_key], kind: bucket, source: "knowledge" });
  want[bucket] = (want[bucket] ?? 0) - 1;
  process.stdout.write(`\r作った: ${cases.length} 問`);
  if (Object.values(want).every((n) => n <= 0)) break;
}

// 2. 発言（持ち主の発言だけ。「私はなんて言った？」を測る）
const msgs = await db
  .selectFrom("gleanery.message as m")
  .innerJoin("gleanery.conversation as c", "c.id", "m.conversation_id")
  .select(["m.id", "m.body"])
  .where("m.speaker_kind", "=", "self")
  .where(sql<boolean>`length(m.body) > 60`)
  .orderBy(sql`random()`)
  .limit(QUOTA.message * 2)
  .execute();
for (const m of msgs) {
  if (cases.filter((c) => c.source === "message").length >= QUOTA.message) break;
  const q = await ask(m.body, "持ち主の発言");
  if (!q) continue;
  cases.push({ q, expect: [m.id], kind: "message", source: "message" });
  process.stdout.write(`\r作った: ${cases.length} 問`);
}

fs.writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      note:
        "検索を測る問い。正解は knowledge なら source_key、message なら id。" +
        "記録の本文から LLM が作ったので、実運用より易しい方向に偏る。ここで落ちるものは実運用でも落ちる、という下限の測定。",
      builtAt: new Date().toISOString(),
      cases,
    },
    null,
    2,
  )}\n`,
);
console.log(`\n${OUT} へ ${cases.length} 問を書いた`);
await db.destroy();
