#!/usr/bin/env node
// ダッシュボードが叩く読み取り API。
//
// **資格情報はブラウザへ出さない。**DB と Voyage を触るのはここだけで、
// 画面は HTTP しか知らない。接続は読み取り専用ロールで張る（書き込み経路を作らない）。

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type pg from "pg";
import { type ChatBody, chat } from "./chat.ts";
import { connect, loadEnv } from "./db.ts";
import { candidates, identify } from "./scope.ts";
import { labelOf, type Polarity, scopeFamily, search } from "./search.ts";

const env = loadEnv(process.cwd());
let pending: Promise<pg.Client> | null = null;
function db(): Promise<pg.Client> {
  if (pending) return pending;
  const p = connect(env, { as: "read" }).then((c) => {
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

// 束ねる設定だけを書ける鍵。record / node / ref には触れないので、
// 画面が壊れてもナレッジ本体は書き換わらない。
let cfgPending: Promise<pg.Client> | null = null;
function cfg(): Promise<pg.Client> {
  if (cfgPending) return cfgPending;
  const p = connect(env, { as: "config" }).then((c) => {
    c.on("error", () => {
      if (cfgPending === p) cfgPending = null;
      c.end().catch(() => {});
    });
    return c;
  });
  p.catch(() => {
    if (cfgPending === p) cfgPending = null;
  });
  cfgPending = p;
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

// 「いま」の画面。**問いを持たずに開ける唯一の画面**にする。
// 前回どこで止まって、次に誰が何をするのか。record にあるのに画面が出していなかった。
app.get("/api/now", async (c) => {
  const client = await db();
  const r = await client.query(
    `select r.id, r.title, r.status, r.branch, r.current_at, r.current_text,
            r.phases, r.next, r.updated_at, s.label as project
     from record r join scope s on s.id = r.scope_id
     order by r.updated_at desc nulls last limit 5`,
  );
  const ids = r.rows.map((x) => x.id as string);
  // 触ってはいけないもの／やらないと決めたことは、流れの外に置く。
  const walls = ids.length
    ? await client.query(
        `select record_id, subkind, text, key from node
         where record_id = any($1) and kind = 'boundary' and deleted_at is null
         order by subkind, ordinal`,
        [ids],
      )
    : { rows: [] };
  return c.json(
    r.rows.map((x) => ({
      ...x,
      walls: walls.rows.filter((w) => w.record_id === x.id),
    })),
  );
});

// 保存した直後に人が見る画面。**機械が付けた分類を人が確かめるためのもの。**
// 直せるようにはしない — polarity は取り込みのたびに IR から計算し直されるので、
// ここで直しても次の保存で黙って戻る（ingest.ts の upsert が polarity=excluded.polarity）。
// おかしければ記録の側（/mitos:trace）を直す。
app.get("/api/review/:id", async (c) => {
  const r = await (await db()).query(
    `select id::int, kind, subkind, polarity, confidence, status, key, at, text,
            coalesce(attrs->>'whyNot', attrs->>'context', '') as ex,
            attrs, parent_id::int
     from node where record_id = $1 and deleted_at is null
     order by kind, ordinal, at nulls last`,
    [c.req.param("id")],
  );
  return c.json(r.rows);
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
  // **列を並べる。`r.*` にしない。**IR 全文（101 KB）と 1024 次元のベクトル（12 KB）が
  // 詳細を開くたびに流れていた（実測: 166 KB のうち 114 KB が画面の使わない 2 列）。
  const rec = await client.query(
    `select r.id, r.title, r.status, r.branch, r.problem, r.goal, r.current_at, r.current_text,
            r.phases, r.next, r.created_at, r.updated_at, r.ended_at, r.ingested_at,
            s.label as scope_label
     from record r join scope s on s.id = r.scope_id where r.id = $1`,
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
  // 同じファイルが「根拠」と「触った」の両方に出ると、distinct でも 2 行残る。
  // 役割をまとめて 1 行にする（画面のキーが重複していた。実測 7 件）。
  const refs = await client.query(
    `select ref.kind, ref.key, min(ref.title) as title, min(ref.url) as url,
            string_agg(distinct l.role, ',' order by l.role) as roles,
            count(*) filter (where l.exit_code is not null and l.exit_code <> 0)::int as failed
     from ref join ref_link l on l.ref_id = ref.id
     where l.record_id = $1
     group by ref.kind, ref.key
     order by ref.kind, ref.key`,
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

// 束ねる候補。~/Projects 配下と、実際に作業した場所（transcript から拾う）の和。
app.get("/api/candidates", async (c) => {
  const client = await db();
  const known = await client.query<{ ident: string; id: number }>("select ident, id::int as id from scope");
  const byIdent = new Map(known.rows.map((r) => [r.ident, r.id]));
  return c.json(
    candidates().map((x) => ({
      ident: x.ident,
      label: x.label,
      absPath: x.absPath,
      hostOrg: x.hostOrg,
      markers: x.markers,
      scopeId: byIdent.get(x.ident) ?? null,
    })),
  );
});

app.get("/api/groups", async (c) => {
  const r = await (await db()).query(
    `select g.id::int, g.name,
            coalesce(json_agg(json_build_object('id', s.id::int, 'label', s.label)
                     order by s.label) filter (where s.id is not null), '[]') as members
     from scope_group g
     left join group_member m on m.group_id = g.id
     left join scope s on s.id = m.scope_id
     group by g.id, g.name order by g.name`,
  );
  return c.json(r.rows);
});

// **束ねるのは人間が選ぶ。**推論で束ねない（org も親ディレクトリも実データで外れた）。
// 受けるのは絶対パス。ident の組み立ては CLI と同じ identify() に任せる。
app.post("/api/groups", async (c) => {
  const body = (await c.req.json()) as { name?: string; paths?: string[] };
  const name = (body.name ?? "").trim();
  const paths = Array.isArray(body.paths) ? body.paths.filter((x) => typeof x === "string" && x) : [];
  if (!name) return c.json({ error: "束の名前が空" }, 400);
  if (paths.length < 2) return c.json({ error: "2 つ以上選ぶ" }, 400);

  const client = await cfg();
  await client.query("begin");
  try {
    // **on conflict do update を使わない。**UPDATE 権限を要求するので、
    // 束ねる以外は書けない鍵では通らない（実測: permission denied）。
    const ins = await client.query<{ id: number }>(
      "insert into scope_group (name) values ($1) on conflict (name) do nothing returning id::int as id",
      [name],
    );
    const groupId =
      ins.rows[0]?.id ??
      (await client.query<{ id: number }>("select id::int as id from scope_group where name = $1", [name]))
        .rows[0]?.id;
    if (groupId === undefined) throw new Error("束を作れなかった");

    // 選び直しは「選ばれたものが全部」。外したものは束から出る。
    await client.query("delete from group_member where group_id = $1", [groupId]);
    for (const dir of paths) {
      const me = identify(dir);
      const found = await client.query<{ id: number }>("select id::int as id from scope where ident = $1", [
        me.ident,
      ]);
      let id = found.rows[0]?.id;
      if (id === undefined) {
        const created = await client.query<{ id: number }>(
          `insert into scope (ident, ident_kind, abs_path, host_org, repo_name, label)
           values ($1,$2,$3,$4,$5,$6) returning id::int as id`,
          [me.ident, me.identKind, me.absPath, me.hostOrg, me.repoName, me.label],
        );
        id = created.rows[0]?.id;
      }
      if (id !== undefined) {
        await client.query(
          "insert into group_member (group_id, scope_id) values ($1,$2) on conflict do nothing",
          [groupId, id],
        );
      }
    }
    await client.query("commit");
    return c.json({ ok: true, groupId, members: paths.length });
  } catch (e) {
    await client.query("rollback").catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.delete("/api/groups/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "id が不正" }, 400);
  const client = await cfg();
  await client.query("begin");
  try {
    await client.query("delete from group_member where group_id = $1", [id]);
    await client.query("delete from scope_group where id = $1", [id]);
    await client.query("commit");
    return c.json({ ok: true });
  } catch (e) {
    await client.query("rollback").catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// ナレッジに基づいて答える。根拠を先に流し、それから本文を少しずつ返す。
app.post("/api/chat", async (c) => {
  const body = (await c.req.json()) as ChatBody;
  const client = await db();
  // 選ばれたプロジェクトがまとめに属していれば、その相手も範囲に入れる。
  const ids = Array.isArray(body.scopeIds) ? body.scopeIds : [];
  const family = [...new Set((await Promise.all(ids.map((id) => scopeFamily(client, id)))).flat())];

  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of chat(client, env, { ...body, scopeIds: family })) {
        await stream.writeSSE({ event: chunk.type, data: JSON.stringify(chunk) });
      }
    } catch (e) {
      // 失敗も画面へ届ける。無言で止まると原因が分からない。
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: e instanceof Error ? e.message : String(e) }),
      });
    }
    await stream.writeSSE({ event: "done", data: "{}" });
  });
});

const port = Number(process.env.MITOS_API_PORT ?? 8787);
serve({ fetch: app.fetch, port }, (i) => console.log(`mitos API: http://localhost:${i.port}`));
