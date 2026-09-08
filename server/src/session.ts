// Claude Code のセッション記録をナレッジにする。
//
// **ここにしか無いものがある。**「2 approve ついていたらマージして大丈夫です、と◯◯さんから
// 連絡があった」のような、口頭やチャットで伝わった前提は GitHub にも Linear にも残らない。
// PR とコメントだけを入れても、そこへ至った理由は落ちる。
//
// **ツール呼び出しは入れない。**実測（main-repo の 21 セッション）で、
// 人の発言 629 件・それに続く応答 582 件に対して、落とした行が 7,299 行だった。
// 大半はファイル読み込みとコマンド出力で、ナレッジとしての価値がない。
//
// **1 件 = 1 往復。**人の指示だけだと「やっぱり構成図で」のように単体で意味を成さず、
// 応答だけだと何に答えているか分からない。対で初めて読める。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { EMBED_MODEL, type Env, embed, vec } from "./db.ts";

export type Exchange = {
  key: string;
  at: string;
  branch: string;
  /** 人が言ったこと */
  ask: string;
  /** それに対する応答。結論は冒頭に来るので前半だけ取る */
  reply: string;
};

export type Session = { id: string; file: string; cwd: string; exchanges: Exchange[] };

// スキルの呼び出しとスラッシュコマンドは、本人の言葉ではないので落とす。
// **文脈の圧縮要約も落とす。**あれは AI が書いた要約で、同じセッションの往復と内容が重なる
// （実測 10 件・平均 4,079 字で、他の往復の 4 倍。検索の上位を占めてしまう）。
/**
 * 人が打っていない発言。**「人の発話」の欄に入ると、量も意味も汚す。**
 *
 * 実測（118 往復）: 28 件（24%）が人の言葉でないのに入っており、**文字量の 67%** を占めていた。
 * とくに別セッションからの通知は 12 件で平均 6,221 字あり、1 件で本物 12 件分の重さになる。
 */
const BOILERPLATE =
  /^(Base directory for this skill|<|\/|This session is being continued|Caveat: The messages below|Another Claude session sent a message|# Claude in Chrome|\(Re-invocation of|\[Image: source:|mcp__[a-z0-9_]+__ ?を呼ん)/;

const textOf = (m: unknown): string => {
  const c = (m as { content?: unknown })?.content;
  if (typeof c === "string") return c.trim();
  if (!Array.isArray(c)) return "";
  return c
    .filter((x): x is { type: string; text: string } => {
      const o = x as { type?: string; text?: string };
      return o?.type === "text" && typeof o.text === "string";
    })
    .map((x) => x.text)
    .join(" ")
    .trim();
};

/** 1 セッションぶんの往復を取り出す。 */
export function readSession(file: string): Session | null {
  const id = path.basename(file, ".jsonl");
  const exchanges: Exchange[] = [];
  let cwd = "";
  let branch = "";
  let pending: { ask: string; at: string; branch: string } | null = null;

  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    // サブエージェントの往復は本人の会話ではない。
    if (d.isSidechain) continue;
    if (typeof d.cwd === "string" && !cwd) cwd = d.cwd;
    if (typeof d.gitBranch === "string" && d.gitBranch) branch = d.gitBranch;

    const body = textOf(d.message);
    if (d.type === "user") {
      // **短すぎるものは落とす。**「OK」「進めて」は後から読んでも何も分からない。
      if (!body || body.length < 15 || BOILERPLATE.test(body)) continue;
      pending = { ask: body, at: String(d.timestamp ?? ""), branch };
    } else if (d.type === "assistant" && body && pending) {
      const ask = pending.ask.slice(0, 12_000);
      const reply = body.slice(0, 2000);
      exchanges.push({
        // **位置ではなく中身で決める。**連番にすると、途中の 1 件を落としただけで
        // 以降が全部繰り上がり、同じ発言が別のキーで再登録される（実測: ノイズを
        // 落としたら 15 件が重複した）。会話は後から編集も削除もされうるので、
        // 位置に依存する識別子はそのたびに壊れる。
        key: `${id}:${hash(`${ask}\n${reply}`).slice(0, 12)}`,
        at: pending.at,
        branch: pending.branch,
        // **貼り付けた MTG の文字起こしが入る。**4,000 字で切ると議事録の後半が消えるので、
        // 実測で最長だったもの（約 12,000 字）が収まる長さにする。
        ask,
        reply,
      });
      pending = null;
    }
  }
  return exchanges.length ? { id, file, cwd, exchanges } : null;
}

/** 埋め込む文。**どのブランチのいつの話かを前置する。** */
export const exchangeText = (e: Exchange): string =>
  `${e.branch || "main"} / ${e.at.slice(0, 10)}\n指示: ${e.ask}\n応答: ${e.reply}`;

const hash = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

/** セッション 1 本 = 記録 1 本。往復がその下の node。 */
export async function ingestSession(
  client: pg.Client,
  env: Env,
  scopeId: number,
  s: Session,
  me: string,
): Promise<{ nodes: number; embedded: number }> {
  const recordId = `session:${s.id}`;
  const first = s.exchanges[0];
  const last = s.exchanges[s.exchanges.length - 1];
  if (!first || !last) return { nodes: 0, embedded: 0 };

  await client.query(
    `insert into record (id, scope_id, schema_ver, title, status, problem, goal,
                         created_at, updated_at, raw, raw_hash)
     values ($1,$2,'session/1',$3,'done',$4,'',$5,$6,'{}'::jsonb,$7)
     on conflict (id) do update set
       title=excluded.title, problem=excluded.problem, updated_at=excluded.updated_at,
       raw_hash=excluded.raw_hash, ingested_at=now()`,
    [
      recordId,
      scopeId,
      `${first.branch || "main"}: ${first.ask.slice(0, 80).replace(/\n/g, " ")}`,
      first.ask.slice(0, 2000),
      first.at || new Date().toISOString(),
      last.at || new Date().toISOString(),
      hash(s.exchanges.map((e) => e.key).join()),
    ],
  );

  const existing = new Map(
    (
      await client.query<{ key: string; content_hash: string; has_emb: boolean }>(
        "select key, content_hash, embedding is not null as has_emb from node where record_id=$1",
        [recordId],
      )
    ).rows.map((r) => [r.key, r]),
  );
  const need = s.exchanges.filter((e) => {
    const old = existing.get(e.key);
    return !old || old.content_hash !== hash(exchangeText(e)) || !old.has_emb;
  });
  const vectors = need.length
    ? await embed(
        env,
        need.map((e) => exchangeText(e)),
        "document",
      )
    : [];
  const byKey = new Map(need.map((e, i) => [e.key, vectors[i]]));

  await client.query("begin");
  try {
    for (const [ordinal, e] of s.exchanges.entries()) {
      const v = byKey.get(e.key);
      await client.query(
        `insert into node (record_id, scope_id, kind, subkind, key, ordinal, at, text, polarity, attrs,
                           actor_kind, actor_name, content_hash, embed_text, embed_model, embedded_at, embedding)
         values ($1,$2,'utterance','session',$3,$4,$5,$6,'na',$7,'human',$8,$9,$10,$11,$12,$13)
         on conflict (record_id, kind, key) do update set
           ordinal=excluded.ordinal, at=excluded.at, text=excluded.text, attrs=excluded.attrs,
           content_hash=excluded.content_hash, deleted_at=null,
           embed_text=coalesce(excluded.embed_text, node.embed_text),
           embed_model=coalesce(excluded.embed_model, node.embed_model),
           embedded_at=coalesce(excluded.embedded_at, node.embedded_at),
           embedding=coalesce(excluded.embedding, node.embedding)`,
        [
          recordId,
          scopeId,
          e.key,
          ordinal,
          e.at || null,
          `${me}: ${e.ask}\nAI: ${e.reply}`,
          JSON.stringify({ branch: e.branch, session: s.id }),
          me,
          hash(exchangeText(e)),
          v ? exchangeText(e) : null,
          v ? EMBED_MODEL : null,
          v ? new Date().toISOString() : null,
          vec(v),
        ],
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
  return { nodes: s.exchanges.length, embedded: need.length };
}
