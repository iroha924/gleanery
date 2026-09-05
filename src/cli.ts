#!/usr/bin/env node
// ナレッジ DB への書き込み口。**資格情報を持つのはこちらだけで、MCP は読み取り専用。**
// progress-log スキルはこのコマンドを呼ぶだけで、DB のことを知らない。

import fs from "node:fs";
import type pg from "pg";
import { connect, loadEnv } from "./db.ts";
import { type Ir, ingest } from "./ingest.ts";
import { candidates, identify } from "./scope.ts";
import { labelOf, outsideScopes, scopeFamily, search } from "./search.ts";

const USAGE = `使い方:
  knowledge ingest <ir.json> [--cwd <dir>]   IR を取り込む（作業場所が未登録なら登録もする）
  knowledge search <質問> [--cwd <dir>] [--all] [--dont] [--limit N]
                                            引けるかを確かめる
  knowledge scopes                          登録済みの作業場所と束
  knowledge candidates [--json]             束ねる候補を並べる（選ぶのは人間）
  knowledge link <束の名前> <dir>...         選ばれたディレクトリを 1 つの束にする
  knowledge describe <dir> <役割> [説明]      その作業場所が何なのかを書く
  knowledge doctor                          資格情報と接続を確かめる

資格情報: ~/.claude/knowledge.env の SUPABASE_DB_URL と VOYAGE_API_KEY`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(`--${name}`);
const positional = (): string[] => {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      if (["cwd", "limit"].includes(a.slice(2))) i++;
      continue;
    }
    out.push(a);
  }
  return out;
};

/** 作業場所を引く。無ければ作る（取り込みと束ね以外では作らない）。 */
async function scopeIdFor(c: pg.Client, dir: string, create: boolean): Promise<number | null> {
  const me = identify(dir);
  const found = await c.query<{ id: number }>("select id::int as id from scope where ident = $1", [me.ident]);
  const hit = found.rows[0];
  if (hit) return hit.id;
  if (!create) return null;
  const r = await c.query<{ id: number }>(
    `insert into scope (ident, ident_kind, abs_path, host_org, repo_name, label)
     values ($1,$2,$3,$4,$5,$6) returning id::int as id`,
    [me.ident, me.identKind, me.absPath, me.hostOrg, me.repoName, me.label],
  );
  const created = r.rows[0];
  if (!created) throw new Error(`作業場所を作れなかった: ${me.ident}`);
  return created.id;
}

async function main(): Promise<void> {
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }
  const cwd = flag("cwd") ?? process.cwd();
  const env = loadEnv(cwd);

  if (cmd === "doctor") {
    console.log(`SUPABASE_DB_URL  ${env.SUPABASE_DB_URL ? "あり" : "無い"}`);
    console.log(`VOYAGE_API_KEY   ${env.VOYAGE_API_KEY ? "あり" : "無い"}`);
    const c = await connect(env);
    const v = await c.query<{ n: number; scopes: number }>(
      "select (select count(*) from node where deleted_at is null)::int n, (select count(*) from scope)::int scopes",
    );
    console.log(`接続             OK / node ${v.rows[0]?.n ?? 0} 件 / 作業場所 ${v.rows[0]?.scopes ?? 0} 件`);
    const me = identify(cwd);
    const mine = await scopeIdFor(c, cwd, false);
    console.log(`いまの場所       ${me.label}（${mine ? "登録済み" : "未登録"}）`);
    await c.end();
    return;
  }

  if (cmd === "candidates") {
    const list = candidates();
    if (has("json")) {
      console.log(JSON.stringify(list, null, 2));
      return;
    }
    for (const x of list) {
      console.log(`${x.label}\n  ${x.absPath}\n  手がかり: ${x.markers.join(", ") || "(なし)"}`);
    }
    return;
  }

  const c = await connect(env);
  try {
    if (cmd === "ingest") {
      const file = positional()[0];
      if (!file) throw new Error(`取り込む IR のファイルを指定する\n\n${USAGE}`);
      const ir = JSON.parse(fs.readFileSync(file, "utf8")) as Ir;
      const scopeId = await scopeIdFor(c, cwd, true);
      if (scopeId === null) throw new Error("作業場所を決められなかった");
      const r = await ingest(c, env, ir, scopeId, { onProgress: (m) => console.error(`  ${m}`) });
      console.log(
        `取り込み完了: ${ir.meta.id} / node ${r.nodes} 件（埋め込みを取り直した ${r.embedded} 件）`,
      );
      if (r.keptScope !== null) {
        console.log(
          `※ この記録は最初に取り込んだ作業場所（id=${r.keptScope}）に留めました。1 つの記録が 2 つに割れるのを防ぐためです。`,
        );
      }
      return;
    }

    if (cmd === "search") {
      const question = positional().join(" ");
      if (!question) throw new Error(`質問を指定する\n\n${USAGE}`);
      const mine = await scopeIdFor(c, cwd, false);
      const scopeIds = has("all") ? undefined : mine === null ? [] : await scopeFamily(c, mine);
      const { rows, queryVector, topScore } = await search(c, env, {
        question,
        scopeIds,
        polarity: has("dont") ? "dont" : undefined,
        limit: Number(flag("limit") ?? 5),
      });
      if (rows.length === 0) console.log("該当なし。");
      for (const x of rows) {
        console.log(`${labelOf(x)}${x.text}`);
        if (x.ex) console.log(`  理由: ${x.ex}`);
        console.log(`  出自: ${x.scope_label} / ${x.record_id} / ${x.key}\n`);
      }
      const outside = await outsideScopes(c, queryVector, scopeIds, { floor: topScore });
      if (outside.length)
        console.log(`※ ${outside.join(" / ")} にも近い記録があります（--all で見られます）。`);
      return;
    }

    if (cmd === "scopes") {
      const r = await c.query<{ label: string; role: string | null; groups: string; records: number }>(
        `select s.label, s.role,
                coalesce(string_agg(g.name, ', ' order by g.name), '(束なし)') as groups,
                (select count(*) from record where scope_id = s.id)::int as records
         from scope s
         left join group_member m on m.scope_id = s.id
         left join scope_group  g on g.id = m.group_id
         group by s.id, s.label, s.role order by s.label`,
      );
      if (r.rows.length === 0) console.log("登録なし");
      for (const x of r.rows) {
        console.log(`${x.label}  [${x.groups}]  記録 ${x.records} 件${x.role ? ` / ${x.role}` : ""}`);
      }
      return;
    }

    if (cmd === "link") {
      const [name, ...dirs] = positional();
      if (!name || dirs.length === 0) throw new Error(`束の名前と、束ねるディレクトリを指定する\n\n${USAGE}`);
      await c.query("begin");
      try {
        const g = await c.query<{ id: number }>(
          `insert into scope_group (name) values ($1)
           on conflict (name) do update set name = excluded.name returning id::int as id`,
          [name],
        );
        const groupId = g.rows[0]?.id;
        if (groupId === undefined) throw new Error(`束を作れなかった: ${name}`);
        for (const d of dirs) {
          const id = await scopeIdFor(c, d, true);
          await c.query(
            "insert into group_member (group_id, scope_id) values ($1,$2) on conflict do nothing",
            [groupId, id],
          );
        }
        await c.query("commit");
      } catch (e) {
        await c.query("rollback").catch(() => {});
        throw e;
      }
      console.log(`束「${name}」に ${dirs.length} 件を入れました。この束の中は互いに検索されます。`);
      return;
    }

    if (cmd === "describe") {
      const [dir, role, ...rest] = positional();
      if (!dir || !role) throw new Error(`ディレクトリと役割を指定する\n\n${USAGE}`);
      const id = await scopeIdFor(c, dir, true);
      await c.query("update scope set role=$1, summary=coalesce($2, summary), updated_at=now() where id=$3", [
        role,
        rest.join(" ") || null,
        id,
      ]);
      console.log(`${identify(dir).label} を「${role}」として記録しました。`);
      return;
    }

    throw new Error(`知らないコマンド: ${cmd}\n\n${USAGE}`);
  } finally {
    await c.end().catch(() => {});
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
