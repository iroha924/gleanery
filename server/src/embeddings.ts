// 埋め込みの補充。本体を書いた transaction の外で、pending と error の行だけを取りに行く。
//
// 本体と埋め込みの行は同じ transaction で書く（埋め込みは pending で入る）。外部 API をその中で待つと、
// 詰まった分だけ行のロックを持ち続けるため、取りに行くのはここで分ける。失敗は error として残り、
// 語彙側の検索は本体を書いた時点から効く。次の同期と自動記録の送信がここを呼んで取り直す。

import { type Db, EMBED_MODEL, type Env, embed, vec } from "./db.ts";
import { knowledgeText, type MessageEmbedInput, messageText } from "./knowledge.ts";
import { sha256 } from "./text.ts";

/** 取り直しを諦める回数。Voyage が特定の本文を受け付けない場合に、毎回の同期で同じ失敗を繰り返さない。 */
const MAX_ATTEMPTS = 5;
const BATCH = 200;

type Pending = { id: string; text: string; stored: Buffer };

async function run(
  db: Db,
  env: Env,
  table: "knowledge_embedding" | "message_embedding",
  idCol: "knowledge_id" | "message_id",
  load: () => Promise<Pending[]>,
): Promise<{ embedded: number; failed: number }> {
  let embedded = 0;
  let failed = 0;
  const tried = new Set<string>();
  for (;;) {
    const rows = (await load()).filter((r) => !tried.has(r.id));
    if (rows.length === 0) break;
    for (const r of rows) tried.add(r.id);
    let vectors: number[][];
    try {
      vectors = await embed(
        env,
        rows.map((r) => r.text),
        "document",
      );
    } catch (e) {
      const message = e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500);
      await db.query(
        `update mitos.${table} set status = 'error', attempts = attempts + 1, last_error = $2, updated_at = now()
         where ${idCol}::text = any($1)`,
        [rows.map((r) => r.id), message],
      );
      failed += rows.length;
      continue;
    }
    // **書き戻すのは、読んだ時点から本文が変わっていない行だけ。**変わっていれば取り込みが pending に戻しており、
    // 古い本文の埋め込みで上書きすると、検索が新しい本文を古いベクトルで引く。
    // source_hash は埋め込んだ文のものへ揃える（取り込みと同じ関数で作るので、普通は読んだ値と同じ）。
    const r = await db.query(
      `update mitos.${table} e set embedding = t.v::extensions.halfvec, status = 'ready', model = $5,
         source_hash = t.hash, last_error = null, updated_at = now()
       from unnest($1::text[], $2::bytea[], $3::bytea[], $4::text[]) as t(id, stored, hash, v)
       where e.${idCol}::text = t.id and e.source_hash = t.stored`,
      [
        rows.map((x) => x.id),
        rows.map((x) => x.stored),
        rows.map((x) => sha256(x.text)),
        vectors.map(vec),
        EMBED_MODEL,
      ],
    );
    embedded += r.rowCount ?? 0;
  }
  return { embedded, failed };
}

/** pending と error の知識を埋める。埋め込み文は本体から作り直す。 */
export function fillKnowledge(db: Db, env: Env): Promise<{ embedded: number; failed: number }> {
  return run(db, env, "knowledge_embedding", "knowledge_id", async () => {
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
       where e.status <> 'ready' and e.attempts < $1
       order by e.updated_at limit $2`,
      [MAX_ATTEMPTS, BATCH],
    );
    return r.rows.map((k) => {
      return { id: k.id, text: knowledgeText(k), stored: k.source_hash };
    });
  });
}

/** pending と error の発言を埋める。 */
export function fillMessages(db: Db, env: Env): Promise<{ embedded: number; failed: number }> {
  return run(db, env, "message_embedding", "message_id", async () => {
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
       where e.status <> 'ready' and e.attempts < $1
       order by e.updated_at limit $2`,
      [MAX_ATTEMPTS, BATCH],
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
