#!/usr/bin/env node
// 会話の自動記録。フックから呼ばれ、持ち主の発言と AI の最後の応答と、その turn で触ったファイルを残す。
//
// **フックは手元の待ち行列へ書くだけにする。**網へは Stop のときにまとめて送る（async のフックなので待たせない）。
// DB に届かない間も待ち行列に残り、次の送信で冪等に送り直す（id は決定的に作る）。
//
// **持ち主が打っていない prompt を持ち主の発言として残さない。**先行事例では、別の agent 向けの prompt が
// 「利用者の発言」として DB の 97.2% を占めた。見分けは 2 つだけで、どちらも推測をしない。
//   - subagent の中の turn は hook 入力に agent_id が付く
//   - エージェントが起動した子（Bash から叩いた claude -p、codex exec、codex-talk）は、親の SessionStart が
//     CLAUDE_ENV_FILE に書いた MITOS_PARENT_SESSION を継ぐ。自分の session id と違えば子である。
//     mitos 自身が起動する headless は MITOS_PARENT_SESSION=none を明示する
// 値を「その session の id」にしてあるのは、この変数が将来 hook 自身の環境へ届く仕様になっても、
// 持ち主の session では自分の id と一致して記録が止まらないようにするため。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ARTIFACT_PATH } from "./artifacts.ts";
import { connect, EMBED_MODEL, type Env, embed, inTransaction, loadEnv, vec } from "./db.ts";
import { conversationId, indexesMessage, messageText } from "./knowledge.ts";
import { identify, patchPaths, relativeTo } from "./project.ts";
import { bytes, clean, head, sha256, tail, tsvector, uuidFrom } from "./text.ts";

// 置き場所は呼び出しのたびに決める（HOME を差し替えたテストが本物の待ち行列を触らない）。
export const spoolDir = (): string => path.join(os.homedir(), ".claude", "mitos-spool");
const stateFile = (): string => path.join(os.homedir(), ".claude", "mitos-capture.json");

type Host = "claude-code" | "codex";

export type Spooled =
  | {
      v: 1;
      kind: "message";
      host: Host;
      session: string;
      project: string;
      branch: string | null;
      turn: string;
      /** 会話の中で一意 */
      id: string;
      speaker: "self" | "assistant";
      body: string;
      truncated: boolean;
      originalBytes: number;
      at: string;
    }
  | {
      v: 1;
      kind: "file";
      host: Host;
      session: string;
      project: string;
      branch: string | null;
      turn: string;
      path: string;
      action: "edit" | "read";
      at: string;
    };

/** 1 発言の上限。超えたら冒頭と末尾だけを残す（間違って貼った巨大なログで DB と埋め込みを埋めない）。 */
export const MAX_MESSAGE = 128 * 1024;
const KEEP = 8 * 1024;

export function fit(body: string): { body: string; truncated: boolean; originalBytes: number } {
  const all = bytes(body);
  if (all <= MAX_MESSAGE) return { body, truncated: false, originalBytes: all };
  const a = head(body, KEEP);
  const z = tail(body, KEEP);
  const cut = all - bytes(a) - bytes(z);
  return {
    body: `${a}\n\n[中央 ${cut.toLocaleString("en-US")} bytes を保存していない]\n\n${z}`,
    truncated: true,
    originalBytes: all,
  };
}

// 貼ってしまった鍵を DB と待ち行列へ入れない。形の決まった鍵だけを伏せる（推測で文を消さない）。
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "秘密鍵"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g, "API キー"],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g, "API キー"],
  [/\bpa-[A-Za-z0-9_-]{20,}/g, "API キー"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "GitHub トークン"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, "GitHub トークン"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "Slack トークン"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AWS のキー"],
];
export function mask(text: string): string {
  let out = text;
  for (const [re, what] of SECRETS) out = out.replace(re, `[伏せた: ${what}]`);
  // 接続文字列はパスワードだけを伏せる（どこへ繋いだかは話の中身として残す）。
  return out.replace(
    /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/@]+:)[^@\s]+@/g,
    "$1[伏せた]@",
  );
}

function spool(record: Spooled): void {
  const dir = spoolDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}.json`;
  const tmp = path.join(dir, `.${name}`);
  // 書きかけのファイルを送らないよう、別名で書いてから置き換える。
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, name));
}

/** いまの branch。git を起動せずに HEAD を読む（worktree では .git がファイルで、実体の場所を指す）。 */
const branchOf = (root: string): string | null => {
  try {
    const dotgit = path.join(root, ".git");
    const gitdir = fs.statSync(dotgit).isFile()
      ? path.resolve(
          root,
          fs
            .readFileSync(dotgit, "utf8")
            .match(/^gitdir: (.+)$/m)?.[1]
            ?.trim() ?? "",
        )
      : dotgit;
    const h = fs.readFileSync(path.join(gitdir, "HEAD"), "utf8").trim();
    return h.startsWith("ref: refs/heads/") ? h.slice("ref: refs/heads/".length) : null;
  } catch {
    return null;
  }
};

type HookInput = {
  hook_event_name?: string;
  session_id?: string;
  prompt_id?: string;
  turn_id?: string;
  agent_id?: string;
  cwd?: string;
  prompt?: string;
  last_assistant_message?: string | null;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
};

/** 持ち主の turn か。subagent と、エージェントが起動した子を外す。 */
export function isOwnerTurn(input: HookInput, parent = process.env.MITOS_PARENT_SESSION): boolean {
  if (!input.session_id || input.agent_id) return false;
  return parent === undefined || parent === "" || parent === input.session_id;
}

/** AskUserQuestion で持ち主が選んだ答え。質問と答えの組を持ち主の発言として残す。 */
export function answersOf(input: HookInput): string | null {
  const response = input.tool_response as { answers?: Record<string, unknown> } | undefined;
  const answers = response?.answers ?? (input.tool_input?.answers as Record<string, unknown> | undefined);
  if (!answers || typeof answers !== "object") return null;
  const lines = Object.entries(answers).map(
    ([q, a]) => `Q: ${q}\nA: ${Array.isArray(a) ? a.join(" / ") : String(a)}`,
  );
  return lines.length ? lines.join("\n\n") : null;
}

/** フック 1 回ぶん。何が起きても作業は止めない（例外は呼び出し側で握る）。 */
export function onHook(host: Host, input: HookInput): { flush: boolean } {
  const event = input.hook_event_name;
  if (event === "SessionStart") {
    // エージェントが Bash から起動する子へ、この session の id を継がせる。
    const file = process.env.CLAUDE_ENV_FILE;
    if (file && input.session_id && /^[A-Za-z0-9_-]+$/.test(input.session_id) && isOwnerTurn(input)) {
      fs.appendFileSync(file, `export MITOS_PARENT_SESSION=${input.session_id}\n`);
    }
    return { flush: false };
  }
  if (!isOwnerTurn(input)) return { flush: false };
  const place = identify(input.cwd ?? process.cwd());
  if (!place) return { flush: false };
  const turn = input.prompt_id ?? input.turn_id;
  if (!turn) return { flush: false };
  const at = new Date().toISOString();
  const base = {
    v: 1 as const,
    host,
    session: String(input.session_id),
    project: place.key,
    branch: branchOf(place.root),
    turn,
    at,
  };
  const say = (id: string, speaker: "self" | "assistant", raw: string) => {
    const body = mask(clean(raw)).trim();
    if (!body) return;
    spool({ ...base, kind: "message", id, speaker, ...fit(body) });
  };

  if (event === "UserPromptSubmit" && input.prompt) say(`${turn}:self`, "self", input.prompt);
  if (event === "Stop") {
    if (input.last_assistant_message) say(`${turn}:assistant`, "assistant", input.last_assistant_message);
    return { flush: true };
  }
  if (event === "PostToolUse") {
    const tool = input.tool_name ?? "";
    const ti = input.tool_input ?? {};
    if (tool === "AskUserQuestion") {
      const said = answersOf(input);
      if (said) say(`${turn}:ask:${input.tool_use_id ?? at}`, "self", said);
      return { flush: false };
    }
    const cwd = input.cwd ?? place.root;
    const files = (
      tool === "apply_patch"
        ? patchPaths(String(ti.command ?? ""))
        : [ti.file_path, ti.notebook_path].filter((p): p is string => typeof p === "string")
    ).flatMap((p) => relativeTo(place.root, p, cwd) ?? []);
    const action = tool === "Read" ? "read" : "edit";
    for (const p of files) {
      // 読んだファイルは、承認済みの要件定義・設計書だけを残す（画面のセッション詳細が成果物を出す）。
      if (action === "read" && !ARTIFACT_PATH.test(p)) continue;
      spool({ ...base, kind: "file", path: p, action });
    }
  }
  return { flush: false };
}

type State = { flushedAt?: string; error?: string | null; dropped?: number };

function writeState(s: State): void {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(s));
  } catch {
    // 状態を書けなくても記録は続ける
  }
}

export function readState(): State & { pending: number } {
  let pending = 0;
  try {
    pending = fs.readdirSync(spoolDir()).filter((f) => f.endsWith(".json") && !f.startsWith(".")).length;
  } catch {
    // 待ち行列がまだ無い
  }
  try {
    return { ...(JSON.parse(fs.readFileSync(stateFile(), "utf8")) as State), pending };
  } catch {
    return { pending };
  }
}

/** 同時に 2 つ走らせない。前の送信が死んで残した鍵は 5 分で捨てる。 */
function lock(): (() => void) | null {
  const file = path.join(spoolDir(), ".lock");
  try {
    fs.mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (st && Date.now() - st.mtimeMs > 5 * 60_000) fs.rmSync(file, { force: true });
    fs.writeFileSync(file, String(process.pid), { flag: "wx" });
    return () => fs.rmSync(file, { force: true });
  } catch {
    return null;
  }
}

const BATCH = 500;

/**
 * 待ち行列を DB へ送る。**鍵は capture（追記だけ）。**同じものを 2 回送っても行は増えない。
 * 登録されていない作業場所の記録は捨てる（記録するのは `mitos project add` した作業場所だけ）。
 */
/** sent は新しく入った発言の数（送り直した分は数えない）。 */
export async function flush(env: Env): Promise<{ sent: number; dropped: number }> {
  const unlock = lock();
  if (!unlock) return { sent: 0, dropped: 0 };
  const dir = spoolDir();
  let client: Awaited<ReturnType<typeof connect>> | null = null;
  try {
    const names = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .sort()
      .slice(0, BATCH);
    if (names.length === 0) return { sent: 0, dropped: 0 };
    const records: { name: string; r: Spooled }[] = [];
    for (const name of names) {
      try {
        records.push({ name, r: JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Spooled });
      } catch {
        fs.rmSync(path.join(dir, name), { force: true }); // 読めない残骸
      }
    }
    const db = await connect(env, "capture");
    client = db;
    const projects = new Map(
      (
        await db.query<{ id: string; key: string; name: string }>(
          "select id, key, name from mitos.project where key = any($1)",
          [[...new Set(records.map((x) => x.r.project))]],
        )
      ).rows.map((p) => [p.key, { id: Number(p.id), name: p.name }]),
    );
    const known = records.filter((x) => projects.has(x.r.project));
    const dropped = records.length - known.length;

    // 埋め込みは transaction の前に取る。落ちたら pending で入れ、次の同期（ingest の鍵）が取り直す。
    const messages = known.flatMap((x) => (x.r.kind === "message" ? [x.r] : []));
    const toEmbed = messages.filter((m) => indexesMessage(m.host, m.speaker));
    const texts = toEmbed.map((m) =>
      messageText({
        body: m.body,
        speakerKind: m.speaker,
        handle: null,
        project: projects.get(m.project)?.name ?? m.project,
        source: null,
        paths: [],
      }),
    );
    let vectors: number[][] | null = null;
    try {
      vectors = texts.length ? await embed(env, texts, "document") : [];
    } catch {
      vectors = null;
    }

    const vectorOf = new Map(toEmbed.map((m, n) => [m, { text: texts[n] ?? "", v: vectors?.[n] }]));
    let added = 0;
    // **衝突先の列を書かない（`on conflict do nothing`）。**列を書くと PostgreSQL はその列の SELECT 権限を求め、
    // 本文を読めない capture の鍵では拒否される。id は決定的に作るので、どの一意制約に当たっても「もう入っている」。
    await inTransaction(db, async () => {
      const conversations = new Map<
        string,
        { project: number; host: Host; session: string; branch: string | null; at: string }
      >();
      for (const { r } of known) {
        const p = projects.get(r.project);
        if (!p) continue;
        const id = conversationId(p.id, r.host, r.session);
        const prev = conversations.get(id);
        if (!prev || r.at < prev.at)
          conversations.set(id, {
            project: p.id,
            host: r.host,
            session: r.session,
            branch: r.branch,
            at: r.at,
          });
      }
      for (const [id, v] of conversations) {
        await db.query(
          `insert into mitos.conversation (id, project_id, origin, external_id, branch, started_at)
           values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
          [id, v.project, v.host, v.session, v.branch, v.at],
        );
      }
      for (const m of messages) {
        const p = projects.get(m.project);
        if (!p) continue;
        const conversation = conversationId(p.id, m.host, m.session);
        const id = uuidFrom(conversation, m.id);
        const indexed = indexesMessage(m.host, m.speaker);
        const inserted = await db.query(
          `insert into mitos.message (id, conversation_id, external_id, turn_id, speaker_kind, body, truncated,
                                      original_bytes, sent_at, content_hash, lexemes)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::tsvector) on conflict do nothing`,
          [
            id,
            conversation,
            m.id,
            m.turn,
            m.speaker,
            m.body,
            m.truncated,
            m.originalBytes,
            m.at,
            sha256(m.body),
            indexed ? tsvector(m.body) : null,
          ],
        );
        added += inserted.rowCount ?? 0;
        const e = vectorOf.get(m);
        if (!e) continue;
        const { text, v } = e;
        await db.query(
          `insert into mitos.message_embedding (message_id, model, source_hash, status, embedding)
           values ($1, $2, $3, $4, $5::extensions.halfvec) on conflict do nothing`,
          [id, EMBED_MODEL, sha256(text), v ? "ready" : "pending", v ? vec(v) : null],
        );
      }
      for (const { r } of known) {
        if (r.kind !== "file") continue;
        const p = projects.get(r.project);
        if (!p) continue;
        const conversation = conversationId(p.id, r.host, r.session);
        // その turn の持ち主の発言へ結ぶ。発言が無い turn（通知から始まった turn）は結ぶ先が無いので捨てる。
        await db.query(
          `insert into mitos.message_file (message_id, path, action)
           select $1, $2, $3 where exists (select 1 from mitos.message where id = $1) on conflict do nothing`,
          [uuidFrom(conversation, `${r.turn}:self`), r.path, r.action],
        );
      }
    });
    for (const x of records) fs.rmSync(path.join(dir, x.name), { force: true });
    writeState({ flushedAt: new Date().toISOString(), error: null, dropped });
    return { sent: added, dropped };
  } catch (e) {
    writeState({
      flushedAt: new Date().toISOString(),
      error: e instanceof Error ? e.message.slice(0, 300) : String(e),
    });
    throw e;
  } finally {
    await client?.end().catch(() => {});
    unlock();
  }
}

async function main(): Promise<void> {
  const host: Host = process.argv[2] === "codex" ? "codex" : "claude-code";
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const { flush: send } = onHook(host, JSON.parse(raw || "{}") as HookInput);
  if (send) await flush(loadEnv());
}

// フックとして起動されたときだけ動く（テストと CLI は関数だけを使う）。
if (process.argv[1] && /capture\.(ts|js)$/.test(process.argv[1])) {
  main().catch(() => {
    // 記録できなくても作業は止めない。送れなかった分は待ち行列に残る。
  });
}
