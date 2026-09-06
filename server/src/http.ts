#!/usr/bin/env node
// ダッシュボードが叩く読み取り API。
//
// **資格情報はブラウザへ出さない。**DB と Voyage を触るのはここだけで、
// 画面は HTTP しか知らない。接続は読み取り専用ロールで張る（書き込み経路を作らない）。

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type pg from "pg";
import { connect, loadEnv } from "./db.ts";
import { identify } from "./scope.ts";
import { labelOf, type Polarity, scopeFamily, search } from "./search.ts";

const env = loadEnv(process.cwd());
let pending: Promise<pg.Client> | null = null;
function db(): Promise<pg.Client> {
  if (pending) return pending;
  const p = connect(env, { readOnly: true }).then((c) => {
    c.on("error", () => {
      if (pending === p) pending = null;
      c.end().catch(() => {});
    });
    return c;
  });
  p.catch(() => {
    if (pending === p) pending = null;
  });
  pending = p;
  return p;
}

const app = new Hono();
// 開発中は Vite が別ポートで動く。読み取りしかしないので localhost に限って許す。
app.use("/api/*", cors({ origin: (o) => (/^http:\/\/localhost:\d+$/.test(o) ? o : null) }));

app.get("/api/stats", async (c) => {
  const q = await (await db()).query<{ nodes: number; records: number; scopes: number; refs: number }>(
    `select (select count(*) from node where deleted_at is null)::int nodes,
            (select count(*) from record)::int records,
            (select count(*) from scope)::int scopes,
            (select count(*) from ref)::int refs`,
  );
  return c.json(q.rows[0]);
});

app.get("/api/scopes", async (c) => {
  const q = await (await db()).query(
    `select s.id::int, s.label, s.role, s.summary,
            coalesce(string_agg(distinct g.name, ', '), null) as groups,
            (select count(*) from record where scope_id = s.id)::int as records,
            (select count(*) from node where scope_id = s.id and deleted_at is null)::int as nodes
     from scope s
     left join group_member m on m.scope_id = s.id
     left join scope_group  g on g.id = m.group_id
     group by s.id order by s.label`,
  );
  return c.json(q.rows);
});

app.get("/api/records", async (c) => {
  const q = await (await db()).query(
    `select r.id, r.title, r.status, r.branch, r.problem, r.goal, r.current_at, r.current_text,
            r.updated_at, s.label as scope_label,
            (select count(*) from node where record_id = r.id and deleted_at is null)::int as nodes
     from record r join scope s on s.id = r.scope_id
     order by r.updated_at desc nulls last`,
  );
  return c.json(q.rows);
});

app.get("/api/records/:id", async (c) => {
  const client = await db();
  const rec = await client.query(
    `select r.*, s.label as scope_label from record r join scope s on s.id = r.scope_id where r.id = $1`,
    [c.req.param("id")],
  );
  if (rec.rows.length === 0) return c.json({ error: "その記録は無い" }, 404);
  const nodes = await client.query(
    `select id::int, kind, subkind, polarity, status, key, at, text,
            coalesce(attrs->>'whyNot', attrs->>'context', '') as ex, attrs, parent_id::int
     from node where record_id = $1 and deleted_at is null
     order by kind, ordinal, at nulls last`,
    [c.req.param("id")],
  );
  const refs = await client.query(
    `select distinct ref.kind, ref.key, ref.title, ref.url, l.role
     from ref join ref_link l on l.ref_id = ref.id
     where l.record_id = $1 order by ref.kind, ref.key`,
    [c.req.param("id")],
  );
  return c.json({
    ...rec.rows[0],
    nodes: nodes.rows.map((n) => ({ ...n, label: labelOf(n) })),
    refs: refs.rows,
  });
});

app.post("/api/search", async (c) => {
  const body = (await c.req.json()) as {
    question?: string;
    onlyDont?: boolean;
    kinds?: string[];
    cwd?: string;
    allScopes?: boolean;
    limit?: number;
  };
  const question = (body.question ?? "").trim();
  if (!question) return c.json({ error: "質問が空" }, 400);
  const limit = Math.min(Math.max(Number(body.limit ?? 10), 1), 20);

  const client = await db();
  let scopeIds: number[] | undefined;
  if (!body.allScopes && body.cwd) {
    const me = identify(body.cwd);
    const r = await client.query<{ id: number }>("select id::int as id from scope where ident = $1", [
      me.ident,
    ]);
    const row = r.rows[0];
    scopeIds = row ? await scopeFamily(client, row.id) : [];
  }
  const polarity: Polarity | undefined = body.onlyDont ? "dont" : undefined;
  const { rows } = await search(client, env, { question, scopeIds, polarity, kinds: body.kinds, limit });
  return c.json(rows.map((r) => ({ ...r, label: labelOf(r) })));
});

const port = Number(process.env.MITOS_API_PORT ?? 8787);
serve({ fetch: app.fetch, port }, (i) => console.log(`mitos API: http://localhost:${i.port}`));
