#!/usr/bin/env node
// gleanery の CLI。取り込み・trace・名簿の書き込みは ingest の接続、検索は reader の接続で繋ぐ（sqlite.ts・db-write.ts）。
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
import { jsonArrayFrom } from "kysely/helpers/sqlite";
import { dbInit, inspect, migrate, reindex } from "./admin.ts";
import { check, init } from "./artifacts.ts";
import { flush, readState, rejectedDir, unregisteredDir } from "./capture.ts";
import { dbFile, inTransaction, openReader, type Role, SCHEMA_REVISION } from "./db.ts";
import type { DB } from "./db-types.ts";
import { openWriter } from "./db-write.ts";
import { syncDocs } from "./docs.ts";
import { syncGithub } from "./github.ts";
import { conversationId } from "./knowledge.ts";
import { kindColor } from "./palette.ts";
import { inline, type Mark, mark, pad, plain, width } from "./panel.ts";
import { observe, packageVersionAt, ROOT, report, UPDATE_NOTE } from "./plugin.ts";
import {
  connectorOf,
  identify,
  localRoots,
  nameLocal,
  type Place,
  projectId,
  relativeTo,
} from "./project.ts";
import {
  directory,
  framed,
  type Hit,
  openWork,
  renderHits,
  renderWork,
  searchMessages,
  searchSplit,
  workDetail,
} from "./search.ts";
import { requireRuntime } from "./sqlite.ts";
import { ftsQuery, head, reason } from "./text.ts";
import { checkTrace, saveTrace } from "./trace.ts";
import { runTui } from "./tui/tui.ts";
import {
  type Block,
  type Card,
  closing,
  document,
  failure,
  indent,
  panel,
  section,
  steps,
  title,
} from "./tui/view.ts";

/**
 * エラーの枠の見出し。**振り分けが決めた道の名前だけで作る**（打った引数そのものは入れない）。
 * 引数の解釈より前に決まるので、フラグの綴りを間違えた失敗でもサブコマンドまで出る。
 */
let heading = "gleanery";

/** 止まったときの塊。本文は字下げされるので、引数に仕込んだ改行で行頭の締めの行を作れない（tui/view.ts）。 */
const failed = (body: string): string => failure(heading, plain(body));

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
    version: "この CLI のバージョンと置き場所",
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

async function withDb<T>(role: Exclude<Role, "owner">, fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const db = role === "reader" ? openReader() : openWriter(role);
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

/**
 * 検索の 1 件を、端末で人が読む項目にする。札は種類ごとの色の Badge、本文は先頭だけ、出所は薄く 2 行で切らずに出す。
 * プロジェクトを 1 つに絞っているときは、見出しに出ているので出所からプロジェクトを外す
 */
function hitCard(x: Hit, scoped: boolean): Card {
  // 文書の節は見出し（path と節）が題になる。判断の記録の heading は作業の題で出所と同じなので、本文の 1 行目を題にする
  const [first = "", ...rest] = plain(x.text).split("\n");
  const doc = x.kind === "document" && x.heading !== null;
  const title = doc ? plain(x.heading ?? "") : first;
  const body = [
    head((doc ? [first, ...rest] : rest).join("\n").trim(), 600),
    x.reason ? `理由: ${plain(x.reason)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    badge: { text: x.label.replace(/^【|】$/g, ""), color: kindColor(x.kind, x.status) },
    title,
    ...(body ? { body } : {}),
    // 1 行目は参照（read に渡す）と日時と話者、2 行目は出所の題（作業・PR・issue）
    meta: [
      [x.ref, x.at.toLocaleString("sv-SE").slice(0, 16), x.speaker, scoped ? null : x.project]
        .filter(Boolean)
        .map((v) => plain(String(v)))
        .join(" · "),
      ...(x.context ? [plain(x.context)] : []),
    ],
  };
}

/** trace の記録を読む。`-` は標準入力（Skill はファイルを作らずに渡す）。 */
const readTrace = (file: string): unknown => JSON.parse(fs.readFileSync(file === "-" ? 0 : file, "utf8"));

const githubRepo = (key: string): string | null =>
  key.match(/^git:github\.com\/([^/]+\/[^/]+)$/)?.[1] ?? null;

/**
 * 1 つのプロジェクトを同期する。**GitHub と文書は互いに独立**なので、片方が落ちてももう片方は回す。
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
        .updateTable("connector")
        .set({ last_error: message.slice(0, 500) })
        .where("project_id", "=", id)
        .where("provider", "=", provider)
        .execute()
        .catch(() => {});
      failures.push(`${place.name} の ${provider}: ${message}`);
    }
  };
  const repo = githubRepo(place.key);
  if (repo) await one("github", "GitHub", () => syncGithub(db, id, repo));
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

async function traceContext(cwd: string, host?: Host): Promise<string> {
  const session = hostSession(host);
  // 待ち行列に残っている分を先に送る。送れなくても続ける（会話は自分の文脈から書ける）。
  await flush().catch(() => {});
  const place = placeOf(cwd);
  return withDb("reader", async (db) => {
    const id = await registered(db, place);
    const conversation = conversationId(id, session.host, session.id);
    const messages = await db
      .selectFrom("message as m")
      .select((eb) => [
        "m.speaker_kind",
        "m.body",
        "m.sent_at",
        "m.truncated",
        jsonArrayFrom(
          eb
            .selectFrom("message_file as f")
            .select("f.path")
            .whereRef("f.message_id", "=", "m.id")
            .orderBy("f.path"),
        ).as("paths"),
      ])
      .where("m.conversation_id", "=", conversation)
      .orderBy("m.sent_at")
      .orderBy("m.seq")
      .execute();
    const mine = await db
      .selectFrom("knowledge")
      .select(["source_key", "kind", "status", "body"])
      .where("conversation_id", "=", conversation)
      .where("kind", "<>", "option")
      .orderBy("occurred_at")
      .orderBy("id")
      .execute();
    const works = await openWork(db, [id], 5);
    const detail =
      works.length === 1 && works[0] ? await workDetail(db, Number(works[0].ref.slice(2))) : null;
    const workKeys = await db
      .selectFrom("work_item")
      .select(["source_key", "title", "status"])
      .where("project_id", "=", id)
      .where("status", "in", ["active", "blocked", "paused"])
      .orderBy("updated_at", "desc")
      .execute();
    const decisions = await db
      .selectFrom("knowledge as k")
      .innerJoin("work_item as w", "w.id", "k.work_item_id")
      .select(["k.source_key", "k.status", "k.body"])
      .where("k.project_id", "=", id)
      .where("k.kind", "=", "decision")
      .where("w.status", "in", ["active", "blocked", "paused"])
      .orderBy("k.occurred_at", "desc")
      .orderBy("k.id", "desc")
      .limit(30)
      .execute();
    // 持ち主の発言は長めに、AI の応答は要点だけ出す（決めたのは持ち主の発言で、AI の応答はその前後）。
    const said = messages.map(
      (m) =>
        `## ${m.speaker_kind === "self" ? "持ち主" : "AI"}（${m.sent_at}）${m.truncated ? " ※一部だけ保存" : ""}\n` +
        `${head(m.body, m.speaker_kind === "self" ? 4000 : 800)}${m.paths.length ? `\nこの発言の後に触ったファイル: ${m.paths.map((p) => p.path).join(" / ")}` : ""}`,
    );
    const edited = [...new Set(messages.flatMap((m) => m.paths.map((p) => p.path)))];
    return [
      `session: ${session.host} ${session.id}（プロジェクト ${place.name}）`,
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

async function doctor(cwd: string): Promise<void> {
  const issues: string[] = [];
  const count = (m: Mark, label: string) => {
    if (m === "warn" || m === "fail") issues.push(label);
    if (m === "fail") process.exitCode = 1;
  };
  const say = (m: Mark, label: string, text: string) => {
    count(m, label);
    console.log(indent(`  ${mark(m)} ${pad(label, 26)}${text}`));
  };
  console.log(title("gleanery doctor"));
  // DB より先に出す。バージョンの食い違いは DB と無関係に見たい。
  const plugin = report(observe(identify(cwd)?.root ?? cwd));
  issues.push(...plugin.issues);
  // 行頭から始まる行は節の見出し、字下げした行はその中身（plugin.ts の report が組む形）
  for (const line of plugin.lines) console.log(/^\S/.test(line) ? section(line) : indent(line));
  if (plugin.updates.length) console.log(steps("更新するには", plugin.updates, UPDATE_NOTE));
  console.log(`\n${section("DB")}`);
  let runtime = true;
  try {
    requireRuntime();
    say("ok", "Node", process.version);
  } catch (e) {
    runtime = false;
    say("fail", "Node", plain(reason(e)));
  }
  const file = dbFile();
  let usable = false;
  if (!runtime) say("none", "DB", "Node を上げるまで確かめられない");
  else if (!fs.existsSync(file)) say("fail", "DB", `無い（${file}）。gleanery db init で作る`);
  else {
    try {
      const x = inspect(file);
      usable = x.revision === SCHEMA_REVISION;
      say("ok", "DB", `${file}（${(x.bytes / 1024 / 1024).toFixed(1)} MB）`);
      say(
        usable ? "ok" : "fail",
        "schema のバージョン",
        usable
          ? `revision ${x.revision}`
          : `revision ${x.revision}、このコードは ${SCHEMA_REVISION}（${x.revision < SCHEMA_REVISION ? "gleanery db migrate で進める" : "gleanery を更新する"}）`,
      );
      const broken = Object.entries(x.fts).filter(([, v]) => v !== null);
      say(
        broken.length ? "fail" : "ok",
        "全文検索の索引",
        broken.length
          ? `壊れている: ${broken.map(([k, v]) => `${k}（${plain(v ?? "")}）`).join(" / ")}。gleanery db reindex で作り直す`
          : "整っている",
      );
    } catch (e) {
      say("fail", "DB", `読めない: ${plain(reason(e))}`);
    }
  }
  const s = readState();
  say(
    s.stuck ? "fail" : s.rejected ? "warn" : "ok",
    "自動記録",
    `待ち ${s.pending} 件${s.flushedAt ? ` / 最後の送信 ${new Date(s.flushedAt).toLocaleString("sv-SE")}` : ""}${
      s.stuck ? ` / 失敗: ${plain(s.stuck)}` : ""
    }${s.unregistered ? ` / 未登録のプロジェクトで退避した ${s.unregistered} 件（${unregisteredDir()}）` : ""}${
      s.rejected ? ` / DB が受け付けなかった ${s.rejected} 件（${rejectedDir()}）` : ""
    }`,
  );
  if (usable) {
    try {
      await withDb("reader", async (db) => {
        const { found } = localRoots();
        const rows = await db
          .selectFrom("project as p")
          .leftJoin("connector as cn", "cn.project_id", "p.id")
          .select(["p.key", "p.name", "cn.provider", "cn.last_success_at", "cn.last_error"])
          .orderBy("p.name")
          .orderBy("cn.provider")
          .execute();
        if (rows.length) console.log(`\n${section("プロジェクト")}`);
        const label = (x: (typeof rows)[number]) => `${x.name} ${x.provider ?? "未同期"}`;
        const column = Math.max(...rows.map((x) => width(label(x)))) + 2;
        for (const x of rows) {
          // 取り込みは gleanery harvest を打ったときだけ走る。間が空くのは運用どおりなので、失敗だけを直すものに数える。
          const m: Mark = x.last_error ? "fail" : x.provider === null || !x.last_success_at ? "none" : "ok";
          count(m, `プロジェクト ${label(x)}`);
          const where = found.get(x.key) ? "" : "（この PC に置き場所が無い）";
          console.log(
            indent(
              `  ${mark(m)} ${pad(label(x), column)}${
                x.last_success_at
                  ? `最後の取り込み ${new Date(x.last_success_at).toLocaleString("sv-SE")}`
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
  // 件数は行の数で数え、名前だけ重ねない（同じ名前の Codex の cache やプロジェクトが複数あっても件数は減らさない）。
  console.log(
    `${closing(
      `${mark(issues.length ? "warn" : "ok")} ${
        issues.length
          ? `直すもの ${issues.length} 件: ${[...new Set(issues)]
              .map((name) => {
                const n = issues.filter((x) => x === name).length;
                return n > 1 ? `${name} ×${n}` : name;
              })
              .join(" / ")}`
          : "直すものは無い"
      }`,
    )}`,
  );
}

/** どのコマンドでも同じ意味の `--cwd`。渡さなければいまのディレクトリ。 */
const CWD = {
  kind: "parsed",
  parse: String,
  brief: "プロジェクトのディレクトリ（既定はいまのディレクトリ）",
  placeholder: "dir",
  optional: true,
} as const;

// MCP は 1〜10 に縛っている。人が読む CLI は 20 まで。負の値や 0 を SQL の limit へ流さない。
function limitOf(input: string): number {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error(`--limit は 1 から 20 の整数にする: ${input}`);
  return n;
}

/** 除外に入れる path と、それが file か directory か。作業ツリーに無い path は打ち間違いとして落とす。 */
function excludeTarget(
  cwd: string,
  target: string,
): { place: Place; kind: "file" | "directory"; rel: string } {
  const place = placeOf(cwd);
  const rel = relativeTo(place.root, target, cwd);
  if (!rel) throw new Error(`${target} は ${place.name}（${place.root}）の中に無い`);
  // symlink は辿らない。commit の tree でも 1 項目で、先が directory でも本文としては読まれない。
  const st = fs.lstatSync(path.join(place.root, rel), { throwIfNoEntry: false });
  if (!st) throw new Error(`${rel} が作業ツリーに無い`);
  return { place, kind: st.isDirectory() ? "directory" : "file", rel };
}

const excludeRoutes = buildRouteMap({
  docs: {
    brief: "文書の同期で取り込まない path",
    fullDescription:
      "追跡された Markdown が全部「事実を述べた文書」とは限らない（監査の fixture、穴埋めのテンプレート）。外したものは次の同期で、節も一緒に消える。",
  },
  routes: {
    add: buildCommand({
      docs: { brief: "取り込まない path を足す（ファイルかディレクトリ）" },
      parameters: {
        flags: { cwd: CWD },
        positional: {
          kind: "tuple",
          parameters: [{ parse: String, brief: "外す path", placeholder: "path" }],
        },
      },
      func: async (flags: { cwd?: string }, target: string) => {
        const { place, kind, rel } = excludeTarget(flags.cwd ?? process.cwd(), target);
        await withDb("ingest", async (db) => {
          const id = await registered(db, place);
          const connector = await connectorOf(db, id, "docs");
          await db
            .insertInto("docs_exclude")
            .values({ connector_id: connector.id, kind, path: rel })
            .onConflict((oc) => oc.doNothing())
            .execute();
          console.log(
            document(
              "gleanery project exclude add",
              place.name,
              [
                {
                  kind: "fields",
                  rows: [
                    ["path", rel],
                    ["種類", kind === "file" ? "ファイル" : "ディレクトリ"],
                  ],
                },
              ],
              `${mark("ok")} 次の同期から取り込まない`,
            ),
          );
        });
      },
    }),
    list: buildCommand({
      docs: { brief: "そのプロジェクトで取り込まない path" },
      parameters: { flags: { cwd: CWD } },
      func: async (flags: { cwd?: string }) => {
        const place = placeOf(flags.cwd ?? process.cwd());
        await withDb("reader", async (db) => {
          const id = await registered(db, place);
          const rows = await db
            .selectFrom("docs_exclude as x")
            .innerJoin("connector as c", (j) =>
              j.onRef("c.id", "=", "x.connector_id").on("c.provider", "=", "docs"),
            )
            .select(["x.kind", "x.path"])
            .where("c.project_id", "=", id)
            .orderBy("x.path")
            .execute();
          console.log(
            document(
              "gleanery project exclude list",
              place.name,
              rows.length
                ? [
                    {
                      kind: "table",
                      head: ["path", "種類"],
                      rows: rows.map((r) => [plain(r.path), r.kind === "file" ? "ファイル" : "ディレクトリ"]),
                    },
                  ]
                : [
                    {
                      kind: "note",
                      tone: "info",
                      text: "取り込まない path は無い（全部の文書を取り込んでいる）",
                    },
                  ],
              rows.length ? `${rows.length} 件` : "除外なし",
            ),
          );
        });
      },
    }),
    remove: buildCommand({
      docs: { brief: "取り込まない path を外す（次の同期で取り込みに戻る）" },
      parameters: {
        flags: { cwd: CWD },
        positional: {
          kind: "tuple",
          parameters: [{ parse: String, brief: "戻す path", placeholder: "path" }],
        },
      },
      func: async (flags: { cwd?: string }, target: string) => {
        const cwd = flags.cwd ?? process.cwd();
        const place = placeOf(cwd);
        // 消すときは作業ツリーを見ない。外した後にその path が消えても、設定だけは消せる。
        const rel = relativeTo(place.root, target, cwd);
        if (!rel) throw new Error(`${target} は ${place.name}（${place.root}）の中に無い`);
        await withDb("ingest", async (db) => {
          const id = await registered(db, place);
          const gone = await db
            .deleteFrom("docs_exclude")
            .where("path", "=", rel)
            .where("connector_id", "in", (eb) =>
              eb
                .selectFrom("connector")
                .select("id")
                .where("project_id", "=", id)
                .where("provider", "=", "docs"),
            )
            .executeTakeFirst();
          console.log(
            document(
              "gleanery project exclude remove",
              place.name,
              [{ kind: "fields", rows: [["path", rel]] }],
              Number(gone.numDeletedRows)
                ? `${mark("ok")} 次の同期から取り込みに戻る`
                : `${mark("none")} 除外に入っていない`,
            ),
          );
        });
      },
    }),
  },
});

const projectRoutes = buildRouteMap({
  docs: { brief: "記録するプロジェクトの登録と、消去" },
  routes: {
    add: buildCommand({
      docs: { brief: "プロジェクトを登録する（remote が無いなら --name でこの PC での名前を付ける）" },
      parameters: {
        flags: {
          cwd: CWD,
          name: {
            kind: "parsed",
            parse: String,
            brief: "remote を持たないプロジェクトに、この PC での名前を付ける",
            placeholder: "名前",
            optional: true,
          },
        },
      },
      func: async (flags: { cwd?: string; name?: string }) => {
        const cwd = flags.cwd ?? process.cwd();
        const place = flags.name ? nameLocal(cwd, flags.name) : placeOf(cwd);
        await withDb("ingest", async (db) => {
          const added = await db
            .insertInto("project")
            .values({ key: place.key, name: place.name })
            .onConflict((oc) => oc.column("key").doNothing())
            .returning("id")
            .executeTakeFirst();
          console.log(
            document(
              "gleanery project add",
              undefined,
              [
                {
                  kind: "fields",
                  rows: [
                    ["プロジェクト", place.name],
                    ["key", place.key],
                    ["置き場所", place.root],
                  ],
                },
              ],
              added ? `${mark("ok")} 登録した` : `${mark("none")} 既に登録済み`,
            ),
          );
        });
      },
    }),
    list: buildCommand({
      docs: { brief: "登録済みのプロジェクトと、最後の同期" },
      parameters: {},
      func: async () => {
        const { found, ambiguous } = localRoots();
        await withDb("reader", async (db) => {
          const listed = await db
            .selectFrom("project as p")
            .leftJoin("connector as cn", "cn.project_id", "p.id")
            .select(["p.key", "p.name", (eb) => eb.fn.max("cn.last_success_at").as("last")])
            .groupBy("p.id")
            .orderBy("p.name")
            .execute();
          const home = os.homedir();
          const cards = listed.map((x) => {
            const root = found.get(x.key);
            const where = root
              ? root.startsWith(`${home}${path.sep}`)
                ? `~${root.slice(home.length)}`
                : root
              : ambiguous.has(x.key)
                ? "置き場所が複数ある（同期しない）"
                : "この PC に無い";
            return {
              title: x.name,
              body: where,
              meta: [
                x.key,
                x.last
                  ? `最後の同期 ${new Date(x.last).toLocaleString("sv-SE").slice(0, 16)}`
                  : "まだ同期していない",
              ],
            };
          });
          console.log(
            document(
              "gleanery project list",
              undefined,
              cards.length
                ? [{ kind: "cards", items: cards }]
                : [
                    {
                      kind: "note",
                      tone: "info",
                      text: "登録したプロジェクトは無い。gleanery project add で登録する",
                    },
                  ],
              cards.length ? `${cards.length} 件` : "登録なし",
            ),
          );
        });
      },
    }),
    exclude: excludeRoutes,
    forget: buildCommand({
      docs: { brief: "プロジェクトのデータを消す（--yes が無ければ数えるだけ）" },
      parameters: {
        flags: { yes: { kind: "boolean", brief: "本当に消す（元に戻せない）", optional: true } },
        positional: {
          kind: "tuple",
          parameters: [{ parse: String, brief: "消すプロジェクトの key か名前", placeholder: "key|名前" }],
        },
      },
      func: async (flags: { yes?: boolean }, target: string) => {
        await withDb("ingest", async (db) => {
          const hit = await db
            .selectFrom("project")
            .select(["id", "key", "name"])
            .where((eb) => eb.or([eb("key", "=", target), eb("name", "=", target)]))
            .execute();
          const p = hit[0];
          if (hit.length !== 1 || !p)
            throw new Error(`${target} に当たるプロジェクトが ${hit.length} 件ある。key で指定する`);
          const x = await db
            .selectFrom("project")
            .select([
              sql<number>`(select count(*) from conversation where project_id = ${p.id})`.as("conversations"),
              sql<number>`(select count(*) from message m
                join conversation c on c.id = m.conversation_id where c.project_id = ${p.id})`.as("messages"),
              sql<number>`(select count(*) from knowledge where project_id = ${p.id})`.as("knowledge"),
              sql<number>`(select count(*) from source_item s
                join connector cn on cn.id = s.connector_id where cn.project_id = ${p.id})`.as("items"),
            ])
            .where("id", "=", p.id)
            .executeTakeFirst();
          const counts: Block = {
            kind: "fields",
            rows: [
              ["プロジェクト", p.name],
              ["key", p.key],
              ["会話", `${x?.conversations} 件`],
              ["発言", `${x?.messages} 件`],
              ["知識", `${x?.knowledge} 件`],
              ["取り込み元の項目", `${x?.items} 件`],
            ],
          };
          if (flags.yes !== true) {
            console.log(
              document(
                "gleanery project forget",
                undefined,
                [counts, { kind: "note", tone: "warning", text: "消すなら --yes を付ける。元に戻せない" }],
                `${mark("none")} 消していない`,
              ),
            );
            return;
          }
          await db.deleteFrom("project").where("id", "=", p.id).execute();
          console.log(document("gleanery project forget", undefined, [counts], `${mark("ok")} 消した`));
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
        console.log(framed(await traceContext(process.cwd(), flags.host)));
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
        await withDb("ingest", async (db) => {
          const id = await registered(db, place);
          const saved = await saveTrace(db, id, trace);
          console.log(
            panel(
              "gleanery trace save",
              [],
              `入れた: 書き直した要素 ${saved.written} 件${saved.superseded ? ` / 覆した決定 ${saved.superseded} 件` : ""}`,
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
        const r = await flush();
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
          document(
            "gleanery capture flush",
            undefined,
            [
              {
                kind: "fields",
                rows: [
                  ["新しく入った発言", `${r.sent} 件`],
                  ...(r.deferred
                    ? ([["未登録のプロジェクトで退避", `${r.deferred} 件`]] as [string, string][])
                    : []),
                  ...(r.rejected
                    ? ([["DB が受け付けなかった", `${r.rejected} 件（${rejectedDir()} に残した）`]] as [
                        string,
                        string,
                      ][])
                    : []),
                ],
              },
            ],
            `${mark(r.rejected ? "warn" : "ok")} 送った`,
          ),
        );
      },
    }),
  },
});

/** admin.ts の 1 行ずつの出力に見出しと締めを付ける。失敗は stricli の exceptionWhileRunningCommand が塊にする */
async function boxed(head: string, fn: () => void | Promise<void>): Promise<void> {
  console.log(title(head));
  await fn();
  console.log(closing(`${mark("ok")} 終わった`));
}

const dbRoutes = buildRouteMap({
  docs: { brief: "この PC の DB（~/.gleanery/gleanery.db）と schema" },
  routes: {
    init: buildCommand({
      docs: { brief: "この PC の DB を作る（あれば触らない。何度流してもよい）" },
      parameters: {},
      func: () => boxed("gleanery db init", () => dbInit()),
    }),
    migrate: buildCommand({
      docs: { brief: "DB のバージョンより新しい db/migrations を当てる" },
      parameters: {
        flags: {
          yes: { kind: "boolean", brief: "当てる前の確認を省く（端末でないときは必須）", optional: true },
        },
      },
      func: (flags: { yes?: boolean }) => boxed("gleanery db migrate", () => migrate(flags.yes === true)),
    }),
    reindex: buildCommand({
      docs: { brief: "全文検索の索引を作り直す（検索の語の切り方を変えた後に打つ）" },
      parameters: {},
      func: () => boxed("gleanery db reindex", () => reindex()),
    }),
  },
});

const root = buildRouteMap({
  docs: {
    brief: "過去の判断・会話・文書を溜めて引く",
    fullDescription: "DB: ~/.gleanery/gleanery.db（gleanery db init で作る）。資格情報は要らない",
  },
  routes: {
    project: projectRoutes,
    harvest: buildCommand({
      docs: {
        brief: "この PC にあるプロジェクトの GitHub と文書を同期する",
        fullDescription:
          "文書は remote の既定 branch から入れ、fast-forward でなければ止まる（--reset-docs はそのプロジェクトを今の状態に揃える）。",
      },
      parameters: {
        flags: {
          cwd: CWD,
          "reset-docs": {
            kind: "boolean",
            brief: "文書をそのプロジェクトの今の状態に揃える（--cwd と一緒にだけ使える）",
            optional: true,
          },
        },
      },
      func: async (flags: { cwd?: string; "reset-docs"?: boolean }) => {
        const resetDocs = flags["reset-docs"] === true;
        // 揃え直しはプロジェクトを 1 つ名指ししたときだけ（全件の同期で、比較不能なプロジェクトをまとめて上書きしない）。
        if (resetDocs && !flags.cwd)
          throw new Error("--reset-docs は --cwd でプロジェクトを 1 つ指定したときだけ使える");
        // ログは追記で残るので、いつ走ったかを見出しに必ず出す。
        const startedAt = new Date();
        console.log(title(`gleanery harvest ${startedAt.toLocaleString("sv-SE")}`));
        await flush().catch((e: unknown) =>
          console.error(indent(`${mark("fail")} 自動記録の送信に失敗: ${plain(reason(e))}`)),
        );
        const failures: string[] = [];
        let done = 0;
        try {
          await withDb("ingest", async (db) => {
            const only = flags.cwd ? placeOf(flags.cwd) : null;
            if (only) await registered(db, only);
            const { found, ambiguous } = localRoots();
            const projects = await db
              .selectFrom("project")
              .select(["id", "key", "name"])
              .orderBy("name")
              .execute();
            for (const p of projects) {
              if (only && only.key !== p.key) continue;
              const root = only?.root ?? found.get(p.key);
              if (!root) {
                console.log(
                  indent(
                    `${mark("none")} ${p.name}: 飛ばした（${ambiguous.has(p.key) ? "この PC に置き場所が複数ある" : "この PC に置き場所が無い"}）`,
                  ),
                );
                continue;
              }
              try {
                const place = { key: p.key, root, name: p.name };
                for (const line of await syncOne(db, p.id, place, resetDocs)) {
                  console.log(indent(`${mark("ok")} ${p.name} / ${line}`));
                }
                done++;
              } catch (e) {
                // 1 つ落ちても残りは回す。失敗は終了コードへ出す（launchd の LastExitStatus で見える）。
                failures.push(p.name);
                const lines = plain(reason(e)).split("\n");
                console.error(
                  indent(
                    [
                      `${mark("fail")} ${p.name}`,
                      ...lines.map((l) => (l.trim() ? `  ${l.trim()}` : "")),
                    ].join("\n"),
                  ),
                );
              }
            }
          });
        } catch (e) {
          // 見出しを出した後で止まっても、枠を閉じてから終わる（ログは日をまたいで追記される）。
          console.error(indent(`${mark("fail")} ${plain(reason(e))}`));
          console.log(closing(`${mark("fail")} 止まった ${new Date().toLocaleString("sv-SE")}`));
          process.exitCode = 1;
          return;
        }
        console.log(
          closing(
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
          all: { kind: "boolean", brief: "すべてのプロジェクトから引く", optional: true },
          exact: {
            kind: "boolean",
            brief: "部分一致で引く（語に切れない固有名・記号・バージョン番号）",
            optional: true,
          },
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
        flags: {
          avoid?: boolean;
          said?: string;
          all?: boolean;
          exact?: boolean;
          cwd?: string;
          limit: number;
        },
        ...words: string[]
      ) => {
        const question = words.join(" ");
        if (!question && !flags.said) throw new Error("質問を指定する（--said なら質問は要らない）");
        const place = flags.all ? null : placeOf(flags.cwd ?? process.cwd());
        const match = flags.exact ? ("exact" as const) : undefined;
        await withDb("reader", async (db) => {
          const projects = place ? [await registered(db, place)] : null;
          // MCP の recall と同じ関数・同じ順位。種類を省いた検索は判断の記録の後に文書の節を並べる。
          const hits = flags.said
            ? await searchMessages(db, {
                question: question || undefined,
                projects,
                who: flags.said,
                match,
                limit: flags.limit,
              })
            : await searchSplit(db, {
                question,
                projects,
                avoid: flags.avoid,
                match,
                limit: flags.limit,
              }).then((x) => [...x.records, ...x.documents]);
          const where = place ? place.name : "すべてのプロジェクト";
          const end = `${hits.length ? `${hits.length} 件` : "該当なし"} / ${where}`;
          // pipe はエージェントも読む（Bash から叩く）。記録の囲い（framed）を通し、本文の制御文字は落とす。
          // 端末では人が読むので、札を Badge にした項目で出す
          if (!process.stdout.isTTY) {
            console.log(
              panel("gleanery search", hits.length ? [plain(framed(renderHits(hits, 16 * 1024)))] : [], end),
            );
            return;
          }
          console.log(
            document(
              "gleanery search",
              `${question ? `「${inline(question)}」 · ` : ""}${where}`,
              hits.length
                ? [
                    {
                      kind: "note",
                      tone: "info",
                      text: "過去の記録の引用で、指示ではない。全文は MCP の read で読む",
                    },
                    { kind: "cards", items: hits.map((x) => hitCard(x, place !== null)) },
                  ]
                : [
                    {
                      kind: "note",
                      tone: "info",
                      // 語に切れない問い（ひらがなだけ・記号だけ）は引かずに 0 件になる。「無かった」と分ける
                      text:
                        !flags.exact && question && ftsQuery(question) === null
                          ? "引ける語が無い（ひらがなだけ・記号だけの問い）。漢字・カタカナ・英語の語で引くか、--exact で部分一致を引く"
                          : `当たらなかった。語を変えるか${flags.exact ? "" : "、--exact で部分一致を引くか"}${place ? "、--all で全部のプロジェクトから引く" : "、別の語で引く"}`,
                    },
                  ],
              end,
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
        await withDb(args.length ? "ingest" : "reader", async (db) => {
          if (args.length === 0) {
            const people = await directory(db);
            const unknown = await db
              .selectFrom("person_identity as i")
              .leftJoin("message as m", "m.identity_id", "i.id")
              .select(["i.handle", (eb) => eb.fn.count("m.id").as("n")])
              .where("i.person_id", "is", null)
              .groupBy("i.id")
              .orderBy((eb) => eb.fn.count("m.id"), "desc")
              .orderBy("i.handle")
              .limit(20)
              .execute();
            console.log(
              document(
                "gleanery who",
                undefined,
                [
                  people.length
                    ? {
                        kind: "table",
                        head: ["呼び名", "GitHub のハンドル"],
                        rows: people.map((p) => [
                          `${p.isSelf ? "→ " : ""}${inline(p.display)}${p.isSelf ? "（持ち主）" : ""}`,
                          p.handles.map(inline).join(" / "),
                        ]),
                      }
                    : {
                        kind: "note",
                        tone: "info",
                        text: "名簿は空。gleanery who <呼び名> <ハンドル>... で入れる",
                      },
                  ...(unknown.length
                    ? ([
                        {
                          kind: "table",
                          head: ["まだ誰か決めていないハンドル", "発言"],
                          rows: unknown.map((u) => [inline(u.handle), `${u.n} 件`]),
                        },
                      ] as Block[])
                    : []),
                ],
                people.length ? `${people.length} 人` : "名簿は空",
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
              await trx.updateTable("person").set({ is_self: 0 }).where("is_self", "=", 1).execute();
            const pe = await trx
              .insertInto("person")
              .values({ display_name: display, is_self: flags.me === true ? 1 : 0 })
              .onConflict((oc) =>
                oc
                  .column("display_name")
                  .doUpdateSet({ is_self: sql<number>`max(person.is_self, excluded.is_self)` }),
              )
              .returning("id")
              .executeTakeFirst();
            return await trx
              .updateTable("person_identity")
              .set({ person_id: pe?.id ?? null })
              .where("provider", "=", "github")
              .where(
                (eb) => eb.fn("lower", ["handle"]),
                "in",
                handles.map((h) => h.replace(/^@/, "").toLowerCase()),
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
      docs: { brief: "要件定義と設計書の置き場所 .gleanery/ をリポジトリのルートに作る" },
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
      docs: { brief: "セッション・作業・検索を端末の画面で見る（読むだけ）" },
      parameters: {},
      func: () => runTui(process.cwd()),
    }),
    doctor: buildCommand({
      docs: { brief: "npm packageとpluginのバージョン、Node、DB と schema、同期と自動記録の状態" },
      parameters: {},
      func: () => doctor(process.cwd()),
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
        const ratio = shown.length / Math.max(rows.length, 1);
        console.log(
          document(
            "gleanery advice",
            since ? `${new Date(since).toLocaleString("sv-SE").slice(0, 16)} から` : undefined,
            [
              {
                kind: "fields",
                rows: [
                  ["フックが走った編集", `${rows.length} 回`],
                  ["制約を出した", `${shown.length} 回`],
                  ...(since
                    ? ([["記録の始まり", new Date(since).toLocaleString("sv-SE")]] as [string, string][])
                    : []),
                ],
              },
              { kind: "meter", label: "制約を出した割合", ratio, text: `${(ratio * 100).toFixed(1)}%` },
            ],
            `${mark("ok")} 編集 ${rows.length} 回のうち ${shown.length} 回で制約を出した`,
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
