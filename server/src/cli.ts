#!/usr/bin/env node
// mitos の CLI。取り込み・trace・名簿の書き込みは ingest の鍵、検索は reader の鍵で繋ぐ。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type pg from "pg";
import { check, init } from "./artifacts.ts";
import { flush, readState } from "./capture.ts";
import { checkSchema, connect, type Env, inTransaction, KEY, loadEnv, type Role } from "./db.ts";
import { syncDocs } from "./docs.ts";
import { describeFill, fillKnowledge, fillMessages } from "./embeddings.ts";
import { syncGithub } from "./github.ts";
import { conversationId } from "./knowledge.ts";
import { observe, ROOT, report, versionAt } from "./plugin.ts";
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
import { head } from "./text.ts";
import { checkTrace, saveTrace } from "./trace.ts";

const USAGE = `使い方:
  mitos project add [--cwd <dir>] [--name <名前>]  作業場所を登録する（remote が無いなら --name でこの PC での名前を付ける）
  mitos project list                               登録済みの作業場所と、最後の同期
  mitos project forget <key|名前> [--yes]          作業場所のデータを消す（--yes が無ければ数えるだけ）
  mitos sync [--cwd <dir>]                         この PC にある作業場所の GitHub と文書を同期する（日次用）
  mitos search <質問> [--avoid] [--said me|others|<名前>] [--all] [--cwd <dir>] [--limit N]
                                                   引けるかを確かめる（--said は発言を探す）
  mitos who [<呼び名> <ハンドル>... [--me]]         GitHub のハンドルと人を結ぶ（--me は持ち主）
  mitos trace context [--host claude-code|codex]   いまの session の会話と、進行中の作業を出す（trace の材料）
  mitos trace check <trace.json>                   trace の記録の形を確かめる（DB に触らない）
  mitos trace save <trace.json>                    trace の記録を入れる
  mitos capture flush                              自動記録の待ち行列を DB へ送る
  mitos init [--cwd <dir>]                         要件定義と設計書の置き場所 .mitos/ をリポジトリの根に作る
  mitos check [--cwd <dir>]                        .mitos/ の change.json を検査する（DB に触らない）
  mitos doctor                                     plugin の版、鍵と接続、schema、同期と自動記録の状態
  mitos advice                                     編集フックが制約を出した割合
  mitos --version                                  この CLI の版と置き場所

資格情報: ~/.claude/knowledge.env（KNOWLEDGE_DB_URL_RO / _INGEST / _CAPTURE と VOYAGE_API_KEY）`;

// 引数の解釈を自前で書かない。手書きのループは知らないフラグと `--name=値` を黙って捨てる。
const OPTIONS = {
  cwd: { type: "string" },
  host: { type: "string" },
  name: { type: "string" },
  limit: { type: "string" },
  all: { type: "boolean" },
  avoid: { type: "boolean" },
  said: { type: "string" },
  me: { type: "boolean" },
  yes: { type: "boolean" },
} as const;

async function withDb<T>(env: Env, role: Role, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = await connect(env, role);
  try {
    await checkSchema(c);
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

function placeOf(cwd: string): Place {
  const place = identify(cwd);
  if (!place) {
    throw new Error(
      `${cwd} は git の remote を持たず、名前も付いていない。\`mitos project add --name <名前>\` で名前を付ける`,
    );
  }
  return place;
}

async function registered(c: pg.Client, place: Place): Promise<number> {
  const id = await projectId(c, place.key);
  if (id === null)
    throw new Error(`${place.name} は mitos に登録されていない。\`mitos project add\` で登録する`);
  return id;
}

const githubRepo = (key: string): string | null =>
  key.match(/^git:github\.com\/([^/]+\/[^/]+)$/)?.[1] ?? null;

/**
 * 1 つの作業場所を同期する。**GitHub と文書は互いに独立**なので、片方が落ちてももう片方は回す。
 * 失敗は取り込み元の last_error に残し（doctor と画面が出す）、最後にまとめて投げる。
 */
async function syncOne(c: pg.Client, id: number, place: Place): Promise<string[]> {
  const out: string[] = [];
  const failed: string[] = [];
  const run = async (provider: "github" | "docs", label: string, fn: () => Promise<string>) => {
    try {
      out.push(`${label}: ${await fn()}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await c
        .query("update mitos.connector set last_error = $3 where project_id = $1 and provider = $2", [
          id,
          provider,
          message.slice(0, 500),
        ])
        .catch(() => {});
      failed.push(`${place.name} の ${provider}: ${message}`);
    }
  };
  const repo = githubRepo(place.key);
  if (repo) await run("github", "GitHub", () => syncGithub(c, id, place.name, repo));
  if (fs.existsSync(path.join(place.root, ".git")))
    await run("docs", "文書", () => syncDocs(c, id, place.root));
  if (failed.length) throw new Error([...out, ...failed].join("\n  "));
  return out;
}

type Host = "claude-code" | "codex";
const SESSION_ENV: Record<Host, string[]> = {
  "claude-code": ["CLAUDE_CODE_SESSION_ID"],
  codex: ["CODEX_THREAD_ID", "CODEX_SESSION_ID"],
};

/**
 * いまの session。**両方のホストの id が環境にあれば決めない**（Claude Code の Bash から起動した Codex は
 * CLAUDE_CODE_SESSION_ID を継ぐ。先に見つかった方を使うと、別のホストの session を読んで書く）。
 */
function hostSession(host?: string): { host: Host; id: string } {
  if (host !== undefined && !(host in SESSION_ENV))
    throw new Error(`--host は claude-code か codex: ${host}`);
  const found = (Object.keys(SESSION_ENV) as Host[]).flatMap((h) => {
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
      ? `${host} の session の id が環境に無い（${SESSION_ENV[host as Host].join(" / ")}）`
      : "いまの session の id が分からない（Claude Code か Codex の中で実行する）",
  );
}

async function traceContext(env: Env, cwd: string, host?: string): Promise<string> {
  const session = hostSession(host);
  // 待ち行列に残っている分を先に送る。送れなくても続ける（会話は自分の文脈から書ける）。
  await flush(env).catch(() => {});
  const place = placeOf(cwd);
  return withDb(env, "reader", async (c) => {
    const id = await registered(c, place);
    const conversation = conversationId(id, session.host, session.id);
    const messages = await c.query<{
      speaker_kind: string;
      body: string;
      sent_at: Date;
      truncated: boolean;
      paths: string[];
    }>(
      `select m.speaker_kind, m.body, m.sent_at, m.truncated,
              array(select f.path from mitos.message_file f where f.message_id = m.id order by f.path) as paths
       from mitos.message m where m.conversation_id = $1 order by m.sent_at`,
      [conversation],
    );
    const mine = await c.query<{ source_key: string; kind: string; status: string | null; body: string }>(
      `select source_key, kind, status, body from mitos.knowledge
       where conversation_id = $1 and kind <> 'option' order by occurred_at`,
      [conversation],
    );
    const works = await openWork(c, [id], 5);
    const detail = works.length === 1 && works[0] ? await workDetail(c, works[0].ref.slice(2)) : null;
    const workKeys = await c.query<{ source_key: string; title: string; status: string }>(
      "select source_key, title, status from mitos.work_item where project_id = $1 and status in ('active', 'blocked', 'paused')",
      [id],
    );
    const decisions = await c.query<{ source_key: string; status: string; body: string }>(
      `select k.source_key, k.status, k.body from mitos.knowledge k
       join mitos.work_item w on w.id = k.work_item_id
       where k.project_id = $1 and k.kind = 'decision' and w.status in ('active', 'blocked', 'paused')
       order by k.occurred_at desc limit 30`,
      [id],
    );
    // 持ち主の発言は長めに、AI の応答は要点だけ出す（決めたのは持ち主の発言で、AI の応答はその前後）。
    const said = messages.rows.map(
      (m) =>
        `## ${m.speaker_kind === "self" ? "持ち主" : "AI"}（${m.sent_at.toISOString()}）${m.truncated ? " ※一部だけ保存" : ""}\n` +
        `${head(m.body, m.speaker_kind === "self" ? 4000 : 800)}${m.paths.length ? `\nこの turn で触ったファイル: ${m.paths.join(" / ")}` : ""}`,
    );
    const edited = [...new Set(messages.rows.flatMap((m) => m.paths))];
    return [
      `session: ${session.host} ${session.id}（作業場所 ${place.name}）`,
      messages.rows.length
        ? `\n# この session の会話（自動記録）\n\n${said.join("\n\n")}`
        : "\n# この session の会話\n\nまだ記録されていない。自分の文脈から書く。",
      edited.length ? `\n# この session で触ったファイル\n\n${edited.map((p) => `- ${p}`).join("\n")}` : null,
      mine.rows.length
        ? `\n# この session で既に記録した要素（同じ key で書くと上書き）\n\n${mine.rows.map((k) => `- ${k.source_key.split("#")[1]}（${k.kind}${k.status ? ` / ${k.status}` : ""}）${head(k.body, 200)}`).join("\n")}`
        : null,
      workKeys.rows.length
        ? `\n# 進行中の作業（work.key に同じ key を書くと更新）\n\n${workKeys.rows.map((w) => `- ${w.source_key}: ${w.title}（${w.status}）`).join("\n")}`
        : "\n# 進行中の作業\n\n無い。",
      detail ? `\n${renderWork(detail, 6000)}` : null,
      decisions.rows.length
        ? `\n# 進行中の作業の決定（覆すなら supersedes にこの key を書く）\n\n${decisions.rows.map((d) => `- ${d.source_key}（${d.status}）${head(d.body, 200)}`).join("\n")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
  });
}

async function doctor(env: Env, cwd: string): Promise<void> {
  // DB より先に出す。版の食い違いは DB と無関係に見たい。
  for (const line of report(observe(identify(cwd)?.root ?? cwd))) console.log(line);
  console.log("");
  // owner の鍵は schema の適用にしか使わないので、ここでは繋がない（DDL の鍵を使う場面を増やさない）。
  for (const role of ["reader", "ingest", "capture"] as const) {
    if (!env[KEY[role]]) {
      console.log(`${KEY[role].padEnd(26)} 無い`);
      continue;
    }
    try {
      await withDb(env, role, async (c) => {
        await c.query(
          role === "capture"
            ? "select id from mitos.project limit 1"
            : "select 1 from mitos.knowledge limit 1",
        );
      });
      console.log(`${KEY[role].padEnd(26)} 繋がる / schema は期待どおり`);
    } catch (e) {
      console.log(`${KEY[role].padEnd(26)} 繋がらない: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(
    `VOYAGE_API_KEY             ${env.VOYAGE_API_KEY ? "あり" : "無い（検索と取り込みの埋め込みが止まる）"}`,
  );
  const s = readState();
  console.log(
    `自動記録                   待ち ${s.pending} 件${s.flushedAt ? ` / 最後の送信 ${new Date(s.flushedAt).toLocaleString("sv-SE")}` : ""}${
      s.error ? ` / 失敗: ${s.error}` : ""
    }${s.dropped ? ` / 未登録の作業場所で捨てた ${s.dropped} 件` : ""}${
      s.rejected ? ` / DB が受け付けなかった ${s.rejected} 件（~/.claude/mitos-spool/rejected）` : ""
    }`,
  );
  if (!env[KEY.reader]) return;
  await withDb(env, "reader", async (c) => {
    // Neon は branch の論理サイズを neon.max_cluster_size で切り、超えると書き込みが止まる。
    const cap = await c.query<{ used: string; bytes: string; cap_mb: string | null }>(
      `select pg_size_pretty(pg_database_size(current_database())) as used, pg_database_size(current_database())::text as bytes,
              (select setting from pg_settings where name = 'neon.max_cluster_size') as cap_mb`,
    );
    const g = cap.rows[0];
    if (g) {
      const capMb = g.cap_mb ? Number(g.cap_mb) : null;
      const pct = capMb ? Math.round((Number(g.bytes) / (capMb * 1024 * 1024)) * 100) : null;
      console.log(
        `DB の大きさ                ${g.used}${capMb ? ` / ${capMb} MB（${pct}%）${pct !== null && pct >= 80 ? " ← 超えると書き込みが止まる" : ""}` : ""}`,
      );
    }
    const emb = await c.query<{ t: string; status: string; n: string }>(
      `select 'knowledge' as t, status, count(*) as n from mitos.knowledge_embedding where status <> 'ready' group by status
       union all select 'message', status, count(*) from mitos.message_embedding where status <> 'ready' group by status`,
    );
    console.log(
      `埋め込みの残り             ${emb.rows.length ? emb.rows.map((r) => `${r.t} ${r.status} ${r.n}`).join(" / ") : "無い"}`,
    );
    const { found } = localRoots();
    const r = await c.query<{
      key: string;
      name: string;
      provider: string | null;
      last_success_at: Date | null;
      last_error: string | null;
    }>(
      `select p.key, p.name, cn.provider, cn.last_success_at, cn.last_error
       from mitos.project p left join mitos.connector cn on cn.project_id = p.id order by p.name, cn.provider`,
    );
    for (const x of r.rows) {
      const days = x.last_success_at
        ? Math.floor((Date.now() - x.last_success_at.getTime()) / 86_400_000)
        : null;
      const where = found.get(x.key) ? "" : "（この PC に置き場所が無い）";
      console.log(
        `${`作業場所 ${x.name}`.padEnd(26)} ${x.provider ?? "未同期"}${
          x.last_success_at
            ? ` / ${x.last_success_at.toLocaleString("sv-SE")}（${days} 日前）${days !== null && days >= 2 ? " ← 日次同期が止まっているかもしれない" : ""}`
            : ""
        }${x.last_error ? ` / 失敗: ${x.last_error}` : ""}${where}`,
      );
    }
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }
  if (cmd === "--version") {
    console.log(`${versionAt(ROOT) ?? "不明"}  ${ROOT}`);
    return;
  }
  const KNOWN = ["project", "sync", "search", "who", "trace", "capture", "init", "check", "doctor", "advice"];
  if (!KNOWN.includes(cmd)) throw new Error(`知らないコマンド: ${cmd}\n\n${USAGE}`);
  const { values: opt, positionals: rest } = parseArgs({
    args: argv.slice(1),
    options: OPTIONS,
    allowPositionals: true,
  });
  const cwd = opt.cwd ?? process.cwd();
  // MCP は 1〜10 に縛っている。CLI だけ穴を開けると、負の値が Voyage の top_k へそのまま流れる。
  const limit = Number(opt.limit ?? 5);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error(`--limit は 1 から 20 の整数にする: ${opt.limit}`);

  // 資格情報に触らないもの。
  if (cmd === "init" || cmd === "check") {
    // 共通の OPTIONS は他のコマンド用の flag も通すので、`--cwd` だけで解釈し直す（位置引数も拒否する）。
    parseArgs({ args: argv.slice(1), options: { cwd: OPTIONS.cwd } });
    if (cmd === "init") {
      const r = init(cwd);
      console.log(r.created ? `.mitos を作った: ${r.root}` : `.mitos は既に初期化済み: ${r.root}`);
      return;
    }
    const r = check(cwd);
    for (const p of r.problems) console.error(`  ${p.path}: ${p.reason}`);
    if (r.problems.length) {
      process.exitCode = 1;
      console.error(`.mitos の検査で ${r.problems.length} 件の問題: ${r.root}`);
      return;
    }
    console.log(`.mitos の検査は通った: ${r.root}（change ${r.changes} 件）`);
    return;
  }
  if (cmd === "trace" && rest[0] === "check") {
    const file = rest[1];
    if (!file) throw new Error(`確かめる記録のファイルを指定する\n\n${USAGE}`);
    const r = checkTrace(JSON.parse(fs.readFileSync(file, "utf8")));
    if (r.problems.length) {
      for (const p of r.problems) console.error(`  ${p}`);
      process.exitCode = 1;
      return;
    }
    console.log(`形は通った: 要素 ${r.trace?.items.length ?? 0} 件`);
    return;
  }
  if (cmd === "advice") {
    // 編集フックが役に立っているかを測る。1 か月見て、出した割合が低ければフックごと消す。
    const log = path.join(os.homedir(), ".claude", "mitos-advice.jsonl");
    if (!fs.existsSync(log)) {
      console.log("まだ記録が無い（編集フックが一度も走っていない）。");
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
    console.log(`フックが走った編集   ${rows.length} 回`);
    console.log(
      `制約を出した         ${shown.length} 回（${((shown.length / Math.max(rows.length, 1)) * 100).toFixed(1)}%）`,
    );
    const since = rows[0]?.at;
    if (since) console.log(`記録の始まり         ${new Date(since).toLocaleString("sv-SE")}`);
    return;
  }

  const env = loadEnv();
  if (cmd === "doctor") return doctor(env, cwd);
  if (cmd === "capture") {
    if (rest[0] !== "flush") throw new Error(`mitos capture flush だけがある\n\n${USAGE}`);
    const r = await flush(env);
    if (r.busy) {
      console.log("別の送信が走っているので何もしなかった（終われば待ち行列は空になる）");
      return;
    }
    console.log(
      `新しく入った発言 ${r.sent} 件${r.dropped ? ` / 未登録の作業場所で捨てた ${r.dropped} 件` : ""}${
        r.rejected
          ? ` / DB が受け付けなかった ${r.rejected} 件（~/.claude/mitos-spool/rejected に残した）`
          : ""
      }`,
    );
    return;
  }
  if (cmd === "trace") {
    if (rest[0] === "context") {
      console.log(framed(await traceContext(env, cwd, opt.host)));
      return;
    }
    if (rest[0] !== "save" || !rest[1])
      throw new Error(`mitos trace context / check <file> / save <file>\n\n${USAGE}`);
    const r = checkTrace(JSON.parse(fs.readFileSync(rest[1], "utf8")));
    if (!r.trace) throw new Error(`記録の形が通らない:\n${r.problems.map((p) => `  ${p}`).join("\n")}`);
    const trace = r.trace;
    // 書けるのはいまの session の記録だけ。ファイルの session を信じると、別の session の決定や制約を上書きできる。
    const now = hostSession(trace.session.host);
    if (now.id !== trace.session.id)
      throw new Error(
        `記録の session（${trace.session.id}）が、いまの ${now.host} の session（${now.id}）と違う。trace context が出した session を書く`,
      );
    const place = placeOf(cwd);
    await withDb(env, "ingest", async (c) => {
      const id = await registered(c, place);
      const saved = await saveTrace(c, env, id, trace);
      console.log(
        [
          `入れた: 書き直した要素 ${saved.written} 件${saved.superseded ? ` / 覆した決定 ${saved.superseded} 件` : ""}`,
          describeFill("埋め込み", saved.embedding),
        ]
          .filter(Boolean)
          .join(" / "),
      );
    });
    return;
  }

  if (cmd === "project") {
    const sub = rest[0];
    if (sub === "add") {
      const place = opt.name ? nameLocal(cwd, opt.name) : placeOf(cwd);
      await withDb(env, "ingest", async (c) => {
        const r = await c.query<{ id: string }>(
          "insert into mitos.project (key, name) values ($1, $2) on conflict (key) do nothing returning id",
          [place.key, place.name],
        );
        console.log(
          r.rows.length
            ? `登録した: ${place.name}（${place.key}）`
            : `既に登録済み: ${place.name}（${place.key}）`,
        );
      });
      return;
    }
    if (sub === "list") {
      const { found, ambiguous } = localRoots();
      await withDb(env, "reader", async (c) => {
        const r = await c.query<{ key: string; name: string; last: Date | null }>(
          `select p.key, p.name, max(cn.last_success_at) as last from mitos.project p
           left join mitos.connector cn on cn.project_id = p.id group by p.id order by p.name`,
        );
        if (r.rows.length === 0) console.log("登録なし。`mitos project add` で登録する");
        for (const x of r.rows) {
          const where =
            found.get(x.key) ??
            (ambiguous.has(x.key) ? "置き場所が複数ある（同期しない）" : "この PC に無い");
          console.log(
            `${x.name}  ${x.key}\n  ${where}${x.last ? ` / 最後の同期 ${x.last.toLocaleString("sv-SE")}` : ""}`,
          );
        }
      });
      return;
    }
    if (sub === "forget") {
      const target = rest[1];
      if (!target) throw new Error(`消す作業場所を key か名前で指定する\n\n${USAGE}`);
      await withDb(env, "ingest", async (c) => {
        const hit = await c.query<{ id: string; key: string; name: string }>(
          "select id, key, name from mitos.project where key = $1 or name = $1",
          [target],
        );
        if (hit.rows.length !== 1)
          throw new Error(`${target} に当たる作業場所が ${hit.rows.length} 件ある。key で指定する`);
        const p = hit.rows[0] as { id: string; key: string; name: string };
        const n = await c.query<{
          conversations: string;
          messages: string;
          knowledge: string;
          items: string;
        }>(
          `select (select count(*) from mitos.conversation where project_id = $1) as conversations,
                  (select count(*) from mitos.message m join mitos.conversation c on c.id = m.conversation_id where c.project_id = $1) as messages,
                  (select count(*) from mitos.knowledge where project_id = $1) as knowledge,
                  (select count(*) from mitos.source_item s join mitos.connector cn on cn.id = s.connector_id where cn.project_id = $1) as items`,
          [p.id],
        );
        const x = n.rows[0];
        console.log(
          `${p.name}（${p.key}）: 会話 ${x?.conversations} / 発言 ${x?.messages} / 知識 ${x?.knowledge} / 取り込み元の項目 ${x?.items}`,
        );
        if (opt.yes !== true) {
          console.log("消していない。消すなら --yes を付ける。**元に戻せない。**");
          return;
        }
        await c.query("delete from mitos.project where id = $1", [p.id]);
        console.log("消した。");
      });
      return;
    }
    throw new Error(`mitos project add / list / forget\n\n${USAGE}`);
  }

  if (cmd === "sync") {
    // launchd は標準出力を上書きするので、いつ走ったかを必ず残す。
    const startedAt = new Date();
    console.log(`==== 同期開始 ${startedAt.toLocaleString("sv-SE")} ====`);
    await flush(env).catch((e: unknown) =>
      console.error(`  自動記録の送信に失敗: ${e instanceof Error ? e.message : e}`),
    );
    const failed: string[] = [];
    let done = 0;
    await withDb(env, "ingest", async (c) => {
      const only = opt.cwd ? placeOf(cwd) : null;
      if (only) await registered(c, only);
      const { found, ambiguous } = localRoots();
      const projects = await c.query<{ id: string; key: string; name: string }>(
        "select id, key, name from mitos.project order by name",
      );
      for (const p of projects.rows) {
        if (only && only.key !== p.key) continue;
        const root = only?.root ?? found.get(p.key);
        if (!root) {
          console.log(
            `飛ばした: ${p.name}（${ambiguous.has(p.key) ? "この PC に置き場所が複数ある" : "この PC に置き場所が無い"}）`,
          );
          continue;
        }
        try {
          for (const line of await syncOne(c, Number(p.id), { key: p.key, root, name: p.name })) {
            console.log(`${p.name} / ${line}`);
          }
          done++;
        } catch (e) {
          // 1 つ落ちても残りは回す。失敗は終了コードへ出す（launchd の LastExitStatus で見える）。
          failed.push(p.name);
          console.error(`  ${e instanceof Error ? e.message : e}`);
        }
      }
      // 埋め込みは全部の作業場所を書き終えてから 1 回だけ埋める（自動記録と前回までの取り残しを含む）。
      for (const line of [
        describeFill("知識の埋め込み", await fillKnowledge(c, env)),
        describeFill("発言の埋め込み", await fillMessages(c, env)),
      ])
        if (line) console.log(line);
    });
    console.log(
      `==== 同期おわり ${new Date().toLocaleString("sv-SE")} / ${Math.round((Date.now() - startedAt.getTime()) / 1000)} 秒 / 成功 ${done} ====`,
    );
    if (failed.length) {
      console.error(`失敗: ${failed.join(" / ")}`);
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "search") {
    const question = rest.join(" ");
    if (!question && !opt.said) throw new Error(`質問を指定する\n\n${USAGE}`);
    const place = opt.all ? null : placeOf(cwd);
    await withDb(env, "reader", async (c) => {
      const projects = place ? [await registered(c, place)] : null;
      const hits = opt.said
        ? await searchMessages(c, env, { question: question || undefined, projects, who: opt.said, limit })
        : await searchKnowledge(c, env, { question, projects, avoid: opt.avoid, limit });
      // この出力は Skill の許可済みコマンド経由でエージェントの文脈へ入る。枠を通す。
      console.log(hits.length ? framed(renderHits(hits, 16 * 1024)) : "該当なし。");
    });
    return;
  }

  if (cmd === "who") {
    await withDb(env, rest.length ? "ingest" : "reader", async (c) => {
      if (rest.length === 0) {
        const people = await directory(c);
        if (people.length === 0) console.log("名簿は空。`mitos who <呼び名> <ハンドル>...` で入れる");
        for (const p of people)
          console.log(`${p.isSelf ? "→ " : "  "}${p.display.padEnd(12)} ${p.handles.join(" / ")}`);
        const unknown = await c.query<{ handle: string; n: string }>(
          `select i.handle, count(m.id) as n from mitos.person_identity i
           left join mitos.message m on m.identity_id = i.id
           where i.person_id is null group by i.id order by count(m.id) desc limit 20`,
        );
        if (unknown.rows.length) {
          console.log("\nまだ誰か決めていないハンドル（発言の多い順）:");
          for (const u of unknown.rows) console.log(`  ${u.n.padStart(5)} 件  ${u.handle}`);
        }
        return;
      }
      const [display, ...handles] = rest;
      if (!display || handles.length === 0)
        throw new Error(`呼び名と、GitHub のハンドルを 1 つ以上指定する\n\n${USAGE}`);
      // 持ち主の付け替えは 1 つの transaction で。途中で落ちると持ち主が 0 人になる。
      const linked = await inTransaction(c, async () => {
        if (opt.me) await c.query("update mitos.person set is_self = false where is_self");
        const pe = await c.query<{ id: string }>(
          `insert into mitos.person (display_name, is_self) values ($1, $2)
           on conflict (display_name) do update set is_self = mitos.person.is_self or excluded.is_self returning id`,
          [display, opt.me === true],
        );
        return c.query<{ handle: string }>(
          `update mitos.person_identity set person_id = $1
           where provider = 'github' and lower(handle) = any($2) returning handle`,
          [pe.rows[0]?.id, handles.map((h) => h.replace(/^@/, "").toLowerCase())],
        );
      });
      const missing = handles.filter(
        (h) => !linked.rows.some((l) => l.handle.toLowerCase() === h.replace(/^@/, "").toLowerCase()),
      );
      console.log(
        `名簿に入れた: ${display}${opt.me ? "（持ち主）" : ""} = ${linked.rows.map((l) => l.handle).join(" / ") || "（結べたハンドルなし）"}`,
      );
      if (missing.length)
        console.log(`まだ取り込んでいないハンドル: ${missing.join(" / ")}（同期の後にもう一度結ぶ）`);
    });
    return;
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
