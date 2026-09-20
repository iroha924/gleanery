// session の題。harvest が、題の無い session だけをまとめて付ける。
//
// 発言の先頭を切り出すと「reload-pluginsも完了。」のような題になり、一覧で見分けられない。
// 題は 1 session につき 1 回だけ付ける（会話が伸びても付け直さない）。
//
// 付けられなかった session は題を持たないまま残り、次の harvest で取り直す。画面は題が無ければ
// 最初の発言の冒頭で代用するので、生成が止まっている間も一覧は読める。

import { type Kysely, type SqlBool, sql } from "kysely";
import OpenAI from "openai";
import type { Env } from "./db.ts";
import type { DB } from "./db-types.ts";
import { framed } from "./search.ts";
import { head, reason } from "./text.ts";

// 題は短い要約で、推論の深さが要らない。チャットの模型（設定で替えられる）とは別に、いちばん安い段を固定で使う。
export const TITLE_MODEL = "gpt-5.6-luna";
// 1 回の harvest で付ける上限。題の無い session が溜まっている最初の 1 回で、API を一気に叩かない。
const BATCH = 40;
// 題を決めるのに要るのは冒頭だけ。発言は 1 件で 12 KiB まで入りうるので、ここで切る。
const SOURCE_BYTES = 4000;
const TITLE_BYTES = 120;
const TURNS = 6;

export const TITLE_INSTRUCTIONS = [
  "会話から、一覧で見分けるための題を 1 つ作る。",
  "日本語で 10〜24 文字。体言止め。鍵括弧・引用符・句点・接頭辞を付けず、題だけを返す。",
  "何の話だったかが分かる具体を入れる（扱った機能・不具合・道具の名前）。",
  "「作業」「対応」「修正」だけの題にしない。",
].join("\n");

/** 付けた題の数と、途中で止めた理由（残りは次の harvest で取り直す）。 */
export type Titled = { titled: number; stopped?: string };

type Turn = { speaker: string; body: string };

/**
 * 題を 1 つ作る。本文は第三者が書いた文章を含みうる（AI の応答には PR・issue・Web から読んだものが
 * 混ざる）ので framed で囲い、道具を渡さない。返るのは画面に出す文字列だけである。
 */
async function titleOf(openai: OpenAI, turns: Turn[]): Promise<string> {
  const source = head(
    turns.map((t) => `${t.speaker === "self" ? "持ち主" : "AI"}: ${t.body}`).join("\n\n"),
    SOURCE_BYTES,
  );
  const result = await openai.responses.create({
    model: TITLE_MODEL,
    reasoning: { effort: "low" },
    instructions: TITLE_INSTRUCTIONS,
    input: framed(source),
  });
  return cleanTitle(result.output_text);
}

/**
 * 生成された題を、画面に出せる 1 行にする。模型は頼んでいない飾りを付けて返す — 囲みの記号、
 * 前置きの改行、上限を超える長さ。切るのは文字数ではなくバイト（日本語は 1 字 3 バイト）。
 */
export function cleanTitle(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return head(line.replace(/^[\s"'「『]+/, "").replace(/[\s"'」』。]+$/, ""), TITLE_BYTES);
}

/**
 * 題の無い session に題を付ける。**付けられなかった行を数えない** — 失敗は鍵・上限・障害のように
 * どの行でも同じく起きるもので、行の側に原因が無い。数えて諦めると、障害の間に回した harvest だけで
 * その session が永久に題を持たなくなる。
 */
export async function fillTitles(db: Kysely<DB>, env: Env): Promise<Titled> {
  if (!env.OPENAI_API_KEY) return { titled: 0, stopped: "OPENAI_API_KEY が無い" };
  // 題を付けられるのは発言のある session だけ。trace だけで残した session は、結んだ作業の題で足りる。
  const pending = await db
    .selectFrom("gleanery.conversation as c")
    .select([
      sql<string>`c.id::text`.as("id"),
      sql<
        Turn[]
      >`(select json_agg(json_build_object('speaker', x.speaker_kind, 'body', x.body) order by x.sent_at)
        from (select m.speaker_kind, m.body, m.sent_at from gleanery.message m
              where m.conversation_id = c.id order by m.sent_at limit ${TURNS}) x)`.as("turns"),
    ])
    .where("c.title", "is", null)
    .where("c.origin", "<>", "github")
    .where(sql<SqlBool>`exists (select 1 from gleanery.message m where m.conversation_id = c.id)`)
    .orderBy("c.started_at", "desc")
    .limit(BATCH)
    .execute();
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  let titled = 0;
  for (const row of pending) {
    let title: string;
    try {
      title = await titleOf(openai, row.turns);
    } catch (e) {
      // どの行を送っても同じく落ちる種類の失敗。残りは次の harvest で取り直す。
      return { titled, stopped: reason(e).slice(0, 500) };
    }
    if (!title) continue;
    // 読んだ後に取り込みが題を付けていれば、そちらを残す。
    const r = await db
      .updateTable("gleanery.conversation")
      .set({ title })
      .where("id", "=", row.id)
      .where("title", "is", null)
      .executeTakeFirst();
    titled += Number(r.numUpdatedRows);
  }
  return { titled };
}

/** 結果を 1 行にする。harvest が出す。 */
export const describeTitles = (t: Titled): string | null =>
  t.titled || t.stopped
    ? `セッションの題 ${t.titled} 件${t.stopped ? ` / 途中で止めた（${t.stopped}）。残りは次の同期で取り直す` : ""}`
    : null;
