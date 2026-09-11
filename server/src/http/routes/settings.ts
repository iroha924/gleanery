import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { candidates, identify, rememberPath } from "../../scope.ts";
import { cfg, db } from "../runtime.ts";
import { idParamSchema, positiveId, scopesQuerySchema } from "../validation.ts";

const groupSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    paths: z.array(z.string().trim().min(1).max(4096)).min(2).max(100),
  })
  .strict();

const termSchema = z
  .object({
    word: z.string().trim().min(1).max(200),
    meaning: z.string().trim().max(20_000).optional(),
    aliases: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
    groupId: positiveId.optional(),
  })
  .strict();

const app = new Hono()
  .get("/candidates", async (c) => {
    const known = await db().query<{ ident: string; id: number }>("select ident, id::int as id from scope");
    const byIdent = new Map(known.rows.map((row) => [row.ident, row.id]));
    return c.json(
      candidates().map((candidate) => ({
        ident: candidate.ident,
        label: candidate.label,
        absPath: candidate.absPath,
        hostOrg: candidate.hostOrg,
        markers: candidate.markers,
        scopeId: byIdent.get(candidate.ident) ?? null,
      })),
    );
  })
  .get("/groups", async (c) => {
    const result = await db().query(
      `select g.id::int, g.name,
              coalesce(json_agg(json_build_object('id', s.id::int, 'label', s.label,
                                'identKind', s.ident_kind, 'ident', s.ident)
                       order by s.label) filter (where s.id is not null), '[]') as members
       from scope_group g
       left join group_member m on m.group_id = g.id
       left join scope s on s.id = m.scope_id
       group by g.id, g.name order by g.name`,
    );
    return c.json(result.rows);
  })
  .post("/groups", zValidator("json", groupSchema), async (c) => {
    const { name, paths } = c.req.valid("json");
    // Only paths discovered on this host may be persisted as this host's locations.
    const known = new Set(candidates().map((candidate) => candidate.absPath));
    const unknown = paths.filter((path) => !known.has(path));
    if (unknown.length > 0) {
      return c.json(
        {
          error:
            known.size === 0 ? "このホストには束ねられる置き場所が無い" : "候補に無い置き場所は登録できない",
        },
        400,
      );
    }

    const client = await cfg().connect();
    try {
      await client.query("begin");
      // The config role cannot UPDATE scope_group, so resolve conflicts with INSERT then SELECT.
      const inserted = await client.query<{ id: number }>(
        "insert into scope_group (name) values ($1) on conflict (name) do nothing returning id::int as id",
        [name],
      );
      const groupId =
        inserted.rows[0]?.id ??
        (await client.query<{ id: number }>("select id::int as id from scope_group where name = $1", [name]))
          .rows[0]?.id;
      if (groupId === undefined) throw new Error("束を作れなかった");

      await client.query("delete from group_member where group_id = $1", [groupId]);
      for (const path of paths) {
        const identified = identify(path);
        const found = await client.query<{ id: number }>("select id::int as id from scope where ident = $1", [
          identified.ident,
        ]);
        let scopeId = found.rows[0]?.id;
        if (scopeId === undefined) {
          const created = await client.query<{ id: number }>(
            `insert into scope (ident, ident_kind, abs_path, host_org, repo_name, label)
             values ($1,$2,$3,$4,$5,$6) on conflict (ident) do nothing returning id::int as id`,
            [
              identified.ident,
              identified.identKind,
              identified.absPath,
              identified.hostOrg,
              identified.repoName,
              identified.label,
            ],
          );
          scopeId =
            created.rows[0]?.id ??
            (
              await client.query<{ id: number }>("select id::int as id from scope where ident = $1", [
                identified.ident,
              ])
            ).rows[0]?.id;
        }
        if (scopeId !== undefined) {
          await rememberPath(client, scopeId, identified.absPath);
          await client.query(
            "insert into group_member (group_id, scope_id) values ($1,$2) on conflict do nothing",
            [groupId, scopeId],
          );
        }
      }
      await client.query("commit");
      return c.json({ ok: true, groupId, members: paths.length });
    } catch (error) {
      await client.query("rollback").catch(() => {});
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    } finally {
      client.release();
    }
  })
  .delete("/groups/:id", zValidator("param", idParamSchema), async (c) => {
    const client = await cfg().connect();
    try {
      await client.query("begin");
      await client.query("delete from group_member where group_id = $1", [c.req.valid("param").id]);
      await client.query("delete from scope_group where id = $1", [c.req.valid("param").id]);
      await client.query("commit");
      return c.json({ ok: true });
    } catch (error) {
      await client.query("rollback").catch(() => {});
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    } finally {
      client.release();
    }
  })
  .get("/terms", zValidator("query", scopesQuerySchema), async (c) => {
    const result = await db().query(
      `select t.id::int, t.word, t.aliases, t.meaning, t.asked_why, t.asked_at, g.name as project
       from term t left join scope_group g on g.id = t.group_id
       where $1::int[] is null or t.group_id is null or t.group_id in (
         select m.group_id from group_member m where m.scope_id = any($1))
       order by (t.meaning is null) desc, t.asked_at desc nulls last, t.word`,
      [c.req.valid("query").scopes ?? null],
    );
    return c.json(result.rows);
  })
  .post("/terms", zValidator("json", termSchema), async (c) => {
    const body = c.req.valid("json");
    try {
      await cfg().query(
        `insert into term (group_id, word, meaning, aliases) values ($1,$2,$3,$4)
         on conflict (coalesce(group_id, 0), word) do update set
           meaning = coalesce(excluded.meaning, term.meaning),
           aliases = excluded.aliases, updated_at = now()`,
        [body.groupId ?? null, body.word, body.meaning || null, body.aliases],
      );
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  })
  .delete("/terms/:id", zValidator("param", idParamSchema), async (c) => {
    try {
      await cfg().query("delete from term where id = $1", [c.req.valid("param").id]);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

export default app;
