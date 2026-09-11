import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { currentWork, labelOf, logSearch, type Polarity, search } from "../../search.ts";
import { db, env } from "../runtime.ts";
import { positiveIds, scopesQuerySchema, textIdParamSchema } from "../validation.ts";

const searchSchema = z
  .object({
    question: z.string().trim().min(1).max(20_000),
    onlyDont: z.boolean().optional(),
    kinds: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    scopeIds: positiveIds.optional(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

const app = new Hono()
  .get("/now", zValidator("query", scopesQuerySchema), async (c) => {
    return c.json(await currentWork(db(), c.req.valid("query").scopes ?? null));
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
    // Session imports lack the phases and next action needed by this work map; search still reaches them.
    const result = await db().query(
      `select r.id, r.title, r.status, r.branch, r.problem, r.goal, r.current_at, r.current_text,
              r.updated_at, s.label as scope_label,
              (select count(*) from node where record_id = r.id and deleted_at is null)::int as nodes
       from record r join scope s on s.id = r.scope_id
       where ($1::int[] is null or r.scope_id = any($1))
         and r.schema_ver <> 'session/1'
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
       from record r join scope s on s.id = r.scope_id where r.id = $1`,
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
  })
  .post("/search", zValidator("json", searchSchema), async (c) => {
    const body = c.req.valid("json");
    const client = db();
    const polarity: Polarity | undefined = body.onlyDont ? "dont" : undefined;
    const found = await search(client, env, {
      question: body.question,
      scopeIds: body.scopeIds,
      polarity,
      kinds: body.kinds,
      limit: body.limit,
    });
    await logSearch(client, {
      source: "dashboard",
      scopeId: body.scopeIds?.[0] ?? null,
      question: body.question,
      result: found,
    });
    return c.json(found.rows.map((row) => ({ ...row, id: Number(row.id), label: labelOf(row) })));
  });

export default app;
