// 埋め込みの補充。本体を書いた transaction の外で、ready でない行だけを取りに行く。
//
// 本体と埋め込みの行は同じ transaction で書く（埋め込みは pending で入る）。外部 API をその中で待つと、
// 詰まった分だけ行のロックを持ち続けるため、取りに行くのはここで分ける。語彙側の検索は本体を書いた時点から効く。
//
// **行の責任でない失敗では試行回数を数えない。**鍵が無い・認証・上限・障害は、どの行を送っても同じく落ちる。
// 数えると、障害の間に回した同期だけで行が意味検索から永久に外れる。数えるのは、その 1 行だけを送って
// Voyage が本文を受け付けなかったときだけで、上限に達した行はもう送らない（毎回の同期で同じ失敗を繰り返さない）。

import { type Kysely, type SqlBool, sql } from "kysely";
import { EMBED_MODEL, type Env, embed, VoyageError, vec } from "./db.ts";
import type { DB } from "./db-types.ts";
import { knowledgeText, type MessageEmbedInput, messageText } from "./knowledge.ts";
import { reason, sha256 } from "./text.ts";

const MAX_ATTEMPTS = 5;
const BATCH = 200;

/** stopped は、行の責任でない失敗でこの回を打ち切った理由（残りは次の同期で取り直す）。 */
export type Filled = { embedded: number; failed: number; stopped?: string };

type Pending = { id: string; text: string; stored: Buffer };
type Table = { name: "knowledge_embedding" | "message_embedding"; id: "knowledge_id" | "message_id" };

/** 本文を受け付けなかった（大きすぎる・形が違う）。鍵・上限・障害とは分ける。 */
const rejectsInput = (e: unknown): boolean => e instanceof VoyageError && [400, 413, 422].includes(e.status);
const why = (e: unknown): string => reason(e).slice(0, 500);

// **書き戻すのは、読んだ時点から本文が変わっていない行だけ。**変わっていれば取り込みが pending に戻しており、
// 古い本文の結果（成功でも失敗でも）で上書きすると、新しい本文が古いベクトルで引かれるか、取り直されなくなる。
// 知識と発言で同じ形の更新を、表と id の列だけ変えて使う。表名が実行時に決まるので組み立てる。
async function store(db: Kysely<DB>, t: Table, rows: Pending[], vectors: number[][]): Promise<number> {
  const r = await sql`
    update ${sql.table(`gleanery.${t.name}`)} e
       set embedding = x.v::extensions.halfvec, status = 'ready', model = ${EMBED_MODEL},
           source_hash = x.hash, last_error = null, updated_at = now()
      from unnest(${rows.map((x) => x.id)}::text[], ${rows.map((x) => x.stored)}::bytea[],
                  ${rows.map((x) => sha256(x.text))}::bytea[], ${vectors.map(vec)}::text[])
           as x(id, stored, hash, v)
     where e.${sql.ref(t.id)}::text = x.id and e.source_hash = x.stored`.execute(db);
  return Number(r.numAffectedRows ?? 0);
}

async function reject(db: Kysely<DB>, t: Table, row: Pending, e: unknown): Promise<void> {
  await sql`
    update ${sql.table(`gleanery.${t.name}`)}
       set status = 'error', attempts = attempts + 1, last_error = ${why(e)}, updated_at = now()
     where ${sql.ref(t.id)}::text = ${row.id} and source_hash = ${row.stored}`.execute(db);
}

async function run(
  db: Kysely<DB>,
  env: Env,
  t: Table,
  load: (skip: string[]) => Promise<Pending[]>,
): Promise<Filled> {
  if (!env.VOYAGE_API_KEY) return { embedded: 0, failed: 0, stopped: "VOYAGE_API_KEY が無い" };
  let embedded = 0;
  let failed = 0;
  const tried: string[] = [];
  for (;;) {
    const rows = await load(tried);
    if (rows.length === 0) return { embedded, failed };
    tried.push(...rows.map((r) => r.id));
    try {
      embedded += await store(
        db,
        t,
        rows,
        await embed(
          env,
          rows.map((r) => r.text),
          "document",
        ),
      );
      continue;
    } catch (e) {
      if (!rejectsInput(e)) return { embedded, failed, stopped: why(e) };
    }
    // どれかの本文を受け付けなかった。1 行ずつ送り直し、受け付けない行だけを数える。
    const refused: [Pending, unknown][] = [];
    for (const row of rows) {
      try {
        embedded += await store(db, t, [row], await embed(env, [row.text], "document"));
      } catch (e) {
        if (!rejectsInput(e)) return { embedded, failed, stopped: why(e) };
        refused.push([row, e]);
      }
    }
    // **全行が拒まれたら、本文の問題か要求全体の問題（モデル名や引数の誤り）かを短い本文 1 つで確かめる。**
    // 要求全体の問題なら数えずに止める — 数えると、設定を直しても本文が変わるまで二度と送らない。
    if (refused.length === rows.length) {
      try {
        await embed(env, ["gleanery"], "document");
      } catch (e) {
        return {
          embedded,
          failed,
          stopped: rejectsInput(e) ? `どの本文も受け付けられなかった（${why(e)}）` : why(e),
        };
      }
    }
    for (const [row, e] of refused) {
      await reject(db, t, row, e);
      failed++;
    }
  }
}

/** ready でない知識を埋める。埋め込み文は本体から作り直す。 */
export function fillKnowledge(db: Kysely<DB>, env: Env): Promise<Filled> {
  return run(db, env, { name: "knowledge_embedding", id: "knowledge_id" }, async (skip) => {
    const rows = await db
      .selectFrom("gleanery.knowledge_embedding as e")
      .innerJoin("gleanery.knowledge as k", "k.id", "e.knowledge_id")
      .select([
        sql<string>`k.id::text`.as("id"),
        "k.kind",
        "k.heading",
        "k.body",
        "k.reason",
        "e.source_hash",
      ])
      .where("e.status", "<>", "ready")
      .where("e.attempts", "<", MAX_ATTEMPTS)
      .where(sql<SqlBool>`not (e.knowledge_id::text = any(${skip}::text[]))`)
      .orderBy("e.updated_at")
      .limit(BATCH)
      .execute();
    return rows.map((k) => ({ id: k.id, text: knowledgeText(k), stored: k.source_hash }));
  });
}

/** ready でない発言を埋める。 */
export function fillMessages(db: Kysely<DB>, env: Env): Promise<Filled> {
  return run(db, env, { name: "message_embedding", id: "message_id" }, async (skip) => {
    const rows = await db
      .selectFrom("gleanery.message_embedding as e")
      .innerJoin("gleanery.message as m", "m.id", "e.message_id")
      .innerJoin("gleanery.conversation as c", "c.id", "m.conversation_id")
      .innerJoin("gleanery.project as p", "p.id", "c.project_id")
      .leftJoin("gleanery.source_item as s", "s.id", "c.source_item_id")
      .leftJoin("gleanery.person_identity as i", "i.id", "m.identity_id")
      .select([
        sql<string>`m.id::text`.as("id"),
        "m.body",
        "m.speaker_kind",
        "i.handle",
        "p.name as project",
        "s.kind as source_kind",
        "s.external_id",
        "s.title",
        sql<string[]>`coalesce(array(select f.path from gleanery.message_file f
          where f.message_id = m.id and f.action = 'review' order by f.path), '{}')`.as("paths"),
        "e.source_hash",
      ])
      .where("e.status", "<>", "ready")
      .where("e.attempts", "<", MAX_ATTEMPTS)
      .where(sql<SqlBool>`not (e.message_id::text = any(${skip}::text[]))`)
      .orderBy("e.updated_at")
      .limit(BATCH)
      .execute();
    return rows.map((m) => {
      const input: MessageEmbedInput = {
        body: m.body,
        speakerKind: m.speaker_kind,
        handle: m.handle,
        project: m.project,
        source:
          m.source_kind && m.external_id && m.title
            ? { kind: m.source_kind, number: m.external_id, title: m.title }
            : null,
        paths: m.paths,
      };
      return { id: m.id, text: messageText(input), stored: m.source_hash };
    });
  });
}

/** 補充の結果を 1 行にする。harvest と trace save が出す。 */
export const describeFill = (label: string, f: Filled): string | null =>
  f.embedded || f.failed || f.stopped
    ? `${label} ${f.embedded} 件${f.failed ? ` / 受け付けられなかった ${f.failed} 件` : ""}${
        f.stopped ? ` / 途中で止めた（${f.stopped}）。残りは次の同期で取り直す` : ""
      }`
    : null;
