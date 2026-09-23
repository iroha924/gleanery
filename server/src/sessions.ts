// 端末の画面（gleanery dashboard）が読むセッション・作業場所・作業の一覧。**読むだけ**で、reader の接続を渡す。
// 検索と参照は search.ts の関数を使い、ここには人向けの並べ方と束ね方だけを置く。

import { type Kysely, type SqlBool, sql } from "kysely";
import { jsonArrayFrom } from "kysely/helpers/sqlite";
import type { DB } from "./db-types.ts";
import { labelOf } from "./knowledge.ts";
import { type Hit, type Scope, searchMessages, searchSplit, toWork, type Work, workBase } from "./search.ts";

// session の題。持ち主の最初の発言、それが無ければ（trace だけで残した session）結んだ作業の題。
// 題を生成して保存することはしない（生成 API を持たない）。
const TITLE = sql<string | null>`coalesce(
  (select substr(m.body, 1, 200) from message m
   where m.conversation_id = c.id and m.speaker_kind = 'self' order by m.sent_at, m.seq limit 1),
  (select w.title from work_item w where w.conversation_id = c.id order by w.updated_at desc, w.id desc limit 1))`;

const OPENING = /^\s*<([a-z][\w-]*)(?:\s[^>]*)?>\s*/i;

/** 題の頭に付いたホストの囲みの札（`<pasted_content id="…">` など）と、その閉じ札を外す。札しか無ければそのまま。 */
function bare<T extends string | null>(title: T): T {
  if (title === null) return title;
  let rest: string = title;
  const names: string[] = [];
  for (let m = rest.match(OPENING); m?.[1]; m = rest.match(OPENING)) {
    names.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  for (const n of names) rest = rest.replaceAll(`</${n}>`, "");
  return (rest.trim() || title) as T;
}

export type Project = {
  id: number;
  key: string;
  name: string;
  sessions: number;
  knowledge: number;
  connectors: { provider: string; lastSuccessAt: Date | null; lastError: string | null }[];
};

export async function projects(db: Kysely<DB>): Promise<Project[]> {
  const rows = await db
    .selectFrom("project as p")
    .select((eb) => [
      "p.id",
      "p.key",
      "p.name",
      sql<number>`(select count(*) from conversation c where c.project_id = p.id and c.origin <> 'github')`.as(
        "sessions",
      ),
      sql<number>`(select count(*) from knowledge k where k.project_id = p.id and k.kind <> 'document')`.as(
        "knowledge",
      ),
      jsonArrayFrom(
        eb
          .selectFrom("connector as cn")
          .select(["cn.provider", "cn.last_success_at", "cn.last_error"])
          .whereRef("cn.project_id", "=", "p.id")
          .orderBy("cn.provider"),
      ).as("connectors"),
    ])
    .orderBy("p.name")
    .execute();
  return rows.map((r) => ({
    ...r,
    connectors: r.connectors.map((c) => ({
      provider: c.provider,
      lastSuccessAt: c.last_success_at === null ? null : new Date(c.last_success_at),
      lastError: c.last_error,
    })),
  }));
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
  let scoped = db.selectFrom("conversation as c").where("c.origin", "<>", "github");
  if (project !== null) scoped = scoped.where("c.project_id", "=", project);
  const counted = await scoped.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst();
  const total = counted?.n ?? 0;
  const lastAt = sql<string | null>`(select max(m.sent_at) from message m where m.conversation_id = c.id)`;
  const items = await scoped
    .innerJoin("project as p", "p.id", "c.project_id")
    .select([
      "c.id",
      "c.origin",
      "c.external_id as sessionId",
      "c.branch",
      "c.started_at as startedAt",
      "p.name as project",
      lastAt.as("lastAt"),
      TITLE.as("title"),
      sql<number>`(select count(*) from message m where m.conversation_id = c.id and m.speaker_kind = 'self')`.as(
        "said",
      ),
      sql<number>`(select count(*) from knowledge k where k.conversation_id = c.id and k.kind <> 'option')`.as(
        "traced",
      ),
      sql<number>`(select count(distinct f.path) from message_file f
        join message m on m.id = f.message_id where m.conversation_id = c.id)`.as("files"),
    ])
    .orderBy(sql`coalesce(${lastAt}, c.started_at)`, "desc")
    .orderBy("c.id")
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize)
    .execute();
  return {
    items: items.map((i) => ({
      ...i,
      startedAt: new Date(i.startedAt),
      lastAt: i.lastAt === null ? null : new Date(i.lastAt),
      // 発言も作業も持たない session は無い（自動記録は発言と一緒に会話を作り、trace は作業を作る）。
      // 発言も作業も持たない session（trace だけで作業を結ばなかった）は題が無い。空欄にせず session を名指す
      title: bare(i.title ?? "") || `（題なし）${i.sessionId}`,
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
    pages: Math.ceil(total / q.pageSize),
  };
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
  q: { q: string; mode: "knowledge" | "avoid" | "said"; project?: number | null },
): Promise<FoundSession[]> {
  const projects = q.project ? [q.project] : null;
  const hits: Hit[] =
    q.mode === "said"
      ? await searchMessages(db, { question: q.q, projects, who: "me", sessionsOnly: true, limit: 20 })
      : (await searchSplit(db, { question: q.q, projects, avoid: q.mode === "avoid", limit: 20 })).records;
  if (hits.length === 0) return [];
  // 引いた先の表が mode で変わる（発言か知識か）。
  const ids = hits.map((h) => h.ref.slice(2));
  const owners = await db
    .selectFrom("conversation as c")
    .innerJoin("project as p", "p.id", "c.project_id")
    .$if(q.mode === "said", (b) =>
      b.innerJoin("message as x", "x.conversation_id", "c.id").where("x.id", "in", ids),
    )
    .$if(q.mode !== "said", (b) =>
      b.innerJoin("knowledge as x", "x.conversation_id", "c.id").where("x.id", "in", ids.map(Number)),
    )
    .select([
      sql<string>`cast(x.id as text)`.as("ref"),
      "c.id",
      "c.external_id as sessionId",
      "c.origin",
      "p.name as project",
      TITLE.as("title"),
    ])
    .where("c.origin", "<>", "github")
    .execute();
  const ownerOf = new Map(owners.map((o) => [o.ref, o]));
  const sessions = new Map<string, FoundSession>();
  for (const h of hits) {
    const o = ownerOf.get(h.ref.slice(2));
    if (!o) continue;
    const s = sessions.get(o.id) ?? {
      id: o.id,
      sessionId: o.sessionId,
      origin: o.origin,
      project: o.project,
      title: bare(o.title),
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
    .selectFrom("conversation as c")
    .innerJoin("project as p", "p.id", "c.project_id")
    .select([
      "c.id",
      "c.origin",
      "c.external_id as sessionId",
      "c.branch",
      "c.started_at as startedAt",
      "p.id as projectId",
      "p.name as project",
      // 本文の #123 を issue へ繋ぐのに、表示名ではなく key が要る（ホストが入っている）。
      "p.key as projectKey",
      TITLE.as("title"),
    ])
    .where("c.id", "=", id)
    .where("c.origin", "<>", "github")
    .executeTakeFirst();
  if (!conversation) return null;
  const messages = await db
    .selectFrom("message as m")
    .select((eb) => [
      "m.id",
      "m.speaker_kind as speaker",
      "m.body",
      "m.sent_at as sentAt",
      "m.truncated",
      "m.original_bytes as originalBytes",
      jsonArrayFrom(
        eb
          .selectFrom("message_file as f")
          .select(["f.path", "f.action"])
          .whereRef("f.message_id", "=", "m.id")
          .orderBy("f.path")
          .orderBy("f.action"),
      ).as("files"),
    ])
    .where("m.conversation_id", "=", id)
    .orderBy("m.sent_at")
    .orderBy("m.seq")
    .execute();
  const knowledge = await db
    .selectFrom("knowledge as k")
    .select([
      "k.id",
      "k.kind",
      "k.status",
      // 生成列（型の生成が拾わない）。
      sql<Hit["stance"]>`k.stance`.as("stance"),
      "k.body",
      "k.reason",
      "k.confirmation",
      "k.downsides",
      "k.occurred_at as at",
      "k.decision_id as decisionId",
    ])
    .where("k.conversation_id", "=", id)
    .orderBy("k.occurred_at")
    .orderBy("k.id")
    .execute();
  const work = await workBase(db).where("w.conversation_id", "=", id).orderBy("w.id").execute();
  // この session が触った承認済みの要件定義・設計書。同じ作業場所で同期された原文だけを返す
  // （任意の path を指定して別の作業場所の本文を取れる入口にしない）。
  const artifacts = await db
    .selectFrom("source_item as s")
    .innerJoin("connector as cn", "cn.id", "s.connector_id")
    .select([
      "s.kind",
      sql<string | null>`json_extract(s.metadata, '$.change')`.as("change"),
      sql<string | null>`json_extract(s.metadata, '$.changeTitle')`.as("title"),
      "s.path",
      "s.body as content",
      "s.synced_at as syncedAt",
    ])
    .where("s.kind", "in", ["requirements", "design"])
    .where("cn.project_id", "=", conversation.projectId)
    .where(
      sql<SqlBool>`exists (select 1 from message_file f join message m on m.id = f.message_id
        where f.path = s.path and m.conversation_id = ${id})`,
    )
    .orderBy("s.id")
    .execute();
  return {
    ...conversation,
    startedAt: new Date(conversation.startedAt),
    title: bare(conversation.title ?? "") || `（題なし）${conversation.sessionId}`,
    messages: messages.map((m) => ({ ...m, sentAt: new Date(m.sentAt), truncated: m.truncated === 1 })),
    knowledge: knowledge.map((k) => ({ ...k, at: new Date(k.at), label: labelOf(k) })),
    work: work.map(toWork),
    artifacts: artifacts.map((a) => ({ ...a, syncedAt: new Date(a.syncedAt) })),
  };
}

/** trace した作業を、終わったものも含めて新しい順に。再開に要る詳しい中身は search.ts の workDetail で読む。 */
export async function listWork(db: Kysely<DB>, projects: Scope, limit = 100): Promise<Work[]> {
  let q = workBase(db);
  if (projects) q = q.where("w.project_id", "in", projects);
  const rows = await q.orderBy("w.updated_at", "desc").orderBy("w.id", "desc").limit(limit).execute();
  return rows.map(toWork);
}
