#!/usr/bin/env node
// ナレッジ DB への書き込み口。**資格情報を持つのはこちらだけで、MCP は読み取り専用。**
// progress-log スキルはこのコマンドを呼ぶだけで、DB のことを知らない。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type pg from "pg";
import { z } from "zod";
import { connect, type Env, loadEnv } from "./db.ts";
import { collect, ingestThreads } from "./github.ts";
import { ensureIdentity } from "./identity.ts";
import { type Ir, ingest } from "./ingest.ts";
import { fetchIssues, ingestIssue, listIssues, whoAmI } from "./linear.ts";
import { candidates, identify } from "./scope.ts";
import { outsideScopes, quote, scopeFamily, search } from "./search.ts";
import { ingestSession, readSession } from "./session.ts";

const USAGE = `使い方:
  mitos ingest <記録.html|ir.json> [--cwd <dir>]  記録を取り込む（未登録なら作業場所も登録）
  mitos export <記録の id>                       取り込んだ IR を書き戻す（record.raw をそのまま出す）
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
  mitos sync [--group <束>] [--all]              登録済みの取り込み元をまとめて更新（日次用）
  mitos import-sessions [--cwd <dir>]           Claude Code の会話をナレッジにする
  mitos advice                                   編集時の助言が効いているかを見る

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

/** リポジトリ 1 つぶん。**import-github と sync が同じ道を通る。** */
/**
 * その作業場所の Claude Code / Codex の会話を取り込む。
 * **sync からも呼ぶ。**手で叩く前提にすると、記録し忘れたセッションが永久に入らない。
 */
async function syncSessions(c: pg.Client, env: Env, dir: string, say: (m: string) => void): Promise<string> {
  const scopeId = await scopeIdFor(c, dir, true);
  if (scopeId === null) throw new Error("作業場所を決められなかった");
  const me =
    (await c.query<{ display: string }>("select display from person where is_me limit 1")).rows[0]?.display ??
    "私";

  // ccs（複数インスタンス）と素の Claude Code の両方を見る。
  const slug = dir.replace(/\//g, "-");
  const dirs = [
    ...(fs.existsSync(path.join(os.homedir(), ".ccs", "instances"))
      ? fs
          .readdirSync(path.join(os.homedir(), ".ccs", "instances"), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => path.join(os.homedir(), ".ccs", "instances", d.name, "projects", slug))
      : []),
    path.join(os.homedir(), ".claude", "projects", slug),
  ].filter((d) => fs.existsSync(d));
  if (dirs.length === 0) return `${identify(dir).label} / セッション記録なし`;

  const files = dirs.flatMap((d) =>
    fs
      .readdirSync(d)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(d, f)),
  );
  let nodes = 0;
  let embedded = 0;
  let done = 0;
  for (const file of files) {
    const s = readSession(file);
    if (!s) continue;
    const r = await ingestSession(c, env, scopeId, s, me);
    nodes += r.nodes;
    embedded += r.embedded;
    done++;
    say(`[${done}/${files.length}] ${s.id.slice(0, 8)} 往復 ${r.nodes} 件`);
  }
  return `${identify(dir).label} / セッション ${done} 本・往復 ${nodes} 件（埋め込み ${embedded} 件）`;
}

async function syncGithub(c: pg.Client, env: Env, dir: string): Promise<string> {
  const me = identify(dir);
  if (me.identKind !== "git-remote") throw new Error(`${dir} に git の remote が無い`);
  const repo = me.ident.replace(/^git:[^/]+\//, "");
  const scopeId = await scopeIdFor(c, dir, true);
  if (scopeId === null) throw new Error("作業場所を決められなかった");
  console.error(`  ${repo} から集めています…`);
  const { prs, threads } = collect(repo);
  const r = await ingestThreads(c, env, repo, scopeId, prs, threads, (m) => console.error(`  ${m}`));
  return `${repo} / PR ${prs.length} 件（新しく入れた ${r.prs} 件）/ スレッド ${r.total} 件（埋め込みを取り直した ${r.embedded} 件）`;
}

/** Linear のチーム 1 つぶん。team を省いたら束の「issue の出どころ」から引く。 */
async function syncLinear(
  c: pg.Client,
  env: Env,
  team: string | undefined,
  takeAll: boolean,
  group: string | undefined,
): Promise<string> {
  // 束に「issue の出どころ」が設定してあれば、チーム名はそこから取る。
  // 画面で設定したものと CLI が同じものを見るようにするため。
  const fromGroup = group
    ? (
        await c.query<{ ident: string }>(
          `select s.ident from scope s
           join group_member m on m.scope_id = s.id
           join scope_group g on g.id = m.group_id
           where g.name = $1 and s.ident like 'linear:%' limit 1`,
          [group],
        )
      ).rows[0]?.ident?.replace(/^linear:/, "")
    : undefined;
  const teamName = team ?? fromGroup;
  if (!teamName) {
    throw new Error(
      `--team <チーム名> を指定する（例: --team Core）。` +
        `画面で束に issue の出どころを設定してあれば --group <束名> でも引ける\n\n${USAGE}`,
    );
  }
  const who = whoAmI();
  console.error(`  Linear の ${teamName} を ${who} として数えています…`);
  const issues = listIssues(teamName);
  if (issues.length === 0) throw new Error(`${teamName} に issue が 1 件も無い。チーム名を確かめる`);
  const mine = issues.filter((i) => i.assignee === who || i.createdBy === who);
  const target = takeAll ? issues : mine;
  console.error(
    `  チーム全体 ${issues.length} 件 / 自分が関わる ${mine.length} 件 → 対象 ${target.length} 件`,
  );

  const workspace =
    new URL(String(issues[0]?.url ?? "https://linear.app/unknown/")).pathname.split("/")[1] ?? "unknown";
  const scopeId = await trackerScopeId(
    c,
    `linear:${workspace}/${teamName}`,
    `Linear: ${teamName}`,
    workspace,
    group,
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

  // **まとめて取る。**1 件ずつ `claude -p` を起動すると 1 件 30 秒かかり、
  // チーム全体（4,393 件）で 30 時間を超える。まとめ叩きで 4 秒/件になった（実測）。
  let nodes = 0;
  let embedded = 0;
  let done = 0;
  const BATCH = 20;
  for (let from = 0; from < changed.length; from += BATCH) {
    const ids = changed.slice(from, from + BATCH).map((i) => String(i.id));
    for (const issue of fetchIssues(ids)) {
      const r = await ingestIssue(c, env, workspace, scopeId, issue);
      nodes += r.nodes;
      embedded += r.embedded;
      done++;
    }
    console.error(`  ${done} / ${changed.length} 件（node ${nodes} 件）`);
  }
  return `Linear ${teamName} / issue ${changed.length} 件 / node ${nodes} 件（埋め込み ${embedded} 件）`;
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
    "export",
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
    "sync",
    "import-sessions",
    "advice",
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

  // **良くなったかを測る。**機能を足す前にこれが要る。
  // 見るのは 3 つ: 編集あたりのヒット率／1 件あたりの候補数／同じ助言の再提示率。
  if (cmd === "advice") {
    const log = path.join(os.homedir(), ".claude", "mitos-advice.jsonl");
    if (!fs.existsSync(log)) {
      console.log("まだ記録がありません（編集フックが一度も走っていない）。");
      return;
    }
    const rows = fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as { at: string; path: string; candidates: number; shown: string[] });
    const shownRows = rows.filter((r) => r.shown.length > 0);
    const all = shownRows.flatMap((r) => r.shown);
    const uniq = new Set(all);
    console.log(`フックが走った編集   ${rows.length} 回`);
    console.log(
      `助言を出せた         ${shownRows.length} 回（${((shownRows.length / Math.max(rows.length, 1)) * 100).toFixed(0)}%）`,
    );
    console.log(
      `1 回あたりの候補     ${(rows.reduce((a, r) => a + r.candidates, 0) / Math.max(rows.length, 1)).toFixed(1)} 件`,
    );
    // 同じ助言が何度も出ていたら、抑制が効いていない。
    console.log(
      `同じ助言の再提示率   ${all.length ? (((all.length - uniq.size) / all.length) * 100).toFixed(0) : 0}%（低いほどよい）`,
    );
    const byPath = new Map<string, number>();
    for (const r of shownRows) byPath.set(r.path, (byPath.get(r.path) ?? 0) + 1);
    const top = [...byPath.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (top.length) {
      console.log("\nよく出しているファイル:");
      for (const [f, n] of top) console.log(`  ${String(n).padStart(3)} 回  ${f}`);
    }
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
      .map(
        (l) => JSON.parse(l) as { model: string; in?: number; cached?: number; out?: number; cost?: number },
      );
    const limit = Number(env.MITOS_USAGE_LIMIT ?? 10);
    const total = rows.reduce((a, r) => a + (r.cost ?? 0), 0);
    const per = total / Math.max(rows.length, 1);
    console.log(`呼び出し   ${rows.length} 回`);
    console.log(`費用       $${total.toFixed(4)} / 上限 $${limit}（${((total / limit) * 100).toFixed(1)}%）`);
    console.log(`1 回あたり  $${per.toFixed(4)} — 残りおよそ ${Math.floor((limit - total) / per)} 回`);
    // **キャッシュ済み入力は 10% で課金される。**これを数えていなかったので、
    // 実測 $2.76 に対して $3.92 と 42% 過大に報告していた（実測で判明）。
    const older = rows.filter((r) => r.cached === undefined).length;
    if (older) {
      console.log(`\n※ 古い ${older} 件はキャッシュ分を数えていないので、実際より高く出ています`);
      const withCache = rows.filter((r) => r.cached !== undefined);
      if (withCache.length) {
        const inTok = withCache.reduce((a, r) => a + (r.in ?? 0), 0);
        const cachedTok = withCache.reduce((a, r) => a + (r.cached ?? 0), 0);
        console.log(
          `   新しい ${withCache.length} 件では入力の ${((cachedTok / Math.max(inTok, 1)) * 100).toFixed(0)}% がキャッシュ済み`,
        );
      }
    }
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
      // **作業場所が何なのかを、まだ持っていなければここで読む。**
      // 人に書かせない（d-infer-project-identity）。空のときだけなので、取り込みのたびには走らない。
      const said = await ensureIdentity(c, env, scopeId).catch(() => null);
      if (said) console.log(said);
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

    if (cmd === "export") {
      const id = rest[0];
      if (!id) throw new Error(`書き出す記録の id を指定する\n\n${USAGE}`);
      const r = await c.query<{ raw: unknown }>("select raw from record where id = $1", [id]);
      const row = r.rows[0];
      if (!row) throw new Error(`記録 ${id} が無い。mitos scopes で登録済みの作業場所を見る`);
      // **列コメントが宣言している役目を、初めて実行できる形にする。**
      // `raw jsonb not null, -- 取り込んだ IR 全文。投影の再構築元` と書いてあるのに、
      // 再構築するコマンドが無かった。これで「DB は下流」が検査になる:
      //   mitos export <id> > ir.json && progress render ir.json
      //
      // **バイト一致はしない。**jsonb はキー順を正規化するので、内蔵 IR の並びが変わる。
      // 一致するのは中身で、キー順を揃えたハッシュで確かめる（実測で確認済み）。
      process.stdout.write(JSON.stringify(row.raw));
      return;
    }
    if (cmd === "import-github") {
      console.log(`取り込み完了: ${await syncGithub(c, env, cwd)}`);
      return;
    }

    // 登録済みの取り込み元を順に回す。**何を取りに行くかは DB が持つ** —
    // どのリポジトリと、どの issue の出どころが束に入っているかは画面で設定した通り。
    // ここに一覧を書くと、画面で足したものが日次から漏れる。
    if (cmd === "sync") {
      const targets = await c.query<{ ident: string; abs_path: string | null; label: string }>(
        opt.group
          ? `select s.ident, s.abs_path, s.label from scope s
             join group_member m on m.scope_id = s.id
             join scope_group g on g.id = m.group_id
             where g.name = $1 order by s.label`
          : "select ident, abs_path, label from scope order by label",
        opt.group ? [opt.group] : [],
      );
      let ok = 0;
      const skipped: string[] = [];
      for (const t of targets.rows) {
        try {
          if (t.ident.startsWith("linear:")) {
            const team = t.ident.replace(/^linear:[^/]*\//, "");
            console.log(`取り込み完了: ${await syncLinear(c, env, team, opt.all === true, undefined)}`);
          } else if (t.ident.startsWith("git:") && t.abs_path && fs.existsSync(t.abs_path)) {
            console.log(`取り込み完了: ${await syncGithub(c, env, t.abs_path)}`);
            // **会話もここで入れる。**手で叩く前提だと、記録し忘れたセッションが永久に入らない。
            // 保存を忘れて痛いのは「何も残らない」ことなので、判断の構造化（/mitos:trace）は
            // 人に任せたまま、会話だけは自動で残す。
            console.log(`取り込み完了: ${await syncSessions(c, env, t.abs_path, () => {})}`);
          } else {
            // **黙って飛ばさない。**「同期したのに古い」の原因がここに集まる。
            skipped.push(`${t.label}（${t.abs_path ? "ディレクトリが無い" : "取り込み方が決まっていない"}）`);
            continue;
          }
          ok++;
        } catch (e) {
          // 1 つ落ちても残りは回す。日次なので、翌日に持ち越すより今日入るものを入れる。
          console.error(`  ${t.label} で失敗: ${e instanceof Error ? e.message : e}`);
        }
      }
      console.log(`同期おわり: ${ok} / ${targets.rows.length} 件`);
      if (skipped.length) console.log(`飛ばした: ${skipped.join(" / ")}`);
      return;
    }

    if (cmd === "import-linear") {
      console.log(`取り込み完了: ${await syncLinear(c, env, opt.team, opt.all === true, opt.group)}`);
      return;
    }

    // 誰が誰かは**人が決める**。記録に出てくるのはハンドル名だけで、
    // それが「◯◯さん」だと結び付けられるのは人しかいない。ここは推論しない。
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

    // Claude Code の会話。**ここにしか無い前提がある**（口頭で伝わった判断など）。
    if (cmd === "import-sessions") {
      console.log(`取り込み完了: ${await syncSessions(c, env, cwd, (m) => console.error(`  ${m}`))}`);
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
      const r = await c.query<{
        label: string;
        role: string | null;
        summary: string | null;
        groups: string;
        records: number;
      }>(
        `select s.label, s.role, s.summary,
                coalesce(string_agg(g.name, ', ' order by g.name), '(束なし)') as groups,
                (select count(*) from record where scope_id = s.id)::int as records
         from scope s
         left join group_member m on m.scope_id = s.id
         left join scope_group  g on g.id = m.group_id
         group by s.id, s.label, s.role, s.summary order by s.label`,
      );
      if (r.rows.length === 0) console.log("登録なし");
      for (const x of r.rows) {
        console.log(`${x.label}  [${x.groups}]  記録 ${x.records} 件${x.role ? ` / ${x.role}` : ""}`);
        if (x.summary) console.log(`    ${x.summary}`);
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
