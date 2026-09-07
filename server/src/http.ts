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
import { type ChatBody, chat, type Learn } from "./chat.ts";
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

/**
 * 画面がいま開いているプロジェクトの範囲。
 *
 * **絞り込みは画面が決める。**「いま何を見ているのか」は 1 箇所（ヘッダの切り替え）で決まり、
 * 画面ごとに別々の範囲を持たない。指定が無いときは「すべて」なので絞らない。
 */
function scopesOf(c: { req: { query: (k: string) => string | undefined } }): number[] | null {
  const raw = c.req.query("scopes");
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((x) => Number(x))
    .filter((x) => Number.isInteger(x) && x > 0);
  // **空文字は「どれも見ない」。**未指定（null）と区別する。
  return ids;
}

app.get("/api/stats", async (c) => {
  const ids = scopesOf(c);
  const q = await (await db()).query<{ nodes: number; records: number; scopes: number; refs: number }>(
    `select (select count(*) from node where deleted_at is null and ($1::int[] is null or scope_id = any($1)))::int nodes,
            (select count(*) from record where ($1::int[] is null or scope_id = any($1)))::int records,
            (select count(*) from scope where ($1::int[] is null or id = any($1)))::int scopes,
            (select count(*) from ref l where ($1::int[] is null or exists (
               select 1 from ref_link k join record r on r.id = k.record_id
               where k.ref_id = l.id and r.scope_id = any($1))))::int refs`,
    [ids],
  );
  return c.json(q.rows[0]);
});

/**
 * 地図の材料。**節と辺を 1 往復で返す。**
 *
 * 辺は 2 系統ある。どちらも既にある列から導けるもので、`relation` 表は使っていない
 * （書き手がまだ無く 0 行なので、参照しても線が 1 本も出ない）。
 *
 * - `rejected` / `considered` … `node.parent_id`。案は決定にぶら下がるので、これが
 *   「その決定のときに捨てた案」を正確に表す
 * - `shares` … 同じ PR / ファイルに紐づく節どうし。**多く紐づく ref は辺にしない**
 *   （1 つの ref に 30 節ぶら下がると、そこだけで 435 本の辺が出て図が潰れる）
 *
 * 既定では発言と出来事を外す。判断の地図なので、PR コメント 1 件ずつを節にすると
 * 判断が埋もれる。`kinds=all` で全部返す。
 */
const JUDGMENT_KINDS = ["decision", "option", "boundary", "verification", "question"];

app.get("/api/graph", async (c) => {
  const ids = scopesOf(c);
  const kindsRaw = c.req.query("kinds");
  const kinds = !kindsRaw ? JUDGMENT_KINDS : kindsRaw === "all" ? null : kindsRaw.split(",");
  const client = await db();

  const nodes = await client.query<{
    id: number;
    kind: string;
    subkind: string | null;
    polarity: string | null;
    text: string;
    at: string | null;
    actor_name: string | null;
    record_id: string;
    pr: number | null;
  }>(
    // **bigint をそのまま返さない。**pg は bigint を文字列で返すので、画面側で
    // 引用の節 id（数）と突き合わせたときに一致しない（実測: 強調が 1 つも点かなかった）。
    `select n.id::int as id, n.kind, n.subkind, n.polarity, n.text, n.at, n.actor_name, n.record_id,
            (n.attrs->>'pr')::int as pr
       from node n
      where n.deleted_at is null
        and ($1::int[] is null or n.scope_id = any($1))
        and ($2::text[] is null or n.kind = any($2))
      order by n.at desc nulls last
      limit 600`,
    [ids, kinds],
  );

  const nodeIds = nodes.rows.map((r) => r.id);
  if (nodeIds.length === 0) return c.json({ nodes: [], edges: [] });

  // **両端が返した節に入っている辺だけを出す。**片側だけの辺は描けないので、
  // ここで落としておかないと画面側が毎回間引くことになる。
  const edges = await client.query<{ src: number; dst: number; kind: string; via: string | null }>(
    `select child.parent_id::int as src, child.id::int as dst,
            case when child.subkind = 'rejected' then 'rejected' else 'considered' end as kind,
            null::text as via
       from node child
      where child.deleted_at is null
        and child.parent_id = any($1::bigint[])
        and child.id = any($1::bigint[])
      union all
     select distinct least(a.node_id, b.node_id)::int as src, greatest(a.node_id, b.node_id)::int as dst,
            'shares' as kind, r.kind || ':' || r.key as via
       from ref_link a
       join ref_link b on b.ref_id = a.ref_id and b.node_id > a.node_id
       join ref r on r.id = a.ref_id
       join (select ref_id from ref_link where node_id is not null
              group by ref_id having count(*) between 2 and 8) small on small.ref_id = a.ref_id
      where a.node_id = any($1::bigint[]) and b.node_id = any($1::bigint[])`,
    [nodeIds],
  );

  return c.json({ nodes: nodes.rows, edges: edges.rows });
});

// 「いま」の画面。**問いを持たずに開ける唯一の画面**にする。
// 前回どこで止まって、次に誰が何をするのか。record にあるのに画面が出していなかった。
app.get("/api/now", async (c) => {
  const client = await db();
  const r = await client.query(
    `select r.id, r.title, r.status, r.branch, r.current_at, r.current_text,
            r.phases, r.next, r.updated_at, s.label as project
     from record r join scope s on s.id = r.scope_id
     where ($1::int[] is null or r.scope_id = any($1))
     order by r.updated_at desc nulls last limit 5`,
    [scopesOf(c)],
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
     where ($1::int[] is null or r.scope_id = any($1))
     order by r.updated_at desc nulls last`,
    [scopesOf(c)],
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
    scopeIds?: number[];
    limit?: number;
  };
  const question = (body.question ?? "").trim();
  if (!question) return c.json({ error: "質問が空" }, 400);
  const limit = Math.min(Math.max(Number(body.limit ?? 10), 1), 20);

  const client = await db();
  // 範囲はヘッダで選んだものが来る。**未指定は「すべて」**（絞らない）。
  const scopeIds = Array.isArray(body.scopeIds) ? body.scopeIds : undefined;
  const polarity: Polarity | undefined = body.onlyDont ? "dont" : undefined;
  const { rows } = await search(client, env, { question, scopeIds, polarity, kinds: body.kinds, limit });
  // **id は数で返す。**pg は bigint を文字列で返すので、地図の節と突き合わせられない。
  return c.json(rows.map((r) => ({ ...r, id: Number(r.id), label: labelOf(r) })));
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
            coalesce(json_agg(json_build_object('id', s.id::int, 'label', s.label,
                              'identKind', s.ident_kind, 'ident', s.ident)
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

// 束ごとに issue の出どころを持つ。
//
// **課題管理はプロジェクトごとに違う**（GitHub / Linear / Jira）。出どころは
// リポジトリではないので、tracker の作業場所として束へ足す。こうしておくと、
// チャットでプロジェクトを選んだときに issue も一緒に引ける。
const TRACKERS: Record<string, string> = { linear: "Linear", github: "GitHub", jira: "Jira" };

app.post("/api/groups/:id/tracker", async (c) => {
  const groupId = Number(c.req.param("id"));
  const body = (await c.req.json()) as { kind?: string; ident?: string };
  const kind = (body.kind ?? "").trim();
  const ident = (body.ident ?? "").trim();
  if (!Number.isInteger(groupId)) return c.json({ error: "id が不正" }, 400);
  if (!TRACKERS[kind]) return c.json({ error: `知らない出どころ: ${kind}` }, 400);
  if (!ident) return c.json({ error: "識別子が空（Linear ならチーム名、Jira ならプロジェクトキー）" }, 400);

  const client = await cfg();
  await client.query("begin");
  try {
    const key = `${kind}:${ident}`;
    const found = await client.query<{ id: number }>("select id::int as id from scope where ident = $1", [
      key,
    ]);
    const id =
      found.rows[0]?.id ??
      (
        await client.query<{ id: number }>(
          `insert into scope (ident, ident_kind, abs_path, host_org, repo_name, label, role)
           values ($1,'tracker',null,null,null,$2,'issue-tracker') returning id::int as id`,
          [key, `${TRACKERS[kind]}: ${ident}`],
        )
      ).rows[0]?.id;
    if (id === undefined) throw new Error("出どころを作れなかった");
    await client.query(
      "insert into group_member (group_id, scope_id) values ($1,$2) on conflict do nothing",
      [groupId, id],
    );
    await client.query("commit");
    return c.json({ ok: true, scopeId: id });
  } catch (e) {
    await client.query("rollback").catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// --- 用語集 ---
//
// **推測で埋めない。**社内語は人に聞くしかないので、AI が答えられなかった語を
// meaning が null の行として積み、人が答えたら埋まる。
app.get("/api/terms", async (c) => {
  const ids = scopesOf(c);
  const r = await (await db()).query(
    `select t.id::int, t.word, t.aliases, t.meaning, t.asked_why, t.asked_at, g.name as project
     from term t left join scope_group g on g.id = t.group_id
     where $1::int[] is null or t.group_id is null or t.group_id in (
       select m.group_id from group_member m where m.scope_id = any($1))
     order by (t.meaning is null) desc, t.asked_at desc nulls last, t.word`,
    [ids],
  );
  return c.json(r.rows);
});

app.post("/api/terms", async (c) => {
  const body = (await c.req.json()) as {
    word?: string;
    meaning?: string;
    aliases?: string[];
    groupId?: number;
  };
  const word = (body.word ?? "").trim();
  if (!word) return c.json({ error: "言葉が空" }, 400);
  try {
    await (await cfg()).query(
      `insert into term (group_id, word, meaning, aliases) values ($1,$2,$3,$4)
       on conflict (coalesce(group_id, 0), word) do update set
         meaning = coalesce(excluded.meaning, term.meaning),
         aliases = excluded.aliases, updated_at = now()`,
      [body.groupId ?? null, word, body.meaning?.trim() || null, body.aliases ?? []],
    );
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.delete("/api/terms/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "id が不正" }, 400);
  try {
    await (await cfg()).query("delete from term where id = $1", [id]);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// --- 人の名簿 ---
//
// **対応付けは推論しない。**記録に出てくるのは `@reviewer-a` のようなハンドル名で、
// それが「◯◯さん」だと決められるのは人だけである。ここは候補を数えて並べるだけ。
app.get("/api/people", async (c) => {
  const client = await db();
  const people = await client.query(
    "select id::int, display, handles, is_me, note from person order by is_me desc, display",
  );
  // まだ誰にも結び付いていない名前。多い順に出す（設定する価値の高い順になる）。
  const unknown = await client.query(
    `select actor_name as handle, count(*)::int as n
     from node
     where actor_name is not null and deleted_at is null
       and not exists (select 1 from person p where node.actor_name = any(p.handles))
     group by actor_name order by n desc limit 100`,
  );
  return c.json({ people: people.rows, unknown: unknown.rows });
});

app.post("/api/people", async (c) => {
  const body = (await c.req.json()) as {
    display?: string;
    handles?: string[];
    isMe?: boolean;
    note?: string;
  };
  const display = (body.display ?? "").trim();
  const handles = (Array.isArray(body.handles) ? body.handles : [])
    .map((x) => String(x).trim())
    .filter(Boolean);
  if (!display) return c.json({ error: "呼び名が空" }, 400);

  const client = await cfg();
  await client.query("begin");
  try {
    // 「私」は 1 人。表の一意索引が守るが、先に降ろしておかないと入れ替えができない。
    if (body.isMe) await client.query("update person set is_me = false where is_me");
    await client.query(
      `insert into person (display, handles, is_me, note) values ($1,$2,$3,$4)
       on conflict (display) do update set
         handles = excluded.handles, is_me = excluded.is_me, note = excluded.note, updated_at = now()`,
      [display, handles, body.isMe === true, body.note ?? null],
    );
    await client.query("commit");
    return c.json({ ok: true });
  } catch (e) {
    await client.query("rollback").catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.delete("/api/people/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "id が不正" }, 400);
  const client = await cfg();
  try {
    await client.query("delete from person where id = $1", [id]);
    return c.json({ ok: true });
  } catch (e) {
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
// --- チャットの履歴 ---
//
// **ナレッジとは別の表に置く。**生成した答えを record / node へ書き戻すと、
// 誤りが「記録」に化けて次の答えがそれを引用する（自分の出力を自分の根拠にする輪）。
app.get("/api/chats", async (c) => {
  const r = await (await db()).query(
    `select c.id, c.title, c.scope_name, c.updated_at,
            (select count(*) from chat_message m where m.chat_id = c.id)::int as messages
     from chat c order by c.updated_at desc limit 100`,
  );
  return c.json(r.rows);
});

app.get("/api/chats/:id", async (c) => {
  const client = await db();
  const head = await client.query("select id, title, scope_ids, scope_name from chat where id = $1", [
    c.req.param("id"),
  ]);
  if (head.rows.length === 0) return c.json({ error: "その会話は無い" }, 404);
  const msgs = await client.query(
    "select role, content, sources, at from chat_message where chat_id = $1 order by at, id",
    [c.req.param("id")],
  );
  return c.json({ ...head.rows[0], messages: msgs.rows });
});

app.delete("/api/chats/:id", async (c) => {
  try {
    await (await cfg()).query("delete from chat where id = $1", [c.req.param("id")]);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.post("/api/chat", async (c) => {
  const body = (await c.req.json()) as ChatBody & { chatId?: string; scopeName?: string };
  const client = await db();
  // 選ばれたプロジェクトがまとめに属していれば、その相手も範囲に入れる。
  const ids = Array.isArray(body.scopeIds) ? body.scopeIds : [];
  const family = [...new Set((await Promise.all(ids.map((id) => scopeFamily(client, id)))).flat())];

  // 用語の書き込みだけ、構成用の鍵を渡す。**ナレッジ本体には触れない鍵。**
  const groupId = ids.length
    ? (
        await client.query<{ id: number }>(
          "select m.group_id::int as id from group_member m where m.scope_id = any($1) limit 1",
          [ids],
        )
      ).rows[0]?.id
    : undefined;
  const learn: Learn = async (t) => {
    const w = await cfg();
    await w.query(
      `insert into term (group_id, word, meaning, aliases, asked_why, asked_at)
       values ($1,$2,$3,$4,$5, case when $3::text is null then now() else null end)
       on conflict (coalesce(group_id, 0), word) do update set
         meaning = coalesce(excluded.meaning, term.meaning),
         aliases = case when cardinality(excluded.aliases) > 0 then excluded.aliases else term.aliases end,
         asked_why = coalesce(term.asked_why, excluded.asked_why),
         updated_at = now()`,
      [groupId ?? null, t.word, t.meaning, t.aliases, t.why],
    );
  };

  return streamSSE(c, async (stream) => {
    let answer = "";
    let sources: unknown[] = [];
    try {
      for await (const chunk of chat(client, env, { ...body, scopeIds: family, learn })) {
        if (chunk.type === "text") answer += chunk.text;
        else if (chunk.type === "sources") sources = chunk.sources;
        await stream.writeSSE({ event: chunk.type, data: JSON.stringify(chunk) });
      }
    } catch (e) {
      // 失敗も画面へ届ける。無言で止まると原因が分からない。
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: e instanceof Error ? e.message : String(e) }),
      });
    }
    // **答えが出てから残す。**途中で切れたものを履歴に積むと、読み返せない断片が増える。
    if (answer) {
      try {
        const chatId = await saveTurn(body, ids, answer, sources);
        await stream.writeSSE({ event: "saved", data: JSON.stringify({ chatId }) });
      } catch {
        // 残せなくても答えは返す
      }
    }
    await stream.writeSSE({ event: "done", data: "{}" });
  });
});

/** 1 往復を履歴へ。会話が無ければ作る。 */
async function saveTurn(
  body: ChatBody & { chatId?: string; scopeName?: string },
  ids: number[],
  answer: string,
  sources: unknown[],
): Promise<string> {
  const w = await cfg();
  let chatId = body.chatId;
  if (!chatId) {
    const r = await w.query<{ id: string }>(
      "insert into chat (title, scope_ids, scope_name) values ($1,$2,$3) returning id",
      [(body.question ?? "").slice(0, 120), ids, body.scopeName ?? null],
    );
    chatId = r.rows[0]?.id;
    if (!chatId) throw new Error("会話を作れなかった");
  } else {
    await w.query("update chat set updated_at = now() where id = $1", [chatId]);
  }
  await w.query(
    `insert into chat_message (chat_id, role, content, sources) values ($1,'user',$2,'[]'), ($1,'assistant',$3,$4)`,
    [chatId, body.question ?? "", answer, JSON.stringify(sources)],
  );
  return chatId;
}

const port = Number(process.env.MITOS_API_PORT ?? 8787);
serve({ fetch: app.fetch, port }, (i) => console.log(`mitos API: http://localhost:${i.port}`));
