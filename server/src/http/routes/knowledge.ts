import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
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

// session の題。持ち主の最初の発言、無ければ（trace だけで残した session）結んだ作業の題。
const TITLE = `coalesce(
  (select left(m.body, 200) from mitos.message m
   where m.conversation_id = c.id and m.speaker_kind = 'self' order by m.sent_at limit 1),
  (select w.title from mitos.work_item w where w.conversation_id = c.id order by w.updated_at desc limit 1))`;

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
    const r = await (await db()).query(
      `select p.id::int, p.key, p.name,
              (select count(*) from mitos.conversation c where c.project_id = p.id and c.origin <> 'github')::int as sessions,
              (select count(*) from mitos.knowledge k where k.project_id = p.id and k.kind <> 'document')::int as knowledge,
              coalesce(json_agg(json_build_object('provider', cn.provider, 'lastSuccessAt', cn.last_success_at,
                                                  'lastError', cn.last_error) order by cn.provider)
                       filter (where cn.id is not null), '[]') as connectors
       from mitos.project p left join mitos.connector cn on cn.project_id = p.id
       group by p.id order by p.name`,
    );
    return c.json(r.rows);
  })
  // coding session の一覧。GitHub の会話は PR・issue の単位なので、ここには出さない。
  .get("/sessions", zValidator("query", conversationsQuery), async (c) => {
    const { project, page, pageSize } = c.req.valid("query");
    const pool = await db();
    const where = `c.origin <> 'github' and ($1::bigint is null or c.project_id = $1)`;
    const total = Number(
      (
        await pool.query<{ n: string }>(`select count(*) as n from mitos.conversation c where ${where}`, [
          project ?? null,
        ])
      ).rows[0]?.n ?? 0,
    );
    const r = await pool.query(
      `select c.id, c.origin, c.external_id as "sessionId", c.branch, c.started_at as "startedAt", p.name as project,
              (select max(m.sent_at) from mitos.message m where m.conversation_id = c.id) as "lastAt",
              ${TITLE} as title,
              (select count(*) from mitos.message m where m.conversation_id = c.id and m.speaker_kind = 'self')::int as said,
              (select count(*) from mitos.knowledge k where k.conversation_id = c.id and k.kind <> 'option')::int as traced
       from mitos.conversation c join mitos.project p on p.id = c.project_id
       where ${where}
       order by coalesce((select max(m.sent_at) from mitos.message m where m.conversation_id = c.id), c.started_at) desc
       limit $2 offset $3`,
      [project ?? null, pageSize, (page - 1) * pageSize],
    );
    return c.json({ items: r.rows, total, page, pageSize, pages: Math.ceil(total / pageSize) });
  })
  // 「あの判断をしたのはどの session だったか」「あのとき何と言ったか」から session を探す。
  // GitHub の会話と文書は session ではないので外す（PR・issue は検索ではなくチャットの list_items で引く）。
  .get("/sessions/search", zValidator("query", searchQuery), async (c) => {
    const { q, mode, project } = c.req.valid("query");
    const pool = await db();
    const projects = project ? [project] : null;
    const hits: Hit[] =
      mode === "said"
        ? await searchMessages(pool, env, { question: q, projects, who: "me", limit: 20 })
        : await searchKnowledge(pool, env, { question: q, projects, avoid: mode === "avoid", limit: 20 });
    if (hits.length === 0) return c.json([]);
    const [table, id] = mode === "said" ? ["mitos.message", "uuid"] : ["mitos.knowledge", "bigint"];
    const owners = await pool.query<{
      ref: string;
      id: string;
      sessionId: string;
      origin: string;
      project: string;
      title: string | null;
    }>(
      `select x.id::text as ref, c.id, c.external_id as "sessionId", c.origin, p.name as project,
              ${TITLE} as title
       from ${table} x join mitos.conversation c on c.id = x.conversation_id join mitos.project p on p.id = c.project_id
       where x.id = any($1::${id}[]) and c.origin <> 'github'`,
      [hits.map((h) => h.ref.slice(2))],
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
    const pool = await db();
    const head = await pool.query(
      `select c.id, c.origin, c.external_id as "sessionId", c.branch, c.started_at as "startedAt",
              p.id::int as "projectId", p.name as project
       from mitos.conversation c join mitos.project p on p.id = c.project_id
       where c.id = $1 and c.origin <> 'github'`,
      [id],
    );
    const conversation = head.rows[0] as { projectId: number } | undefined;
    if (!conversation) return c.json({ error: "その session は無い" }, 404);
    const messages = await pool.query(
      `select m.id, m.speaker_kind as speaker, m.body, m.sent_at as "sentAt", m.truncated, m.original_bytes as "originalBytes",
              coalesce(json_agg(json_build_object('path', f.path, 'action', f.action) order by f.path)
                       filter (where f.path is not null), '[]') as files
       from mitos.message m left join mitos.message_file f on f.message_id = m.id
       where m.conversation_id = $1 group by m.id order by m.sent_at`,
      [id],
    );
    const knowledge = await pool.query<{ kind: string; status: string | null }>(
      `select k.id::int, k.kind, k.status, k.stance, k.body, k.reason, k.confirmation, k.downsides, k.occurred_at as "at",
              k.decision_id::int as "decisionId"
       from mitos.knowledge k where k.conversation_id = $1 order by k.occurred_at, k.id`,
      [id],
    );
    const work = await pool.query(
      `select w.id::int, w.title, w.goal, w.current, w.next, w.status, w.updated_at as "updatedAt"
       from mitos.work_item w where w.conversation_id = $1`,
      [id],
    );
    // この session が触った承認済みの要件定義・設計書。同じ作業場所で同期された原文だけを返す
    // （任意の path を指定して別の作業場所の本文を取れる入口にしない）。
    const artifacts = await pool.query(
      `select distinct on (s.id) s.kind, s.metadata->>'change' as change, s.metadata->>'changeTitle' as title, s.path,
              s.body as content, s.synced_at as "syncedAt"
       from mitos.message_file f
       join mitos.message m on m.id = f.message_id
       join mitos.source_item s on s.path = f.path and s.kind in ('requirements', 'design')
       join mitos.connector cn on cn.id = s.connector_id and cn.project_id = $2
       where m.conversation_id = $1
       order by s.id`,
      [id, conversation.projectId],
    );
    return c.json({
      ...conversation,
      messages: messages.rows,
      knowledge: knowledge.rows.map((k) => ({ ...k, label: labelOf(k) })),
      work: work.rows,
      artifacts: artifacts.rows,
    });
  })
  // チャットの根拠を開いたときの全文。MCP の read と同じ関数を通す。
  .get("/read", zValidator("query", refQuery), async (c) => {
    const { ref, projects } = c.req.valid("query");
    return c.json({ text: await read(await db(), [ref], 16 * 1024, { projects }) });
  });

export default app;
