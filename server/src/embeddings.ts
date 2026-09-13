// 埋め込みの補充。本体を書いた transaction の外で、ready でない行だけを取りに行く。
//
// 本体と埋め込みの行は同じ transaction で書く（埋め込みは pending で入る）。外部 API をその中で待つと、
// 詰まった分だけ行のロックを持ち続けるため、取りに行くのはここで分ける。語彙側の検索は本体を書いた時点から効く。
//
// **行の責任でない失敗では試行回数を数えない。**鍵が無い・認証・上限・障害は、どの行を送っても同じく落ちる。
// 数えると、障害の間に回した同期だけで行が意味検索から永久に外れる。数えるのは、その 1 行だけを送って
// Voyage が本文を受け付けなかったときだけで、上限に達した行はもう送らない（毎回の同期で同じ失敗を繰り返さない）。

import { type Db, EMBED_MODEL, type Env, embed, VoyageError, vec } from "./db.ts";
import { knowledgeText, type MessageEmbedInput, messageText } from "./knowledge.ts";
import { sha256 } from "./text.ts";

const MAX_ATTEMPTS = 5;
const BATCH = 200;

/** stopped は、行の責任でない失敗でこの回を打ち切った理由（残りは次の同期で取り直す）。 */
export type Filled = { embedded: number; failed: number; stopped?: string };

type Pending = { id: string; text: string; stored: Buffer };
type Table = { name: "knowledge_embedding" | "message_embedding"; id: "knowledge_id" | "message_id" };

/** 本文を受け付けなかった（大きすぎる・形が違う）。鍵・上限・障害とは分ける。 */
const rejectsInput = (e: unknown): boolean => e instanceof VoyageError && [400, 413, 422].includes(e.status);
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);

// **書き戻すのは、読んだ時点から本文が変わっていない行だけ。**変わっていれば取り込みが pending に戻しており、
// 古い本文の結果（成功でも失敗でも）で上書きすると、新しい本文が古いベクトルで引かれるか、取り直されなくなる。
async function store(db: Db, t: Table, rows: Pending[], vectors: number[][]): Promise<number> {
  const r = await db.query(
    `update mitos.${t.name} e set embedding = x.v::extensions.halfvec, status = 'ready', model = $5,
       source_hash = x.hash, last_error = null, updated_at = now()
     from unnest($1::text[], $2::bytea[], $3::bytea[], $4::text[]) as x(id, stored, hash, v)
     where e.${t.id}::text = x.id and e.source_hash = x.stored`,
    [
      rows.map((x) => x.id),
      rows.map((x) => x.stored),
      rows.map((x) => sha256(x.text)),
      vectors.map(vec),
      EMBED_MODEL,
    ],
  );
  return r.rowCount ?? 0;
}

async function reject(db: Db, t: Table, row: Pending, e: unknown): Promise<void> {
  await db.query(
    `update mitos.${t.name} set status = 'error', attempts = attempts + 1, last_error = $3, updated_at = now()
     where ${t.id}::text = $1 and source_hash = $2`,
    [row.id, row.stored, reason(e)],
  );
}

async function run(
  db: Db,
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
      if (!rejectsInput(e)) return { embedded, failed, stopped: reason(e) };
    }
    // どれかの本文を受け付けなかった。1 行ずつ送り直し、受け付けない行だけを数える。
    // **全行が拒まれたら本文の問題ではない**（モデル名や引数の誤り）。数えずに止める — 数えると、設定を直しても
    // 本文が変わるまで二度と送らない。
    const refused: [Pending, unknown][] = [];
    for (const row of rows) {
      try {
        embedded += await store(db, t, [row], await embed(env, [row.text], "document"));
      } catch (e) {
        if (!rejectsInput(e)) return { embedded, failed, stopped: reason(e) };
        refused.push([row, e]);
      }
    }
    if (refused.length === rows.length && rows.length > 1)
      return { embedded, failed, stopped: `どの本文も受け付けられなかった（${reason(refused[0]?.[1])}）` };
    for (const [row, e] of refused) {
      await reject(db, t, row, e);
      failed++;
    }
  }
}

/** ready でない知識を埋める。埋め込み文は本体から作り直す。 */
export function fillKnowledge(db: Db, env: Env): Promise<Filled> {
  return run(db, env, { name: "knowledge_embedding", id: "knowledge_id" }, async (skip) => {
    const r = await db.query<{
      id: string;
      kind: string;
      heading: string | null;
      body: string;
      reason: string | null;
      source_hash: Buffer;
    }>(
      `select k.id::text, k.kind, k.heading, k.body, k.reason, e.source_hash
       from mitos.knowledge_embedding e join mitos.knowledge k on k.id = e.knowledge_id
       where e.status <> 'ready' and e.attempts < $1 and not (e.knowledge_id::text = any($3::text[]))
       order by e.updated_at limit $2`,
      [MAX_ATTEMPTS, BATCH, skip],
    );
    return r.rows.map((k) => ({ id: k.id, text: knowledgeText(k), stored: k.source_hash }));
  });
}

/** ready でない発言を埋める。 */
export function fillMessages(db: Db, env: Env): Promise<Filled> {
  return run(db, env, { name: "message_embedding", id: "message_id" }, async (skip) => {
    const r = await db.query<{
      id: string;
      body: string;
      speaker_kind: string;
      handle: string | null;
      project: string;
      source_kind: string | null;
      external_id: string | null;
      title: string | null;
      paths: string[];
      source_hash: Buffer;
    }>(
      `select m.id::text, m.body, m.speaker_kind, i.handle, p.name as project,
              s.kind as source_kind, s.external_id, s.title,
              coalesce(array(select f.path from mitos.message_file f
                             where f.message_id = m.id and f.action = 'review' order by f.path), '{}') as paths,
              e.source_hash
       from mitos.message_embedding e
       join mitos.message m on m.id = e.message_id
       join mitos.conversation c on c.id = m.conversation_id
       join mitos.project p on p.id = c.project_id
       left join mitos.source_item s on s.id = c.source_item_id
       left join mitos.person_identity i on i.id = m.identity_id
       where e.status <> 'ready' and e.attempts < $1 and not (e.message_id::text = any($3::text[]))
       order by e.updated_at limit $2`,
      [MAX_ATTEMPTS, BATCH, skip],
    );
    return r.rows.map((m) => {
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

/** 補充の結果を 1 行にする。sync と trace save が出す。 */
export const describeFill = (label: string, f: Filled): string | null =>
  f.embedded || f.failed || f.stopped
    ? `${label} ${f.embedded} 件${f.failed ? ` / 受け付けられなかった ${f.failed} 件` : ""}${
        f.stopped ? ` / 途中で止めた（${f.stopped}）。残りは次の同期で取り直す` : ""
      }`
    : null;
