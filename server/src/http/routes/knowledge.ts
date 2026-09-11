import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { labelOf, logSearch, search } from "../../search.ts";
import { db, env } from "../runtime.ts";
import { positiveIds, scopesQuerySchema, textIdParamSchema } from "../validation.ts";

const sessionsQuerySchema = scopesQuerySchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const sessionSearchSchema = z
  .object({
    question: z.string().trim().min(1).max(20_000),
    onlyDont: z.boolean().optional(),
    kinds: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    scopeIds: positiveIds.optional(),
    limit: z.number().int().min(1).max(20).default(20),
  })
  .strict();

const app = new Hono()
  .get("/sessions", zValidator("query", sessionsQuerySchema), async (c) => {
    const { scopes, page, pageSize } = c.req.valid("query");
    const client = db();
    const total = Number(
      (
        await client.query<{ total: string }>(
          `select count(*) as total from record r
           where ($1::int[] is null or r.scope_id = any($1)) and r.schema_ver like 'session/%'`,
          [scopes ?? null],
        )
      ).rows[0]?.total ?? 0,
    );
    const result = await client.query(
      `select r.id, r.raw #>> '{session,id}' as session_id, r.title, r.status, r.branch,
              r.created_at, r.updated_at,
              s.label as scope_label,
              r.raw #>> '{session,host}' as host,
              (select count(*) from node
               where record_id = r.id and kind = 'utterance' and actor_kind = 'human'
                 and deleted_at is null)::int as exchanges
       from record r join scope s on s.id = r.scope_id
       where ($1::int[] is null or r.scope_id = any($1))
         and r.schema_ver like 'session/%'
       order by r.updated_at desc, r.id
       limit $2 offset $3`,
      [scopes ?? null, pageSize, (page - 1) * pageSize],
    );
    return c.json({
      items: result.rows,
      total,
      page,
      page_size: pageSize,
      pages: Math.ceil(total / pageSize),
    });
  })
  .post("/sessions/search", zValidator("json", sessionSearchSchema), async (c) => {
    const body = c.req.valid("json");
    const client = db();
    const found = await search(client, env, {
      question: body.question,
      scopeIds: body.scopeIds,
      polarity: body.onlyDont ? "dont" : undefined,
      kinds: body.kinds ?? ["decision", "option", "event", "boundary", "verification", "question"],
      limit: body.limit,
      sessionOnly: true,
    });
    await logSearch(client, {
      source: "dashboard",
      scopeId: body.scopeIds?.[0] ?? null,
      question: body.question,
      result: found,
    });
    return c.json(found.rows.map((row) => ({ ...row, id: Number(row.id), label: labelOf(row) })));
  })
  .get("/sessions/:id", zValidator("param", textIdParamSchema), async (c) => {
    const client = db();
    const { id } = c.req.valid("param");
    const record = await client.query(
      `select r.id, r.raw #>> '{session,id}' as session_id, r.title, r.status, r.branch,
              r.problem, r.goal, r.current_at, r.current_text, r.phases, r.next,
              r.created_at, r.updated_at, r.ended_at, r.ingested_at,
              s.label as scope_label,
              r.raw #>> '{session,host}' as host,
              (select count(*) from node
               where record_id = r.id and kind = 'utterance' and actor_kind = 'human'
                 and deleted_at is null)::int as exchanges
       from record r join scope s on s.id = r.scope_id
       where r.id = $1 and r.schema_ver like 'session/%'`,
      [id],
    );
    if (record.rows.length === 0) return c.json({ error: "そのセッションは無い" }, 404);
    const nodes = await client.query(
      `select id::int, kind, subkind, polarity, status, key, at, text,
              coalesce(attrs->>'context', '') as ex, attrs, parent_id::int
       from node
       where record_id = $1 and deleted_at is null and kind <> 'utterance'
       order by kind, ordinal, at nulls last`,
      [id],
    );
    return c.json({
      ...record.rows[0],
      nodes: nodes.rows.map((node) => ({ ...node, label: labelOf(node) })),
    });
  })
  .get("/scopes", async (c) => {
    const result = await db().query(
      `select s.id::int, s.label, s.ident_kind as "identKind", s.role, s.summary,
              coalesce(string_agg(distinct g.name, ', '), null) as groups,
              (select count(*) from record where scope_id = s.id)::int as records,
              (select count(*) from node where scope_id = s.id and deleted_at is null)::int as nodes
       from scope s
       left join group_member m on m.scope_id = s.id
       left join scope_group  g on g.id = m.group_id
       group by s.id order by s.label`,
    );
    return c.json(result.rows);
  })
  .get("/records", zValidator("query", scopesQuerySchema), async (c) => {
    // trace したセッションは /sessions、その他の記録はここに分ける。
    const result = await db().query(
      `select r.id, r.title, r.status, r.branch, r.problem, r.goal, r.current_at, r.current_text,
              r.updated_at, s.label as scope_label,
              (select count(*) from node where record_id = r.id and deleted_at is null)::int as nodes
       from record r join scope s on s.id = r.scope_id
       where ($1::int[] is null or r.scope_id = any($1))
         and r.schema_ver not like 'session/%'
       order by r.updated_at desc nulls last`,
      [c.req.valid("query").scopes ?? null],
    );
    return c.json(result.rows);
  })
  .get("/records/:id", zValidator("param", textIdParamSchema), async (c) => {
    const client = db();
    const { id } = c.req.valid("param");
    // Explicit columns keep the unused raw IR and vector payload out of this response.
    const record = await client.query(
      `select r.id, r.title, r.status, r.branch, r.problem, r.goal, r.current_at, r.current_text,
              r.phases, r.next, r.created_at, r.updated_at, r.ended_at, r.ingested_at,
              s.label as scope_label
       from record r join scope s on s.id = r.scope_id
       where r.id = $1 and r.schema_ver not like 'session/%'`,
      [id],
    );
    if (record.rows.length === 0) return c.json({ error: "その記録は無い" }, 404);
    const nodes = await client.query(
      `select id::int, kind, subkind, polarity, status, key, at, text,
              coalesce(attrs->>'whyNot', attrs->>'context', '') as ex, attrs, parent_id::int
       from node where record_id = $1 and deleted_at is null
       order by kind, ordinal, at nulls last`,
      [id],
    );
    const refs = await client.query(
      `select ref.kind, ref.key, min(ref.title) as title, min(ref.url) as url,
              string_agg(distinct l.role, ',' order by l.role) as roles,
              string_agg(distinct l.note, ' / ') filter (where l.note is not null) as note,
              count(*) filter (where l.exit_code is not null and l.exit_code <> 0)::int as failed
       from ref join ref_link l on l.ref_id = ref.id
       where l.record_id = $1
       group by ref.kind, ref.key
       order by ref.kind, ref.key`,
      [id],
    );
    return c.json({
      ...record.rows[0],
      nodes: nodes.rows.map((node) => ({ ...node, label: labelOf(node) })),
      refs: refs.rows,
    });
  });

export default app;
