// 人が見る面（dashboard の API と TUI）が読むセッション・作業場所・作業の一覧。**読むだけ**で、reader の接続を渡す。
// 検索と参照は search.ts の関数を使い、ここには人向けの並べ方と束ね方だけを置く。

import { type Kysely, type SqlBool, sql } from "kysely";
import type { Env } from "./db.ts";
import type { DB } from "./db-types.ts";
import { labelOf } from "./knowledge.ts";
import { type Hit, type Scope, searchKnowledge, searchMessages, type Work } from "./search.ts";

// session の題。harvest が付けた題（server/src/titles.ts）。まだ付いていなければ持ち主の最初の発言、
// それも無ければ（trace だけで残した session）結んだ作業の題。
const TITLE = `coalesce(
  c.title,
  (select left(m.body, 200) from gleanery.message m
   where m.conversation_id = c.id and m.speaker_kind = 'self' order by m.sent_at limit 1),
  (select w.title from gleanery.work_item w where w.conversation_id = c.id order by w.updated_at desc limit 1))`;

export type Project = {
  id: number;
  key: string;
  name: string;
  sessions: number;
  knowledge: number;
  connectors: { provider: string; lastSuccessAt: Date | null; lastError: string | null }[];
};

export async function projects(db: Kysely<DB>): Promise<Project[]> {
  return db
    .selectFrom("gleanery.project as p")
    .leftJoin("gleanery.connector as cn", "cn.project_id", "p.id")
    .select([
      sql<number>`p.id::int`.as("id"),
      "p.key",
      "p.name",
      sql<number>`(select count(*) from gleanery.conversation c
        where c.project_id = p.id and c.origin <> 'github')::int`.as("sessions"),
      sql<number>`(select count(*) from gleanery.knowledge k
        where k.project_id = p.id and k.kind <> 'document')::int`.as("knowledge"),
      sql<Project["connectors"]>`
        coalesce(json_agg(json_build_object('provider', cn.provider, 'lastSuccessAt', cn.last_success_at,
                                            'lastError', cn.last_error) order by cn.provider)
                 filter (where cn.id is not null), '[]')`.as("connectors"),
    ])
    .groupBy("p.id")
    .orderBy("p.name")
    .execute();
}

export type SessionRow = {
  id: string;
  origin: string;
  sessionId: string;
  branch: string | null;
  startedAt: Date;
  project: string;
  lastAt: Date | null;
  title: string;
  /** 持ち主の発言の数 */
  said: number;
  /** trace で残した判断の数（案は数えない） */
  traced: number;
  /** 自動記録が拾った、触ったファイルの数（重複を除く） */
  files: number;
};

export type SessionsPage = {
  items: SessionRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
};

/** coding session の一覧を、最後の発言の新しい順に。GitHub の会話は PR・issue の単位なので出さない。 */
export async function listSessions(
  db: Kysely<DB>,
  q: { project?: number | null; page: number; pageSize: number },
): Promise<SessionsPage> {
  const project = q.project ?? null;
  const scoped = db
    .selectFrom("gleanery.conversation as c")
    .where("c.origin", "<>", "github")
    .where(sql<SqlBool>`(${project}::bigint is null or c.project_id = ${project})`);
  const counted = await scoped.select((eb) => eb.fn.countAll().as("n")).executeTakeFirst();
  const total = Number(counted?.n ?? 0);
  const items = await scoped
    .innerJoin("gleanery.project as p", "p.id", "c.project_id")
    .select([
      "c.id",
      "c.origin",
      "c.external_id as sessionId",
      "c.branch",
      "c.started_at as startedAt",
      "p.name as project",
      sql<Date | null>`(select max(m.sent_at) from gleanery.message m where m.conversation_id = c.id)`.as(
        "lastAt",
      ),
      sql<string>`${sql.raw(TITLE)}`.as("title"),
      sql<number>`(select count(*) from gleanery.message m
        where m.conversation_id = c.id and m.speaker_kind = 'self')::int`.as("said"),
      sql<number>`(select count(*) from gleanery.knowledge k
        where k.conversation_id = c.id and k.kind <> 'option')::int`.as("traced"),
      sql<number>`(select count(distinct f.path) from gleanery.message_file f
        join gleanery.message m on m.id = f.message_id where m.conversation_id = c.id)::int`.as("files"),
    ])
    .orderBy(
      sql`coalesce((select max(m.sent_at) from gleanery.message m where m.conversation_id = c.id), c.started_at)`,
      "desc",
    )
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize)
    .execute();
  return { items, total, page: q.page, pageSize: q.pageSize, pages: Math.ceil(total / q.pageSize) };
}

export type FoundSession = {
  id: string;
  sessionId: string;
  origin: string;
  project: string;
  title: string | null;
  hits: Pick<Hit, "ref" | "label" | "stance" | "text" | "reason" | "at">[];
};

/**
 * 「あの判断をしたのはどの session だったか」「あのとき何と言ったか」から session を探す。
 * GitHub の会話と文書は session ではないので外す。
 */
export async function searchSessions(
  db: Kysely<DB>,
  env: Env,
  q: { q: string; mode: "knowledge" | "avoid" | "said"; project?: number | null },
): Promise<FoundSession[]> {
  const projects = q.project ? [q.project] : null;
  const hits: Hit[] =
    q.mode === "said"
      ? await searchMessages(db, env, { question: q.q, projects, who: "me", sessionsOnly: true, limit: 20 })
      : await searchKnowledge(db, env, { question: q.q, projects, avoid: q.mode === "avoid", limit: 20 });
  if (hits.length === 0) return [];
  const [table, id] = q.mode === "said" ? ["gleanery.message", "uuid"] : ["gleanery.knowledge", "bigint"];
  // 引いた先の表が mode で変わる（発言か知識か）。表と id の型が実行時に決まるので、ここだけ組み立てる。
  const owners = await sql<{
    ref: string;
    id: string;
    sessionId: string;
    origin: string;
    project: string;
    title: string | null;
  }>`
    select x.id::text as ref, c.id, c.external_id as "sessionId", c.origin, p.name as project,
           ${sql.raw(TITLE)} as title
    from ${sql.table(table)} x
    join gleanery.conversation c on c.id = x.conversation_id
    join gleanery.project p on p.id = c.project_id
    where x.id = any(${hits.map((h) => h.ref.slice(2))}::${sql.raw(id)}[]) and c.origin <> 'github'`.execute(
    db,
  );
  const ownerOf = new Map(owners.rows.map((o) => [o.ref, o]));
  const sessions = new Map<string, FoundSession>();
  for (const h of hits) {
    const o = ownerOf.get(h.ref.slice(2));
    if (!o) continue;
    const s = sessions.get(o.id) ?? {
      id: o.id,
      sessionId: o.sessionId,
      origin: o.origin,
      project: o.project,
      title: o.title,
      hits: [],
    };
    s.hits.push({ ref: h.ref, label: h.label, stance: h.stance, text: h.text, reason: h.reason, at: h.at });
    sessions.set(o.id, s);
  }
  return [...sessions.values()];
}

export type SessionDetail = NonNullable<Awaited<ReturnType<typeof sessionDetail>>>;

/** session 1 件の発言・触ったファイル・trace した知識と作業・読んだ承認済みの要件定義と設計書。無ければ null。 */
export async function sessionDetail(db: Kysely<DB>, id: string) {
  const conversation = await db
    .selectFrom("gleanery.conversation as c")
    .innerJoin("gleanery.project as p", "p.id", "c.project_id")
    .select([
      "c.id",
      "c.origin",
      "c.external_id as sessionId",
      "c.branch",
      "c.started_at as startedAt",
      sql<number>`p.id::int`.as("projectId"),
      "p.name as project",
      // 本文の #123 を issue へ繋ぐのに、表示名ではなく key が要る（ホストが入っている）。
      "p.key as projectKey",
      sql<string>`${sql.raw(TITLE)}`.as("title"),
    ])
    .where("c.id", "=", id)
    .where("c.origin", "<>", "github")
    .executeTakeFirst();
  if (!conversation) return null;
  const messages = await db
    .selectFrom("gleanery.message as m")
    .leftJoin("gleanery.message_file as f", "f.message_id", "m.id")
    .select([
      "m.id",
      "m.speaker_kind as speaker",
      "m.body",
      "m.sent_at as sentAt",
      "m.truncated",
      "m.original_bytes as originalBytes",
      sql<{ path: string; action: string }[]>`
        coalesce(json_agg(json_build_object('path', f.path, 'action', f.action) order by f.path)
                 filter (where f.path is not null), '[]')`.as("files"),
    ])
    .where("m.conversation_id", "=", id)
    .groupBy("m.id")
    .orderBy("m.sent_at")
    .execute();
  const knowledge = await db
    .selectFrom("gleanery.knowledge as k")
    .select([
      sql<number>`k.id::int`.as("id"),
      "k.kind",
      "k.status",
      "k.stance",
      "k.body",
      "k.reason",
      "k.confirmation",
      "k.downsides",
      "k.occurred_at as at",
      sql<number | null>`k.decision_id::int`.as("decisionId"),
    ])
    .where("k.conversation_id", "=", id)
    .orderBy("k.occurred_at")
    .orderBy("k.id")
    .execute();
  const work = await db
    .selectFrom("gleanery.work_item as w")
    .select([
      sql<number>`w.id::int`.as("id"),
      "w.title",
      "w.goal",
      "w.current",
      "w.next",
      "w.status",
      "w.updated_at as updatedAt",
    ])
    .where("w.conversation_id", "=", id)
    .execute();
  // この session が触った承認済みの要件定義・設計書。同じ作業場所で同期された原文だけを返す
  // （任意の path を指定して別の作業場所の本文を取れる入口にしない）。
  const artifacts = await db
    .selectFrom("gleanery.message_file as f")
    .innerJoin("gleanery.message as m", "m.id", "f.message_id")
    .innerJoin("gleanery.source_item as s", (j) =>
      j.onRef("s.path", "=", "f.path").on("s.kind", "in", ["requirements", "design"]),
    )
    .innerJoin("gleanery.connector as cn", (j) =>
      j.onRef("cn.id", "=", "s.connector_id").on("cn.project_id", "=", String(conversation.projectId)),
    )
    .distinctOn("s.id")
    .select([
      "s.kind",
      sql<string | null>`s.metadata->>'change'`.as("change"),
      sql<string | null>`s.metadata->>'changeTitle'`.as("title"),
      "s.path",
      "s.body as content",
      "s.synced_at as syncedAt",
    ])
    .where("m.conversation_id", "=", id)
    .orderBy("s.id")
    .execute();
  return {
    ...conversation,
    messages,
    knowledge: knowledge.map((k) => ({ ...k, label: labelOf(k) })),
    work,
    artifacts,
  };
}

/** trace した作業を、終わったものも含めて新しい順に。再開に要る詳しい中身は search.ts の workDetail で読む。 */
export async function listWork(db: Kysely<DB>, projects: Scope, limit = 100): Promise<Work[]> {
  let q = db
    .selectFrom("gleanery.work_item as w")
    .innerJoin("gleanery.project as p", "p.id", "w.project_id")
    .select([
      sql<string>`w.id::text`.as("id"),
      "p.name as project",
      "w.title",
      "w.goal",
      "w.current",
      "w.next",
      "w.status",
      "w.updated_at",
    ]);
  if (projects) q = q.where(sql<SqlBool>`w.project_id = any(${projects})`);
  const rows = await q.orderBy("w.updated_at", "desc").orderBy("w.id", "desc").limit(limit).execute();
  return rows.map((w) => ({
    ref: `w:${w.id}`,
    project: w.project,
    title: w.title,
    goal: w.goal,
    current: w.current,
    next: w.next,
    status: w.status,
    updatedAt: w.updated_at,
  }));
}
