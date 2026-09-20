import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { type SqlBool, sql } from "kysely";
import { z } from "zod";
import { labelOf } from "../../knowledge.ts";
import { type Hit, REF, read, searchKnowledge, searchMessages } from "../../search.ts";
import { db, env } from "../runtime.ts";
import { positiveId, positiveIds, uuidParamSchema } from "../validation.ts";

const conversationsQuery = z.object({
  project: positiveId.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});

// 判断（knowledge）・通ってはいけない道（avoid）・持ち主の発言（said）で引き、どの session の記録かでまとめる。
const searchQuery = z.object({
  q: z.string().trim().min(1).max(500),
  mode: z.enum(["knowledge", "avoid", "said"]).default("knowledge"),
  project: positiveId.optional(),
});

// session の題。harvest が付けた題（server/src/titles.ts）。まだ付いていなければ持ち主の最初の発言、
// それも無ければ（trace だけで残した session）結んだ作業の題。
const TITLE = `coalesce(
  c.title,
  (select left(m.body, 200) from gleanery.message m
   where m.conversation_id = c.id and m.speaker_kind = 'self' order by m.sent_at limit 1),
  (select w.title from gleanery.work_item w where w.conversation_id = c.id order by w.updated_at desc limit 1))`;

// どの作業場所について読むかは画面が持つ（チャットで選んだ作業場所）。その外の参照は「無い」と返す。
const refQuery = z.object({
  ref: z.string().regex(REF),
  projects: z
    .string()
    .transform((v) => v.split(",").map(Number))
    .pipe(positiveIds.min(1)),
});

const app = new Hono()
  .get("/projects", async (c) => {
    const rows = await db
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
        sql<{ provider: string; lastSuccessAt: Date | null; lastError: string | null }[]>`
          coalesce(json_agg(json_build_object('provider', cn.provider, 'lastSuccessAt', cn.last_success_at,
                                              'lastError', cn.last_error) order by cn.provider)
                   filter (where cn.id is not null), '[]')`.as("connectors"),
      ])
      .groupBy("p.id")
      .orderBy("p.name")
      .execute();
    return c.json(rows);
  })
  // coding session の一覧。GitHub の会話は PR・issue の単位なので、ここには出さない。
  .get("/sessions", zValidator("query", conversationsQuery), async (c) => {
    const { project, page, pageSize } = c.req.valid("query");
    const scoped = db
      .selectFrom("gleanery.conversation as c")
      .where("c.origin", "<>", "github")
      .where(sql<SqlBool>`(${project ?? null}::bigint is null or c.project_id = ${project ?? null})`);
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
      ])
      .orderBy(
        sql`coalesce((select max(m.sent_at) from gleanery.message m where m.conversation_id = c.id), c.started_at)`,
        "desc",
      )
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();
    return c.json({ items, total, page, pageSize, pages: Math.ceil(total / pageSize) });
  })
  // 「あの判断をしたのはどの session だったか」「あのとき何と言ったか」から session を探す。
  // GitHub の会話と文書は session ではないので外す（PR・issue は検索ではなくチャットの list_items で引く）。
  .get("/sessions/search", zValidator("query", searchQuery), async (c) => {
    const { q, mode, project } = c.req.valid("query");
    const projects = project ? [project] : null;
    const hits: Hit[] =
      mode === "said"
        ? await searchMessages(db, env, { question: q, projects, who: "me", sessionsOnly: true, limit: 20 })
        : await searchKnowledge(db, env, { question: q, projects, avoid: mode === "avoid", limit: 20 });
    if (hits.length === 0) return c.json([]);
    const [table, id] = mode === "said" ? ["gleanery.message", "uuid"] : ["gleanery.knowledge", "bigint"];
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
    type Found = { id: string; sessionId: string; origin: string; project: string; title: string | null };
    const sessions = new Map<
      string,
      Found & { hits: Pick<Hit, "ref" | "label" | "stance" | "text" | "reason" | "at">[] }
    >();
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
    return c.json([...sessions.values()]);
  })
  .get("/sessions/:id", zValidator("param", uuidParamSchema), async (c) => {
    const { id } = c.req.valid("param");
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
        sql<string>`${sql.raw(TITLE)}`.as("title"),
      ])
      .where("c.id", "=", id)
      .where("c.origin", "<>", "github")
      .executeTakeFirst();
    if (!conversation) return c.json({ error: "その session は無い" }, 404);
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
    return c.json({
      ...conversation,
      messages,
      knowledge: knowledge.map((k) => ({ ...k, label: labelOf(k) })),
      work,
      artifacts,
    });
  })
  // チャットの根拠を開いたときの全文。MCP の read と同じ関数を通す。
  .get("/read", zValidator("query", refQuery), async (c) => {
    const { ref, projects } = c.req.valid("query");
    return c.json({ text: await read(db, [ref], 16 * 1024, { projects }) });
  });

export default app;
