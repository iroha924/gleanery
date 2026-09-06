#!/usr/bin/env node
// ナレッジ DB への書き込み口。**資格情報を持つのはこちらだけで、MCP は読み取り専用。**
// progress-log スキルはこのコマンドを呼ぶだけで、DB のことを知らない。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type pg from "pg";
import { z } from "zod";
import { connect, loadEnv } from "./db.ts";
import { collectThreads, ingestThreads } from "./github.ts";
import { type Ir, ingest } from "./ingest.ts";
import { fetchIssue, ingestIssue, listIssues, whoAmI } from "./linear.ts";
import { candidates, identify } from "./scope.ts";
import { outsideScopes, quote, scopeFamily, search } from "./search.ts";

const USAGE = `使い方:
  mitos ingest <記録.html|ir.json> [--cwd <dir>]  記録を取り込む（未登録なら作業場所も登録）
  mitos search <質問> [--cwd <dir>] [--all] [--dont] [--limit N]
                                                 引けるかを確かめる
  mitos scopes                                   登録済みの作業場所と束
  mitos candidates [--json]                      束ねる候補を並べる（選ぶのは人間）
  mitos link <束の名前> <dir>...                  選ばれたものを 1 つの束にする
  mitos describe <dir> <役割> [説明]              その作業場所が何なのかを書く
  mitos doctor                                   資格情報と接続を確かめる
  mitos usage                                    OpenAI の使用量と残り
  mitos import-github [--cwd <dir>]              PR のレビューと議論を取り込む
  mitos import-linear --team <名前> [--group <束>] [--all]
                                                 Linear の issue とコメントを取り込む
  mitos who                                      誰が誰かの名簿を見る（未設定の名前も出る）
  mitos who <呼び名> <ハンドル>... [--me]         名簿に入れる（--me は質問者本人）

資格情報: ~/.claude/knowledge.env の SUPABASE_DB_URL と VOYAGE_API_KEY`;

// **引数の解釈を自前で書かない。**手書きのループは知らないフラグと `--name=値` を
// 黙って捨て、`ingest --cwd=/other/repo` が警告も出さずに別の作業場所へ書いていた（実測）。
// parseArgs は既定で未知のフラグを投げるので、解釈できなかった引数が成功に化けない。
const OPTIONS = {
  cwd: { type: "string" },
  limit: { type: "string" },
  all: { type: "boolean" },
  me: { type: "boolean" },
  dont: { type: "boolean" },
  json: { type: "boolean" },
  team: { type: "string" },
  group: { type: "string" },
} as const;

// progress-log が書く HTML には IR が script 要素で埋まっている。
// **この 1 つのタグだけが 2 つのリポジトリの接点。**ここを読めるようにすると、
// 記録の HTML をそのまま渡せて、取り出しと取り込みが 2 コマンドに割れない。
const IR_TAG = /<script type="application\/json" id="progress-ir">([\s\S]*?)<\/script>/;

function readIr(file: string): unknown {
  const body = fs.readFileSync(file, "utf8");
  if (!file.endsWith(".html")) return JSON.parse(body);
  const m = body.match(IR_TAG);
  if (!m?.[1]) throw new Error(`${file} に progress-ir の埋め込みが無い。progress render で書いたものを渡す`);
  return JSON.parse(m[1]);
}

// ingest が実際に読む形。中身の契約（棄却理由の有無など）は progress-log の validate が見ている。
//
// **本文が文字列であることまで確かめる。**確かめないと、要素がオブジェクトのときに
// `String(o)` が全部 `[object Object]` になり、キーもハッシュも衝突して
// 複数の制約が 1 件に潰れる（実測で再現した）。
const text = z.string();
const evidence = z.array(z.object({ kind: z.string(), ref: z.string() }).loose()).optional();

const IR_SHAPE = z
  .object({
    schema: z.string().min(1),
    meta: z
      .object({
        id: z.string().min(1).max(200),
        title: text,
        status: z.string(),
        created: z.string().min(1),
        updated: z.string().min(1),
      })
      .loose(),
    background: z
      .object({ nonGoals: z.array(text).optional(), constraints: z.array(text).optional() })
      .loose()
      .optional(),
    decisions: z
      .array(
        z
          .object({
            id: text,
            decision: text,
            at: text,
            options: z.array(z.object({ option: text }).loose()).optional(),
            evidence,
          })
          .loose(),
      )
      .optional(),
    events: z.array(z.object({ id: text, kind: text, text, at: text, evidence }).loose()).optional(),
    verification: z.array(z.object({ id: text, what: text, at: text, evidence }).loose()).optional(),
    openQuestions: z.array(z.object({ id: text, q: text, at: text }).loose()).optional(),
  })
  .loose();

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

/**
 * issue の出どころを作業場所として用意し、指定があれば束へ足す。
 * **ディレクトリではないので identify() は通らない。**ident はトラッカー側の識別子。
 */
async function trackerScopeId(
  c: pg.Client,
  ident: string,
  label: string,
  hostOrg: string,
  group: string | undefined,
): Promise<number> {
  const found = await c.query<{ id: number }>("select id::int as id from scope where ident = $1", [ident]);
  const id =
    found.rows[0]?.id ??
    (
      await c.query<{ id: number }>(
        `insert into scope (ident, ident_kind, abs_path, host_org, repo_name, label, role)
         values ($1,'tracker',null,$2,null,$3,'issue-tracker') returning id::int as id`,
        [ident, hostOrg, label],
      )
    ).rows[0]?.id;
  if (id === undefined) throw new Error(`作業場所を作れなかった: ${ident}`);
  if (group) {
    await c.query("insert into scope_group (name) values ($1) on conflict (name) do nothing", [group]);
    await c.query(
      `insert into group_member (group_id, scope_id)
       select g.id, $2 from scope_group g where g.name = $1
       on conflict do nothing`,
      [group, id],
    );
  }
  return id;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }
  const { values: opt, positionals: rest } = parseArgs({
    args: argv.slice(1),
    options: OPTIONS,
    allowPositionals: true,
  });
  const cwd = opt.cwd ?? process.cwd();
  // **DB に触る前に落とす。**接続してから引数の不備で失敗すると、
  // 待たされたうえに原因が接続の問題と区別できない。
  // MCP 側は zod で 1〜20 に縛っている。CLI だけ穴を開けると、-1 が Voyage の top_k へ
  // そのまま流れ、失敗時の slice(0, -1) がプール 30 件のうち 29 件を吐く。
  const limit = Number(opt.limit ?? 5);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error(`--limit は 1 から 20 の整数にする: ${opt.limit}`);
  }
  const polarity = opt.dont ? ("dont" as const) : undefined;
  const KNOWN = [
    "ingest",
    "search",
    "scopes",
    "candidates",
    "link",
    "describe",
    "doctor",
    "usage",
    "import-github",
    "import-linear",
    "who",
  ];
  if (!KNOWN.includes(cmd)) throw new Error(`知らないコマンド: ${cmd}\n\n${USAGE}`);
  const env = loadEnv(cwd);

  if (cmd === "doctor") {
    console.log(`SUPABASE_DB_URL      ${env.SUPABASE_DB_URL ? "あり" : "無い"}`);
    console.log(`VOYAGE_API_KEY       ${env.VOYAGE_API_KEY ? "あり" : "無い"}`);
    console.log(`KNOWLEDGE_DB_URL_RO  ${env.KNOWLEDGE_DB_URL_RO ? "あり" : "無い（管理側の鍵に落ちる）"}`);
    // **両方の経路を叩く。**MCP とフックは読み取り専用ロールで繋ぐので、
    // 管理側だけ確かめても意味が無い。実際にベクトル検索まで通す
    // （search_path にロール差があり、読み取り側だけ落ちたことがある）。
    for (const [label, readOnly] of [
      ["書き込み(CLI)", false],
      ["読み取り(MCP/フック)", true],
    ] as const) {
      const c = await connect(env, { as: readOnly ? "read" : "admin" });
      const who = await c.query<{ u: string }>("select current_user as u");
      const v = await c.query<{ n: number }>(
        "select count(*)::int n from (select 1 from node where embedding is not null order by embedding <#> (select embedding from node where embedding is not null limit 1) limit 3) t",
      );
      console.log(`${label.padEnd(22)} ${who.rows[0]?.u} / ベクトル検索 OK（${v.rows[0]?.n} 件返った）`);
      await c.end();
    }
    // Linear は API キーではなく OAuth 済みの MCP 越しに取る。**壊れ方が DB と違う** —
    // claude が PATH に無い、OAuth が切れた、のどちらでも「issue が 0 件」に化けるので、
    // ここで実際に 1 回叩いて確かめる。
    try {
      console.log(`Linear(MCP 経由)       ${whoAmI()} として届いた`);
    } catch (e) {
      console.log(`Linear(MCP 経由)       届かない: ${e instanceof Error ? e.message : e}`);
    }

    const c = await connect(env);
    const me = identify(cwd);
    const mine = await scopeIdFor(c, cwd, false);
    const t = await c.query<{ n: number; s: number }>(
      "select (select count(*) from node where deleted_at is null)::int n, (select count(*) from scope)::int s",
    );
    console.log(`データ                 node ${t.rows[0]?.n ?? 0} 件 / 作業場所 ${t.rows[0]?.s ?? 0} 件`);
    console.log(`いまの場所             ${me.label}（${mine ? "登録済み" : "未登録"}）`);
    await c.end();
    return;
  }

  if (cmd === "usage") {
    // 実測値の合計。推定ではない。
    const log = path.join(os.homedir(), ".claude", "mitos-usage.jsonl");
    if (!fs.existsSync(log)) {
      console.log("まだ記録がありません。");
      return;
    }
    const rows = fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { model: string; in?: number; out?: number; cost?: number });
    const limit = Number(env.MITOS_USAGE_LIMIT ?? 5);
    const total = rows.reduce((a, r) => a + (r.cost ?? 0), 0);
    const per = total / Math.max(rows.length, 1);
    console.log(`呼び出し   ${rows.length} 回`);
    console.log(`費用       $${total.toFixed(4)} / 上限 $${limit}（${((total / limit) * 100).toFixed(1)}%）`);
    console.log(`1 回あたり  $${per.toFixed(4)} — 残りおよそ ${Math.floor((limit - total) / per)} 回`);
    return;
  }

  if (cmd === "candidates") {
    const list = candidates();
    if (opt.json) {
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
      const file = rest[0];
      if (!file) throw new Error(`取り込む IR のファイルを指定する\n\n${USAGE}`);
      // **型アサーションは検証ではない。**`{}` を渡すと ingest の中で
      // `Cannot read properties of undefined` になり、どこが悪いかも分からない。
      // ここは外から来たファイルを読む信頼境界なので、形だけは実行時に確かめる。
      const raw: unknown = readIr(file);
      const shape = IR_SHAPE.safeParse(raw);
      if (!shape.success) {
        throw new Error(
          `${file} は IR の形をしていない:\n` +
            shape.error.issues.map((i) => `  ${i.path.join(".") || "(根)"}: ${i.message}`).join("\n"),
        );
      }
      // **検証の結果ではなく、元の値を渡す。**zod は既定で知らないキーを落とすので、
      // shape.data を渡すと decisions も events も消えて取り込みが 0 件になる（実測）。
      const ir = raw as Ir;
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

    if (cmd === "import-github") {
      const me = identify(cwd);
      if (me.identKind !== "git-remote") throw new Error(`${cwd} に git の remote が無い`);
      const repo = me.ident.replace(/^git:[^/]+\//, "");
      const scopeId = await scopeIdFor(c, cwd, true);
      if (scopeId === null) throw new Error("作業場所を決められなかった");
      console.error(`  ${repo} から集めています…`);
      const threads = collectThreads(repo);
      const r = await ingestThreads(c, env, repo, scopeId, threads, (m) => console.error(`  ${m}`));
      console.log(`取り込み完了: ${repo} / スレッド ${r.total} 件（埋め込みを取り直した ${r.embedded} 件）`);
      return;
    }

    if (cmd === "import-linear") {
      // 束に「issue の出どころ」が設定してあれば、チーム名はそこから取る。
      // 画面で設定したものと CLI が同じものを見るようにするため。
      const fromGroup = opt.group
        ? (
            await c.query<{ ident: string }>(
              `select s.ident from scope s
               join group_member m on m.scope_id = s.id
               join scope_group g on g.id = m.group_id
               where g.name = $1 and s.ident like 'linear:%' limit 1`,
              [opt.group],
            )
          ).rows[0]?.ident?.replace(/^linear:/, "")
        : undefined;
      const team = opt.team ?? fromGroup;
      if (!team) {
        throw new Error(
          `--team <チーム名> を指定する（例: --team Onetag）。` +
            `画面で束に issue の出どころを設定してあれば --group <束名> でも引ける\n\n${USAGE}`,
        );
      }
      const who = whoAmI();
      console.error(`  Linear の ${team} を ${who} として数えています…`);
      const all = listIssues(team);
      if (all.length === 0) throw new Error(`${team} に issue が 1 件も無い。チーム名を確かめる`);
      const mine = all.filter((i) => i.assignee === who || i.createdBy === who);
      const target = opt.all ? all : mine;
      console.error(
        `  チーム全体 ${all.length} 件 / 自分が関わる ${mine.length} 件 → 対象 ${target.length} 件`,
      );

      const workspace =
        new URL(String(all[0]?.url ?? "https://linear.app/unknown/")).pathname.split("/")[1] ?? "unknown";
      const scopeId = await trackerScopeId(
        c,
        `linear:${workspace}/${team}`,
        `Linear: ${team}`,
        workspace,
        opt.group,
      );

      // **更新のあったものだけ取りに行く。**日次で回すので、ここが無いと毎回全件を
      // 取り直して時間も費用も件数に比例する。比較は Linear が返した updatedAt の
      // 文字列そのもの同士でやる（timestamptz へ丸めると精度差で毎回ずれる）。
      const known = new Map(
        (
          await c.query<{ id: string; u: string | null }>(
            "select id, raw->>'updatedAt' as u from record where id like 'linear:%'",
          )
        ).rows.map((r) => [r.id, r.u]),
      );
      const changed = target.filter((i) => known.get(`linear:${String(i.id)}`) !== String(i.updatedAt));
      console.error(
        `  更新のあった ${changed.length} 件を取りに行きます（据え置き ${target.length - changed.length} 件）`,
      );

      let nodes = 0;
      let embedded = 0;
      for (const [n, row] of changed.entries()) {
        const id = String(row.id);
        const issue = fetchIssue(id);
        const r = await ingestIssue(c, env, workspace, scopeId, issue);
        nodes += r.nodes;
        embedded += r.embedded;
        console.error(
          `  [${n + 1}/${changed.length}] ${id} コメント ${issue.comments.length} 件 → node ${r.nodes} 件`,
        );
      }
      console.log(
        `取り込み完了: Linear ${team} / issue ${changed.length} 件 / node ${nodes} 件（埋め込み ${embedded} 件）`,
      );
      return;
    }

    // 誰が誰かは**人が決める**。記録に出てくるのはハンドル名だけで、
    // それが「黒川さん」だと結び付けられるのは人しかいない。ここは推論しない。
    if (cmd === "who") {
      if (rest.length === 0) {
        const people = await c.query<{ display: string; handles: string[]; is_me: boolean }>(
          "select display, handles, is_me from person order by is_me desc, display",
        );
        if (people.rows.length === 0) console.log("名簿は空。`mitos who <呼び名> <ハンドル>...` で入れる");
        for (const r of people.rows) {
          console.log(`${r.is_me ? "→ " : "  "}${r.display.padEnd(12)} ${r.handles.join(" / ")}`);
        }
        const unknown = await c.query<{ handle: string; n: number }>(
          `select actor_name as handle, count(*)::int as n from node
           where actor_name is not null and deleted_at is null
             and not exists (select 1 from person p where node.actor_name = any(p.handles))
           group by actor_name order by n desc limit 20`,
        );
        if (unknown.rows.length) {
          console.log("\nまだ誰か決めていない名前（発言の多い順）:");
          for (const r of unknown.rows) console.log(`  ${String(r.n).padStart(5)} 件  ${r.handle}`);
        }
        return;
      }
      const [display, ...handles] = rest;
      if (!display) throw new Error(`呼び名を指定する\n\n${USAGE}`);
      if (handles.length === 0) throw new Error("ハンドルを 1 つ以上指定する（記録に出てくる名前）");
      if (opt.me) await c.query("update person set is_me = false where is_me");
      await c.query(
        `insert into person (display, handles, is_me) values ($1,$2,$3)
         on conflict (display) do update set handles = excluded.handles, is_me = excluded.is_me, updated_at = now()`,
        [display, handles, opt.me === true],
      );
      console.log(`名簿に入れた: ${display} = ${handles.join(" / ")}${opt.me ? "（質問者本人）" : ""}`);
      return;
    }

    if (cmd === "search") {
      const question = rest.join(" ");
      if (!question) throw new Error(`質問を指定する\n\n${USAGE}`);
      const mine = await scopeIdFor(c, cwd, false);
      const scopeIds = opt.all ? undefined : mine === null ? [] : await scopeFamily(c, mine);
      const { rows, queryVector, topScore } = await search(c, env, {
        question,
        scopeIds,
        polarity,
        limit,
      });
      // この出力は progress-log の allowed-tools 経由でそのままエージェントの文脈へ入る。
      // 枠を通さずに出すと、フック側だけ守っても意味が無い。
      console.log(rows.length === 0 ? "該当なし。" : quote(rows));
      // 範囲内を dont に絞ったなら、範囲外も同じ条件で見る。違う条件だと
      // 「外にある」と言われて --all で見にいっても出てこない。
      const outside = await outsideScopes(c, queryVector, scopeIds, { polarity, floor: topScore });
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
      const [name, ...dirs] = rest;
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
      const [dir, role, ...words] = rest;
      if (!dir || !role) throw new Error(`ディレクトリと役割を指定する\n\n${USAGE}`);
      // 打ち間違えたパスで空の作業場所が増えないよう、ここでは作らない。
      const id = await scopeIdFor(c, dir, false);
      if (id === null)
        throw new Error(`${identify(dir).label} はまだ登録されていない。先に ingest か link で登録する`);
      await c.query("update scope set role=$1, summary=coalesce($2, summary), updated_at=now() where id=$3", [
        role,
        words.join(" ") || null,
        id,
      ]);
      console.log(`${identify(dir).label} を「${role}」として記録しました。`);
      return;
    }

    throw new Error(`到達しないはずの分岐: ${cmd}`);
  } finally {
    await c.end().catch(() => {});
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
