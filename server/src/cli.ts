#!/usr/bin/env node
// gleanery の CLI。取り込み・trace・名簿の書き込みは ingest の鍵、検索は reader の鍵で繋ぐ。
//
// 引数の解釈は @stricli/core に任せる。**コマンドごとに受け付けるフラグと位置引数を宣言する**ので、
// 別のコマンドのフラグ（`gleanery doctor --yes`）も余分な位置引数（`gleanery project list garbage`）も
// 構文の段階で落ちる。使い方の文はこの宣言から組み立て、別に書かない。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ApplicationText,
  ArgumentScannerError,
  buildApplication,
  buildCommand,
  buildRouteMap,
  type CommandInfo,
  formatMessageForArgumentScannerError,
  help,
  run,
  text_en,
  version,
} from "@stricli/core";
import { type Kysely, sql } from "kysely";
import { dbDown, dbInit, dbUp, migrate } from "./admin.ts";
import { check, init } from "./artifacts.ts";
import { flush, readState, rejectedDir, unregisteredDir } from "./capture.ts";
import { type Env, inTransaction, KEY, loadEnv, open, type Role } from "./db.ts";
import type { DB } from "./db-types.ts";
import { syncDocs } from "./docs.ts";
import { describeFill, fillKnowledge, fillMessages } from "./embeddings.ts";
import { syncGithub } from "./github.ts";
import { conversationId } from "./knowledge.ts";
import { foot, inline, type Mark, mark, pad, panel, plain, rule, title, width } from "./panel.ts";
import { observe, packageVersionAt, ROOT, report } from "./plugin.ts";
import { identify, localRoots, nameLocal, type Place, projectId } from "./project.ts";
import {
  directory,
  framed,
  openWork,
  renderHits,
  renderWork,
  searchKnowledge,
  searchMessages,
  workDetail,
} from "./search.ts";
import { DEFAULT_PORT, parsePort, start } from "./server.ts";
import { head, reason } from "./text.ts";
import { describeTitles, fillTitles } from "./titles.ts";
import { checkTrace, saveTrace } from "./trace.ts";

/**
 * エラーの枠の見出し。**振り分けが決めた道の名前だけで作る**（打った引数そのものは入れない）。
 * 引数の解釈より前に決まるので、フラグの綴りを間違えた失敗でもサブコマンドまで出る。
 */
let heading = "gleanery";

/** 止まったときの枠。本文は rule が 1 行ずつ `│ ` を付けるので、引数に仕込んだ改行で締めの行を作れない。 */
const failed = (body: string): string => panel(heading, [plain(body)], `${mark("fail")} 止まった`);

/** 引数の解釈で出た失敗の文。stricli の例外の種類ごとに、何が悪いかを名指しする。 */
const describeScannerError = (e: ArgumentScannerError): string =>
  formatMessageForArgumentScannerError(e, {
    FlagNotFoundError: (x) =>
      `知らないフラグ: --${inline(x.input)}${x.corrections.length ? `（もしかして ${x.corrections.map((c) => `--${c}`).join(" / ")}）` : ""}`,
    AliasNotFoundError: (x) => `知らない短縮フラグ: -${inline(x.input)}`,
    // ここは flag と位置引数を区別できないので、**parse が投げる文が自分で名乗る**。
    ArgumentParseError: (x) => reason(x.exception),
    EnumValidationError: (x) =>
      `--${x.externalFlagName} は ${x.values.join(" か ")} にする: ${inline(x.input)}`,
    UnexpectedFlagError: (x) => `--${x.externalFlagName} は 1 つだけ指定する: ${inline(x.input)}`,
    UnexpectedPositionalError: (x) =>
      `余分な引数: ${inline(x.input)}（このコマンドが取る引数は ${x.expectedCount} 個）`,
    UnsatisfiedFlagError: (x) => `--${x.externalFlagName} に値が無い`,
    UnsatisfiedPositionalError: (x) => `${x.placeholder} を指定する`,
    InvalidNegatedFlagSyntaxError: (x) => `--no-${x.externalFlagName} に値は付けられない`,
  });

/** 使い方と失敗の文。stricli が出す文はここだけで日本語にし、書式を組み立て直さない。 */
const TEXT: ApplicationText = {
  ...text_en,
  headers: {
    usage: "使い方:",
    aliases: "別名:",
    commands: "コマンド:",
    flags: "フラグ:",
    arguments: "引数:",
  },
  keywords: { default: "既定 =", separator: "区切り =" },
  briefs: {
    help: "使い方を出す",
    helpAll: "隠しているコマンドとフラグも含めた使い方を出す",
    version: "この CLI の版と置き場所",
    argumentEscapeSequence: "これより後ろは全部を引数として読む",
  },
  noCommandRegisteredForInput: ({ input, corrections }) =>
    failed(
      `知らないコマンド: ${inline(input)}${corrections.length ? `（もしかして ${corrections.join(" / ")}）` : ""}\n\n--help で使い方を出す`,
    ),
  exceptionWhileParsingArguments: (e) =>
    failed(e instanceof ArgumentScannerError ? describeScannerError(e) : reason(e)),
  exceptionWhileRunningCommand: (e) => failed(reason(e)),
  commandErrorResult: (e) => failed(e.message),
};

async function withDb<T>(env: Env, role: Role, fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const db = open(env, role);
  try {
    return await fn(db);
  } finally {
    await db.destroy().catch(() => {});
  }
}

function placeOf(cwd: string): Place {
  const place = identify(cwd);
  if (!place) {
    throw new Error(
      `${cwd} は git の remote を持たず、名前も付いていない。\`gleanery project add --name <名前>\` で名前を付ける`,
    );
  }
  return place;
}

async function registered(db: Kysely<DB>, place: Place): Promise<number> {
  const id = await projectId(db, place.key);
  if (id === null)
    throw new Error(`${place.name} は gleanery に登録されていない。\`gleanery project add\` で登録する`);
  return id;
}

/** trace の記録を読む。`-` は標準入力（Skill はファイルを作らずに渡す）。 */
const readTrace = (file: string): unknown => JSON.parse(fs.readFileSync(file === "-" ? 0 : file, "utf8"));

const githubRepo = (key: string): string | null =>
  key.match(/^git:github\.com\/([^/]+\/[^/]+)$/)?.[1] ?? null;

/**
 * 1 つの作業場所を同期する。**GitHub と文書は互いに独立**なので、片方が落ちてももう片方は回す。
 * 失敗は取り込み元の last_error に残し（doctor と画面が出す）、最後にまとめて投げる。
 */
async function syncOne(db: Kysely<DB>, id: number, place: Place, resetDocs = false): Promise<string[]> {
  const out: string[] = [];
  const failures: string[] = [];
  const one = async (provider: "github" | "docs", label: string, fn: () => Promise<string>) => {
    try {
      out.push(`${label}: ${await fn()}`);
    } catch (e) {
      const message = reason(e);
      await db
        .updateTable("gleanery.connector")
        .set({ last_error: message.slice(0, 500) })
        .where("project_id", "=", String(id))
        .where("provider", "=", provider)
        .execute()
        .catch(() => {});
      failures.push(`${place.name} の ${provider}: ${message}`);
    }
  };
  const repo = githubRepo(place.key);
  if (repo) await one("github", "GitHub", () => syncGithub(db, id, place.name, repo));
  if (fs.existsSync(path.join(place.root, ".git")))
    await one("docs", "文書", () =>
      syncDocs(db, id, place.root, { remote: place.key.startsWith("git:"), reset: resetDocs }),
    );
  if (failures.length) throw new Error([...out, ...failures].join("\n  "));
  return out;
}

type Host = "claude-code" | "codex";
const HOSTS: Host[] = ["claude-code", "codex"];
const SESSION_ENV: Record<Host, string[]> = {
  "claude-code": ["CLAUDE_CODE_SESSION_ID"],
  codex: ["CODEX_THREAD_ID", "CODEX_SESSION_ID"],
};

/**
 * いまの session。**両方のホストの id が環境にあれば決めない**（Claude Code の Bash から起動した Codex は
 * CLAUDE_CODE_SESSION_ID を継ぐ。先に見つかった方を使うと、別のホストの session を読んで書く）。
 */
function hostSession(host?: Host): { host: Host; id: string } {
  const found = HOSTS.flatMap((h) => {
    const id = SESSION_ENV[h].map((k) => process.env[k]).find(Boolean);
    return id && (!host || h === host) ? [{ host: h, id }] : [];
  });
  if (found.length === 1 && found[0]) return found[0];
  if (found.length > 1)
    throw new Error(
      "Claude Code と Codex の両方の session が環境にある。自分のホストを --host claude-code か --host codex で指定する",
    );
  throw new Error(
    host
      ? `${host} の session の id が環境に無い（${SESSION_ENV[host].join(" / ")}）`
      : "いまの session の id が分からない（Claude Code か Codex の中で実行する）",
  );
}

async function traceContext(env: Env, cwd: string, host?: Host): Promise<string> {
  const session = hostSession(host);
  // 待ち行列に残っている分を先に送る。送れなくても続ける（会話は自分の文脈から書ける）。
  await flush(env).catch(() => {});
  const place = placeOf(cwd);
  return withDb(env, "reader", async (db) => {
    const id = await registered(db, place);
    const conversation = conversationId(id, session.host, session.id);
    const messages = await db
      .selectFrom("gleanery.message as m")
      .select([
        "m.speaker_kind",
        "m.body",
        "m.sent_at",
        "m.truncated",
        sql<string[]>`array(select f.path from gleanery.message_file f
          where f.message_id = m.id order by f.path)`.as("paths"),
      ])
      .where("m.conversation_id", "=", conversation)
      .orderBy("m.sent_at")
      .execute();
    const mine = await db
      .selectFrom("gleanery.knowledge")
      .select(["source_key", "kind", "status", "body"])
      .where("conversation_id", "=", conversation)
      .where("kind", "<>", "option")
      .orderBy("occurred_at")
      .execute();
    const works = await openWork(db, [id], 5);
    const detail = works.length === 1 && works[0] ? await workDetail(db, works[0].ref.slice(2)) : null;
    const workKeys = await db
      .selectFrom("gleanery.work_item")
      .select(["source_key", "title", "status"])
      .where("project_id", "=", String(id))
      .where("status", "in", ["active", "blocked", "paused"])
      .execute();
    const decisions = await db
      .selectFrom("gleanery.knowledge as k")
      .innerJoin("gleanery.work_item as w", "w.id", "k.work_item_id")
      .select(["k.source_key", "k.status", "k.body"])
      .where("k.project_id", "=", String(id))
      .where("k.kind", "=", "decision")
      .where("w.status", "in", ["active", "blocked", "paused"])
      .orderBy("k.occurred_at", "desc")
      .limit(30)
      .execute();
    // 持ち主の発言は長めに、AI の応答は要点だけ出す（決めたのは持ち主の発言で、AI の応答はその前後）。
    const said = messages.map(
      (m) =>
        `## ${m.speaker_kind === "self" ? "持ち主" : "AI"}（${m.sent_at.toISOString()}）${m.truncated ? " ※一部だけ保存" : ""}\n` +
        `${head(m.body, m.speaker_kind === "self" ? 4000 : 800)}${m.paths.length ? `\nこの発言の後に触ったファイル: ${m.paths.join(" / ")}` : ""}`,
    );
    const edited = [...new Set(messages.flatMap((m) => m.paths))];
    return [
      `session: ${session.host} ${session.id}（作業場所 ${place.name}）`,
      messages.length
        ? `\n# この session の会話（自動記録）\n\n${said.join("\n\n")}`
        : "\n# この session の会話\n\nまだ記録されていない。自分の文脈から書く。",
      edited.length ? `\n# この session で触ったファイル\n\n${edited.map((p) => `- ${p}`).join("\n")}` : null,
      mine.length
        ? `\n# この session で既に記録した要素（同じ key で書くと上書き）\n\n${mine.map((k) => `- ${k.source_key.split("#")[1]}（${k.kind}${k.status ? ` / ${k.status}` : ""}）${head(k.body, 200)}`).join("\n")}`
        : null,
      workKeys.length
        ? `\n# 進行中の作業（work.key に同じ key を書くと更新）\n\n${workKeys.map((w) => `- ${w.source_key}: ${w.title}（${w.status}）`).join("\n")}`
        : "\n# 進行中の作業\n\n無い。",
      detail ? `\n${renderWork(detail, 6000)}` : null,
      decisions.length
        ? `\n# 進行中の作業の決定（覆すなら supersedes にこの key を書く）\n\n${decisions.map((d) => `- ${d.source_key}（${d.status}）${head(d.body, 200)}`).join("\n")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
  });
}

async function doctor(env: Env, cwd: string): Promise<void> {
  const issues: string[] = [];
  const count = (m: Mark, label: string) => {
    if (m === "warn" || m === "fail") issues.push(label);
    if (m === "fail") process.exitCode = 1;
  };
  const say = (m: Mark, label: string, text: string) => {
    count(m, label);
    console.log(rule(`${mark(m)} ${pad(label, 26)}${text}`));
  };
  console.log(title("gleanery doctor"));
  // DB より先に出す。版の食い違いは DB と無関係に見たい。
  const plugin = report(observe(identify(cwd)?.root ?? cwd));
  issues.push(...plugin.issues);
  for (const line of plugin.lines) console.log(rule(line));
  console.log(rule(""));
  // owner の鍵は schema の適用にしか使わないので、ここでは繋がない（DDL の鍵を使う場面を増やさない）。
  for (const role of ["reader", "ingest", "capture"] as const) {
    if (!env[KEY[role]]) {
      say("fail", KEY[role], "無い");
      continue;
    }
    try {
      await withDb(env, role, async (db) => {
        // 鍵ごとに、その鍵で読める表を 1 つだけ触る（capture は本文を読めない）。
        await (role === "capture"
          ? sql`select id from gleanery.project limit 1`
          : sql`select 1 from gleanery.knowledge limit 1`
        ).execute(db);
      });
      say("ok", KEY[role], "繋がる / schema は期待どおり");
    } catch (e) {
      say("fail", KEY[role], `繋がらない: ${plain(reason(e))}`);
    }
  }
  say(
    env.VOYAGE_API_KEY ? "ok" : "fail",
    "VOYAGE_API_KEY",
    env.VOYAGE_API_KEY ? "あり" : "無い（検索と取り込みの埋め込みが止まる）",
  );
  const s = readState();
  say(
    s.stuck ? "fail" : s.rejected ? "warn" : "ok",
    "自動記録",
    `待ち ${s.pending} 件${s.flushedAt ? ` / 最後の送信 ${new Date(s.flushedAt).toLocaleString("sv-SE")}` : ""}${
      s.stuck ? ` / 失敗: ${plain(s.stuck)}` : ""
    }${s.unregistered ? ` / 未登録の作業場所で退避した ${s.unregistered} 件（${unregisteredDir()}）` : ""}${
      s.rejected ? ` / DB が受け付けなかった ${s.rejected} 件（${rejectedDir()}）` : ""
    }`,
  );
  if (env[KEY.reader]) {
    try {
      await withDb(env, "reader", async (db) => {
        // 手元の DB に論理サイズの上限は無い。尽きるのはディスクなので、ここでは使用量だけを出す。
        const cap = await sql<{ used: string }>`
          select pg_size_pretty(pg_database_size(current_database())) as used`.execute(db);
        const used = cap.rows[0]?.used;
        if (used) say("ok", "DB の大きさ", used);
        const emb = await sql<{ t: string; status: string; n: string }>`
          select 'knowledge' as t, status, count(*) as n from gleanery.knowledge_embedding
           where status <> 'ready' group by status
          union all
          select 'message', status, count(*) from gleanery.message_embedding
           where status <> 'ready' group by status`.execute(db);
        // pending は打つまで埋まらない（定期実行は無い）ので、意味検索に出てこない行が残り続ける。
        // error は再試行の上限で止まった行で、harvest を打っても戻らない。
        say(
          emb.rows.length ? "none" : "ok",
          "埋め込みの残り",
          emb.rows.length
            ? `${emb.rows.map((r) => `${r.t} ${r.status} ${r.n}`).join(" / ")}${
                emb.rows.some((r) => r.status === "pending")
                  ? " ← pending は gleanery harvest で取り直す"
                  : ""
              }`
            : "無い",
        );
        const { found } = localRoots();
        const rows = await db
          .selectFrom("gleanery.project as p")
          .leftJoin("gleanery.connector as cn", "cn.project_id", "p.id")
          .select(["p.key", "p.name", "cn.provider", "cn.last_success_at", "cn.last_error"])
          .orderBy("p.name")
          .orderBy("cn.provider")
          .execute();
        if (rows.length) console.log(`${rule("")}\n${rule("作業場所")}`);
        const label = (x: (typeof rows)[number]) => `${x.name} ${x.provider ?? "未同期"}`;
        const column = Math.max(...rows.map((x) => width(label(x)))) + 2;
        for (const x of rows) {
          // 取り込みは gleanery harvest を打ったときだけ走る。間が空くのは運用どおりなので、失敗だけを直すものに数える。
          const m: Mark = x.last_error ? "fail" : x.provider === null || !x.last_success_at ? "none" : "ok";
          count(m, `作業場所 ${label(x)}`);
          const where = found.get(x.key) ? "" : "（この PC に置き場所が無い）";
          console.log(
            rule(
              `  ${mark(m)} ${pad(label(x), column)}${
                x.last_success_at
                  ? `最後の取り込み ${x.last_success_at.toLocaleString("sv-SE")}`
                  : "まだ取り込んでいない"
              }${x.last_error ? ` / 失敗: ${plain(x.last_error)}` : ""}${where}`,
            ),
          );
        }
      });
    } catch (e) {
      say("fail", "DB", `読めない: ${plain(reason(e))}`);
    }
  }
  // 件数は行の数で数え、名前だけ重ねない（同じ名前の Codex の cache や作業場所が複数あっても件数は減らさない）。
  console.log(
    foot(
      issues.length
        ? `直すもの ${issues.length} 件: ${[...new Set(issues)]
            .map((name) => {
              const n = issues.filter((x) => x === name).length;
              return n > 1 ? `${name} ×${n}` : name;
            })
            .join(" / ")}`
        : "直すものは無い",
    ),
  );
}

/** どのコマンドでも同じ意味の `--cwd`。渡さなければいまのディレクトリ。 */
const CWD = {
  kind: "parsed",
  parse: String,
  brief: "作業場所のディレクトリ（既定はいまのディレクトリ）",
  placeholder: "dir",
  optional: true,
} as const;

// MCP は 1〜10 に縛っている。CLI だけ穴を開けると、負の値が Voyage の top_k へそのまま流れる。
function limitOf(input: string): number {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error(`--limit は 1 から 20 の整数にする: ${input}`);
  return n;
}

const projectRoutes = buildRouteMap({
  docs: { brief: "記録する作業場所の登録と、消去" },
  routes: {
    add: buildCommand({
      docs: { brief: "作業場所を登録する（remote が無いなら --name でこの PC での名前を付ける）" },
      parameters: {
        flags: {
          cwd: CWD,
          name: {
            kind: "parsed",
            parse: String,
            brief: "remote を持たない作業場所に、この PC での名前を付ける",
            placeholder: "名前",
            optional: true,
          },
        },
      },
      func: async (flags: { cwd?: string; name?: string }) => {
        const cwd = flags.cwd ?? process.cwd();
        const place = flags.name ? nameLocal(cwd, flags.name) : placeOf(cwd);
        await withDb(loadEnv(), "ingest", async (db) => {
          const added = await db
            .insertInto("gleanery.project")
            .values({ key: place.key, name: place.name })
            .onConflict((oc) => oc.column("key").doNothing())
            .returning("id")
            .executeTakeFirst();
          console.log(
            panel(
              "gleanery project add",
              [],
              added
                ? `登録した: ${place.name}（${place.key}）`
                : `既に登録済み: ${place.name}（${place.key}）`,
            ),
          );
        });
      },
    }),
    list: buildCommand({
      docs: { brief: "登録済みの作業場所と、最後の同期" },
      parameters: {},
      func: async () => {
        const { found, ambiguous } = localRoots();
        await withDb(loadEnv(), "reader", async (db) => {
          const listed = await db
            .selectFrom("gleanery.project as p")
            .leftJoin("gleanery.connector as cn", "cn.project_id", "p.id")
            .select(["p.key", "p.name", (eb) => eb.fn.max("cn.last_success_at").as("last")])
            .groupBy("p.id")
            .orderBy("p.name")
            .execute();
          const rows = listed.map((x) => {
            const where =
              found.get(x.key) ??
              (ambiguous.has(x.key) ? "置き場所が複数ある（同期しない）" : "この PC に無い");
            return `${x.name}  ${x.key}\n  ${where}${x.last ? ` / 最後の同期 ${x.last.toLocaleString("sv-SE")}` : ""}`;
          });
          console.log(
            panel(
              "gleanery project list",
              rows,
              rows.length ? `${rows.length} 件` : "登録なし。gleanery project add で登録する",
            ),
          );
        });
      },
    }),
    forget: buildCommand({
      docs: { brief: "作業場所のデータを消す（--yes が無ければ数えるだけ）" },
      parameters: {
        flags: { yes: { kind: "boolean", brief: "本当に消す（元に戻せない）", optional: true } },
        positional: {
          kind: "tuple",
          parameters: [{ parse: String, brief: "消す作業場所の key か名前", placeholder: "key|名前" }],
        },
      },
      func: async (flags: { yes?: boolean }, target: string) => {
        await withDb(loadEnv(), "ingest", async (db) => {
          const hit = await db
            .selectFrom("gleanery.project")
            .select(["id", "key", "name"])
            .where((eb) => eb.or([eb("key", "=", target), eb("name", "=", target)]))
            .execute();
          if (hit.length !== 1)
            throw new Error(`${target} に当たる作業場所が ${hit.length} 件ある。key で指定する`);
          const p = hit[0] as { id: string; key: string; name: string };
          const x = await db
            .selectFrom("gleanery.project")
            .select([
              sql<string>`(select count(*) from gleanery.conversation where project_id = ${p.id})`.as(
                "conversations",
              ),
              sql<string>`(select count(*) from gleanery.message m
                join gleanery.conversation c on c.id = m.conversation_id where c.project_id = ${p.id})`.as(
                "messages",
              ),
              sql<string>`(select count(*) from gleanery.knowledge where project_id = ${p.id})`.as(
                "knowledge",
              ),
              sql<string>`(select count(*) from gleanery.source_item s
                join gleanery.connector cn on cn.id = s.connector_id where cn.project_id = ${p.id})`.as(
                "items",
              ),
            ])
            .where("id", "=", p.id)
            .executeTakeFirst();
          const counts = `${p.name}（${p.key}）: 会話 ${x?.conversations} / 発言 ${x?.messages} / 知識 ${x?.knowledge} / 取り込み元の項目 ${x?.items}`;
          if (flags.yes !== true) {
            console.log(
              panel(
                "gleanery project forget",
                [counts],
                "消していない。消すなら --yes を付ける。元に戻せない",
              ),
            );
            return;
          }
          await db.deleteFrom("gleanery.project").where("id", "=", p.id).execute();
          console.log(panel("gleanery project forget", [counts], "消した"));
        });
      },
    }),
  },
});

const traceRoutes = buildRouteMap({
  docs: { brief: "判断の記録（trace）を読み、形を確かめ、DB へ入れる" },
  routes: {
    context: buildCommand({
      docs: { brief: "いまの session の会話と、進行中の作業を出す（trace の材料）" },
      parameters: {
        flags: {
          host: {
            kind: "enum",
            values: HOSTS,
            brief: "自分のホスト（両方の session が環境にあるときに要る）",
            optional: true,
          },
        },
      },
      func: async (flags: { host?: Host }) => {
        console.log(framed(await traceContext(loadEnv(), process.cwd(), flags.host)));
      },
    }),
    check: buildCommand({
      docs: { brief: "trace の記録の形を確かめる（DB に触らない）" },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [{ parse: String, brief: "trace の記録（- は標準入力）", placeholder: "trace.json|-" }],
        },
      },
      func: (_flags: Record<never, never>, file: string) => {
        const r = checkTrace(readTrace(file));
        if (r.problems.length) {
          console.error(
            panel(
              "gleanery trace check",
              r.problems.map((p) => `${mark("fail")} ${p}`),
              `問題 ${r.problems.length} 件`,
            ),
          );
          process.exitCode = 1;
          return;
        }
        console.log(
          panel(
            "gleanery trace check",
            [],
            `${mark("ok")} 形は通った: 要素 ${r.trace?.items.length ?? 0} 件`,
          ),
        );
      },
    }),
    save: buildCommand({
      docs: { brief: "trace の記録を入れる（同じ key は上書き）" },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [{ parse: String, brief: "trace の記録（- は標準入力）", placeholder: "trace.json|-" }],
        },
      },
      func: async (_flags: Record<never, never>, file: string) => {
        const env = loadEnv();
        const r = checkTrace(readTrace(file));
        if (!r.trace) throw new Error(`記録の形が通らない:\n${r.problems.map((p) => `  ${p}`).join("\n")}`);
        const trace = r.trace;
        // 書けるのはいまの session の記録だけ。ファイルの session を信じると、別の session の決定や制約を上書きできる。
        const now = hostSession(trace.session.host);
        if (now.id !== trace.session.id)
          throw new Error(
            `記録の session（${trace.session.id}）が、いまの ${now.host} の session（${now.id}）と違う。trace context が出した session を書く`,
          );
        const place = placeOf(process.cwd());
        await withDb(env, "ingest", async (db) => {
          const id = await registered(db, place);
          const saved = await saveTrace(db, env, id, trace);
          console.log(
            panel(
              "gleanery trace save",
              [],
              [
                `入れた: 書き直した要素 ${saved.written} 件${saved.superseded ? ` / 覆した決定 ${saved.superseded} 件` : ""}`,
                describeFill("埋め込み", saved.embedding),
              ]
                .filter(Boolean)
                .join(" / "),
            ),
          );
        });
      },
    }),
  },
});

const captureRoutes = buildRouteMap({
  docs: { brief: "会話の自動記録" },
  routes: {
    flush: buildCommand({
      docs: { brief: "自動記録の待ち行列を DB へ送る" },
      parameters: {},
      func: async () => {
        const r = await flush(loadEnv());
        if (r.busy) {
          console.log(
            panel(
              "gleanery capture flush",
              [],
              "別の送信が走っているので何もしなかった（終われば待ち行列は空になる）",
            ),
          );
          return;
        }
        console.log(
          panel(
            "gleanery capture flush",
            [],
            `新しく入った発言 ${r.sent} 件${r.deferred ? ` / 未登録の作業場所で退避した ${r.deferred} 件` : ""}${
              r.rejected ? ` / DB が受け付けなかった ${r.rejected} 件（${rejectedDir()} に残した）` : ""
            }`,
          ),
        );
      },
    }),
  },
});

const dbRoutes = buildRouteMap({
  docs: { brief: "この PC の PostgreSQL（docker compose）と schema" },
  routes: {
    init: buildCommand({
      docs: {
        brief: "この PC の DB を用意する（鍵づくり・起動・schema・ロールの鍵。何度流してもよい）",
      },
      parameters: {},
      func: () => dbInit(),
    }),
    up: buildCommand({
      docs: { brief: "DB を起動する" },
      parameters: {},
      func: () => dbUp(),
    }),
    down: buildCommand({
      docs: { brief: "DB を止める（データは残る）" },
      parameters: {},
      func: () => dbDown(),
    }),
    migrate: buildCommand({
      docs: { brief: "DB の版より新しい db/migrations を当てる" },
      parameters: {
        flags: {
          yes: { kind: "boolean", brief: "接続先の確認を省く（端末でないときは必須）", optional: true },
        },
      },
      func: (flags: { yes?: boolean }) => migrate(flags.yes === true),
    }),
  },
});

const root = buildRouteMap({
  docs: {
    brief: "過去の判断・会話・文書を溜めて引く",
    fullDescription: "資格情報: ~/.gleanery/env（GLEANERY_DB_URL_RO / _INGEST / _CAPTURE と VOYAGE_API_KEY）",
  },
  routes: {
    project: projectRoutes,
    harvest: buildCommand({
      docs: {
        brief: "この PC にある作業場所の GitHub と文書を同期する",
        fullDescription:
          "文書は remote の既定 branch から入れ、fast-forward でなければ止まる（--reset-docs はその作業場所を今の状態に揃える）。",
      },
      parameters: {
        flags: {
          cwd: CWD,
          "reset-docs": {
            kind: "boolean",
            brief: "文書をその作業場所の今の状態に揃える（--cwd と一緒にだけ使える）",
            optional: true,
          },
        },
      },
      func: async (flags: { cwd?: string; "reset-docs"?: boolean }) => {
        const env = loadEnv();
        const resetDocs = flags["reset-docs"] === true;
        // 揃え直しは作業場所を 1 つ名指ししたときだけ（全件の同期で、比較不能な作業場所をまとめて上書きしない）。
        if (resetDocs && !flags.cwd)
          throw new Error("--reset-docs は --cwd で作業場所を 1 つ指定したときだけ使える");
        // ログは追記で残るので、いつ走ったかを見出しに必ず出す。
        const startedAt = new Date();
        console.log(title(`gleanery harvest ${startedAt.toLocaleString("sv-SE")}`));
        await flush(env).catch((e: unknown) =>
          console.error(rule(`${mark("fail")} 自動記録の送信に失敗: ${plain(reason(e))}`)),
        );
        const failures: string[] = [];
        let done = 0;
        try {
          await withDb(env, "ingest", async (db) => {
            const only = flags.cwd ? placeOf(flags.cwd) : null;
            if (only) await registered(db, only);
            const { found, ambiguous } = localRoots();
            const projects = await db
              .selectFrom("gleanery.project")
              .select(["id", "key", "name"])
              .orderBy("name")
              .execute();
            for (const p of projects) {
              if (only && only.key !== p.key) continue;
              const root = only?.root ?? found.get(p.key);
              if (!root) {
                console.log(
                  rule(
                    `${mark("none")} ${p.name}: 飛ばした（${ambiguous.has(p.key) ? "この PC に置き場所が複数ある" : "この PC に置き場所が無い"}）`,
                  ),
                );
                continue;
              }
              try {
                const place = { key: p.key, root, name: p.name };
                for (const line of await syncOne(db, Number(p.id), place, resetDocs)) {
                  console.log(rule(`${mark("ok")} ${p.name} / ${line}`));
                }
                done++;
              } catch (e) {
                // 1 つ落ちても残りは回す。失敗は終了コードへ出す（launchd の LastExitStatus で見える）。
                failures.push(p.name);
                const lines = plain(reason(e)).split("\n");
                console.error(
                  rule(
                    [
                      `${mark("fail")} ${p.name}`,
                      ...lines.map((l) => (l.trim() ? `  ${l.trim()}` : "")),
                    ].join("\n"),
                  ),
                );
              }
            }
            // 埋め込みと題は全部の作業場所を書き終えてから 1 回だけ埋める（自動記録と前回までの取り残しを含む）。
            for (const line of [
              describeFill("知識の埋め込み", await fillKnowledge(db, env)),
              describeFill("発言の埋め込み", await fillMessages(db, env)),
              describeTitles(await fillTitles(db, env)),
            ])
              if (line) console.log(rule(line));
          });
        } catch (e) {
          // 見出しを出した後で止まっても、枠を閉じてから終わる（ログは日をまたいで追記される）。
          console.error(rule(`${mark("fail")} ${plain(reason(e))}`));
          console.log(foot(`${mark("fail")} 止まった ${new Date().toLocaleString("sv-SE")}`));
          process.exitCode = 1;
          return;
        }
        console.log(
          foot(
            `おわり ${new Date().toLocaleString("sv-SE")} / ${Math.round((Date.now() - startedAt.getTime()) / 1000)} 秒 / 成功 ${done}${
              failures.length ? ` / 失敗 ${failures.join(" / ")}` : ""
            }`,
          ),
        );
        if (failures.length) process.exitCode = 1;
      },
    }),
    search: buildCommand({
      docs: { brief: "引けるかを確かめる（--said は発言を探す）" },
      parameters: {
        flags: {
          avoid: { kind: "boolean", brief: "棄却済みか、行き止まりだけを引く", optional: true },
          said: {
            kind: "parsed",
            parse: String,
            brief: "発言を探す（me / others / 呼び名）",
            placeholder: "me|others|名前",
            optional: true,
          },
          all: { kind: "boolean", brief: "すべての作業場所から引く", optional: true },
          cwd: CWD,
          limit: {
            kind: "parsed",
            parse: limitOf,
            brief: "出す件数（1 から 20）",
            placeholder: "N",
            default: "5",
          },
        },
        positional: { kind: "array", parameter: { parse: String, brief: "質問", placeholder: "質問" } },
      },
      func: async (
        flags: { avoid?: boolean; said?: string; all?: boolean; cwd?: string; limit: number },
        ...words: string[]
      ) => {
        const env = loadEnv();
        const question = words.join(" ");
        if (!question && !flags.said) throw new Error("質問を指定する（--said なら質問は要らない）");
        const place = flags.all ? null : placeOf(flags.cwd ?? process.cwd());
        await withDb(env, "reader", async (db) => {
          const projects = place ? [await registered(db, place)] : null;
          const hits = flags.said
            ? await searchMessages(db, env, {
                question: question || undefined,
                projects,
                who: flags.said,
                limit: flags.limit,
              })
            : await searchKnowledge(db, env, {
                question,
                projects,
                avoid: flags.avoid,
                limit: flags.limit,
              });
          // この出力はエージェントも読む（Bash から叩く）。記録の囲い（framed）を通し、本文の制御文字は落とす。
          console.log(
            panel(
              "gleanery search",
              hits.length ? [plain(framed(renderHits(hits, 16 * 1024)))] : [],
              `${hits.length ? `${hits.length} 件` : "該当なし"} / ${place ? place.name : "すべての作業場所"}`,
            ),
          );
        });
      },
    }),
    who: buildCommand({
      docs: { brief: "GitHub のハンドルと人を結ぶ（引数なしで名簿を出す）" },
      parameters: {
        flags: { me: { kind: "boolean", brief: "この人を持ち主にする", optional: true } },
        positional: {
          kind: "array",
          parameter: {
            parse: String,
            brief: "呼び名、その後に GitHub のハンドル",
            placeholder: "呼び名|ハンドル",
          },
        },
      },
      func: async (flags: { me?: boolean }, ...args: string[]) => {
        await withDb(loadEnv(), args.length ? "ingest" : "reader", async (db) => {
          if (args.length === 0) {
            const people = await directory(db);
            const unknown = await db
              .selectFrom("gleanery.person_identity as i")
              .leftJoin("gleanery.message as m", "m.identity_id", "i.id")
              .select(["i.handle", (eb) => eb.fn.count("m.id").as("n")])
              .where("i.person_id", "is", null)
              .groupBy("i.id")
              .orderBy((eb) => eb.fn.count("m.id"), "desc")
              .limit(20)
              .execute();
            console.log(
              panel(
                "gleanery who",
                [
                  ...people.map(
                    (p) => `${p.isSelf ? "→ " : "  "}${pad(inline(p.display), 12)}${p.handles.join(" / ")}`,
                  ),
                  ...(unknown.length
                    ? [
                        "",
                        "まだ誰か決めていないハンドル（発言の多い順）:",
                        ...unknown.map((u) => `  ${String(u.n).padStart(5)} 件  ${u.handle}`),
                      ]
                    : []),
                ],
                people.length
                  ? `${people.length} 人`
                  : "名簿は空。gleanery who <呼び名> <ハンドル>... で入れる",
              ),
            );
            return;
          }
          const [display, ...handles] = args;
          if (!display || handles.length === 0)
            throw new Error("呼び名と、GitHub のハンドルを 1 つ以上指定する");
          // 持ち主の付け替えは 1 つの transaction で。途中で落ちると持ち主が 0 人になる。
          const linked = await inTransaction(db, async (trx) => {
            if (flags.me)
              await trx
                .updateTable("gleanery.person")
                .set({ is_self: false })
                .where("is_self", "=", true)
                .execute();
            const pe = await trx
              .insertInto("gleanery.person")
              .values({ display_name: display, is_self: flags.me === true })
              .onConflict((oc) =>
                oc.column("display_name").doUpdateSet({
                  is_self: sql<boolean>`gleanery.person.is_self or excluded.is_self`,
                }),
              )
              .returning("id")
              .executeTakeFirst();
            return await trx
              .updateTable("gleanery.person_identity")
              .set({ person_id: pe?.id ?? null })
              .where("provider", "=", "github")
              .where(
                sql<boolean>`lower(handle) = any(${handles.map((h) => h.replace(/^@/, "").toLowerCase())})`,
              )
              .returning("handle")
              .execute();
          });
          const missing = handles.filter(
            (h) => !linked.some((l) => l.handle.toLowerCase() === h.replace(/^@/, "").toLowerCase()),
          );
          console.log(
            panel(
              "gleanery who",
              missing.length
                ? [
                    `まだ取り込んでいないハンドル: ${missing.map(inline).join(" / ")}（同期の後にもう一度結ぶ）`,
                  ]
                : [],
              `名簿に入れた: ${inline(display)}${flags.me ? "（持ち主）" : ""} = ${linked.map((l) => l.handle).join(" / ") || "（結べたハンドルなし）"}`,
            ),
          );
        });
      },
    }),
    trace: traceRoutes,
    capture: captureRoutes,
    db: dbRoutes,
    init: buildCommand({
      docs: { brief: "要件定義と設計書の置き場所 .gleanery/ をリポジトリの根に作る" },
      parameters: { flags: { cwd: CWD } },
      func: (flags: { cwd?: string }) => {
        const r = init(flags.cwd ?? process.cwd());
        console.log(
          panel(
            "gleanery init",
            [],
            r.created ? `.gleanery を作った: ${r.root}` : `.gleanery は既に初期化済み: ${r.root}`,
          ),
        );
      },
    }),
    check: buildCommand({
      docs: { brief: ".gleanery/ の change.json を検査する（DB に触らない）" },
      parameters: { flags: { cwd: CWD } },
      func: (flags: { cwd?: string }) => {
        const r = check(flags.cwd ?? process.cwd());
        if (r.problems.length) {
          process.exitCode = 1;
          console.error(
            panel(
              "gleanery check",
              r.problems.map((p) => `${mark("fail")} ${p.path}: ${p.reason}`),
              `.gleanery の検査で ${r.problems.length} 件の問題: ${r.root}`,
            ),
          );
          return;
        }
        console.log(
          panel(
            "gleanery check",
            [],
            `${mark("ok")} .gleanery の検査は通った: ${r.root}（change ${r.changes} 件）`,
          ),
        );
      },
    }),
    dashboard: buildCommand({
      docs: { brief: "画面を 127.0.0.1 に立てる（Ctrl-C で止める）" },
      parameters: {
        flags: {
          port: {
            kind: "parsed",
            parse: (raw) => parsePort(raw, "--port"),
            brief: `待ち受ける port（既定 ${DEFAULT_PORT}）`,
            optional: true,
          },
        },
      },
      func: (flags: { port?: number }) => {
        // 前面で動かし続ける。**背景へ回さない** — 止め方が Ctrl-C だけなので、
        // 端末から見えなくなると止められないプロセスが残る。
        start(flags.port ?? parsePort(process.env.GLEANERY_DASHBOARD_PORT));
      },
    }),
    doctor: buildCommand({
      docs: { brief: "npm packageとpluginの版、鍵と接続、schema、同期と自動記録の状態" },
      parameters: {},
      func: () => doctor(loadEnv(), process.cwd()),
    }),
    advice: buildCommand({
      docs: { brief: "編集フックが制約を出した割合" },
      parameters: {},
      func: () => {
        // 編集フックが役に立っているかを測る。1 か月見て、出した割合が低ければフックごと消す。
        const log = path.join(os.homedir(), ".gleanery", "advice.jsonl");
        if (!fs.existsSync(log)) {
          console.log(panel("gleanery advice", [], "まだ記録が無い（編集フックが一度も走っていない）"));
          return;
        }
        // 途中で切れた行（書いている最中に止まったプロセス）は飛ばす。1 行のために全体を読めなくしない。
        const rows = fs
          .readFileSync(log, "utf8")
          .split("\n")
          .flatMap((l) => {
            try {
              const r = JSON.parse(l) as { at?: unknown; shown?: unknown };
              return typeof r.at === "string" && typeof r.shown === "number"
                ? [{ at: r.at, shown: r.shown }]
                : [];
            } catch {
              return [];
            }
          });
        const shown = rows.filter((r) => r.shown > 0);
        const since = rows[0]?.at;
        console.log(
          panel(
            "gleanery advice",
            [
              `フックが走った編集   ${rows.length} 回`,
              `制約を出した         ${shown.length} 回`,
              ...(since ? [`記録の始まり         ${new Date(since).toLocaleString("sv-SE")}`] : []),
            ],
            `制約を出した割合 ${((shown.length / Math.max(rows.length, 1)) * 100).toFixed(1)}%`,
          ),
        );
      },
    }),
  },
});

const FORMATTING = {
  useAliasInUsageLine: false,
  onlyRequiredInUsageLine: false,
  caseStyle: "original",
} as const;

const app = buildApplication(
  root,
  {
    name: "gleanery",
    localization: { text: TEXT },
    // 枠と印の色は panel.ts が決める（標準出力と標準エラーの両方が端末のときだけ付ける）。
    documentation: { disableAnsiColor: true },
  },
  {
    help: help({
      brief: TEXT.briefs.help,
      alias: "h",
      defaultForRouteMap: true,
      includeHidden: false,
      formatting: FORMATTING,
    }),
    helpAll: help({
      brief: TEXT.briefs.helpAll,
      alias: "H",
      hidden: true,
      includeHidden: true,
      formatting: FORMATTING,
    }),
    version: version({
      brief: TEXT.briefs.version,
      alias: "v",
      info: { getCurrentVersion: async () => `${packageVersionAt(ROOT) ?? "不明"}  ${ROOT}` },
    }),
  },
);

await run(app, process.argv.slice(2), {
  process,
  forCommand: ({ prefix }: CommandInfo) => {
    heading = prefix.join(" ");
    return { process };
  },
});
// stricli の内部の終了コードは負（引数の解釈の失敗は -4）。シェルは下位 8 bit しか見ないので 1 に寄せる。
if (typeof process.exitCode === "number" && process.exitCode < 0) process.exitCode = 1;
