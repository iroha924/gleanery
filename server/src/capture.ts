#!/usr/bin/env node
// 会話の自動記録。フックから呼ばれ、持ち主の発言と AI の最後の応答と、触ったファイルを残す。
//
// **記録のフックは手元の待ち行列へ書くだけにする。**網へは Stop のときにまとめて送る（async のフックなので待たせない）。
// DB に届かない間も待ち行列に残り、次の送信で冪等に送り直す（id は入力から決定的に作る）。
//
// **持ち主が打っていない prompt を持ち主の発言として残さない。**先行事例では、別の agent 向けの prompt が
// 「利用者の発言」として DB の 97.2% を占めた。見分けは 4 つで、どれも推測をしない。
//   - subagent の中の turn は hook 入力に agent_id が付く
//   - エージェントが起動した子（Bash から叩いた claude -p、codex exec、codex-talk）は、親の SessionStart が
//     CLAUDE_ENV_FILE に書いた GLEANERY_PARENT_SESSION を継ぐ。自分の session id と違えば子である
//     （記録させたくない起動には、どの session とも一致しない値を置けばよい。値を「その session の id」にしてあるのは、
//     この変数が将来 hook 自身の環境へ届く仕様になっても、持ち主の session では自分の id と一致して記録が止まらないようにするため）
//   - 印を継がない headless（launchd や Codex から起動した claude -p）は、hook の環境の
//     CLAUDE_CODE_ENTRYPOINT が sdk-cli になる（2.1.269 で実測。文書には無い）。人が打つ session は cli
//   - 持ち主の session の中でも、背景タスクの完了・停止の通知と、channel・subagent・teammate・別の session からの伝言が
//     UserPromptSubmit に届く（通知は 2.1.269 で実測）。決まった形（INJECTED）で外す

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { ARTIFACT_PATH } from "./artifacts.ts";
import { connect, EMBED_MODEL, type Env, embed, inClientTransaction, KEY, loadEnv, vec } from "./db.ts";
import { conversationId, type FileAction, indexesMessage, messageText, type Origin } from "./knowledge.ts";
import { panel, plain } from "./panel.ts";
import { identify, patchPaths, relativeTo } from "./project.ts";
import { bytes, clean, head, mask, reason, sha256, tail, tsvector, uuidFrom } from "./text.ts";

// 置き場所は呼び出しのたびに決める（HOME を差し替えたテストが本物の待ち行列を触らない）。
export const spoolDir = (): string => path.join(os.homedir(), ".gleanery", "spool");
const stateFile = (): string => path.join(os.homedir(), ".gleanery", "capture.json");
/** DB が受け付けなかった記録。消さずにここへ移し、doctor が数を出す（直してから戻せば送り直せる）。 */
export const rejectedDir = (): string => path.join(spoolDir(), "rejected");

type Host = Exclude<Origin, "github">;

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
      /** 結ぶ先の持ち主の発言（message の id）。触る前に持ち主が最後にした発言 */
      message: string;
      path: string;
      action: Exclude<FileAction, "review">;
      at: string;
    };

/** 1 発言の上限。超えたら冒頭と末尾だけを残す（間違って貼った巨大なログで DB と埋め込みを埋めない）。 */
export const MAX_MESSAGE = 128 * 1024;
const KEEP = 8 * 1024;

/**
 * 大きさを収め、鍵を伏せる。**伏せ字は残す部分にだけかける** — 巨大な入力の全文へ正規表現を走らせない。
 * 切れ目をまたぐ鍵を半端に残さないよう、残す長さの倍の窓で伏せてから切る。
 * 残した本文の大きさは、切り詰めないときは伏せた後の本文と一致させる（表の CHECK）。
 */
export function fit(body: string): { body: string; truncated: boolean; originalBytes: number } {
  const all = bytes(body);
  if (all <= MAX_MESSAGE) {
    const kept = mask(body);
    return { body: kept, truncated: false, originalBytes: bytes(kept) };
  }
  const a = head(mask(head(body, KEEP * 2)), KEEP);
  const z = tail(mask(tail(body, KEEP * 2)), KEEP);
  const cut = all - bytes(a) - bytes(z);
  return {
    body: `${a}\n\n[中央 ${cut.toLocaleString("en-US")} bytes を保存していない]\n\n${z}`,
    truncated: true,
    originalBytes: all,
  };
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

/** 持ち主の turn か。subagent と、エージェントが起動した子と、印を継がない headless を外す。 */
export function isOwnerTurn(
  input: HookInput,
  parent = process.env.GLEANERY_PARENT_SESSION,
  entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT,
): boolean {
  if (!input.session_id || input.agent_id) return false;
  if (parent) return parent === input.session_id;
  return entrypoint !== "sdk-cli";
}

/**
 * 持ち主が打たずに届く prompt の形。hook の入力には出自の印が無い（transcript には付く。2.1.269 で実測）ので、形で外す。
 * 背景タスクの完了通知、背景 agent を止めた通知、channel・Slack・Web の取得結果・別の session・subagent・teammate からの
 * 伝言。Claude Code 2.1.270 で届く形として観測した（完了通知・止めた通知・伝言は手元の transcript に実物がある）。
 * **載っていない形は持ち主の発言として入る**（`/loop` で起きたときの prompt も、印の無い本文だけが届くので外せない）。
 * 版が上がったら hook の入力と transcript で取り直す。
 * **書き出しで外す。**機械の文を持ち主の発言と取り違えるより、持ち主が包みや通知の文面で書き始めた発言を落とす方を取る
 * （閉じタグの後ろに文が付く通知もある。手元の全 transcript では、持ち主の入力 830 件を 1 件も外さず、印の付いた通知と
 * 伝言 227 件をすべて外した）。文面は区切り（`:` か `.`）まで一致したときだけ外す。
 */
const INJECTED = [
  /^<(?:task-notification|channel|cross-session-message|teammate-message|agent-message|slack-ping|slack-tag-message|fetched-web-content|remote-review|remote-review-progress)[\s>]/,
  /^(?:\d+ background agents were stopped by the user:|Background agent ".*" was stopped by the user\.)/,
  /^(?:Another Claude|A peer) session sent a message(?: while you were working)?:/,
];

/**
 * 発言と応答の id の後半。**1 つの turn の id に発言も応答も複数届く** — 作業中に打った発言は走っている turn の id の
 * まま届き（transcript で 148 件中 143 件）、別の session からの伝言で始まる turn は直前の turn の id を使い回す
 * （127 件すべて）。turn の id だけで作ると一意制約でぶつかり、後から届いた方が黙って捨てられる。
 * **伏せた後の本文から作る**（伏せる前から作ると、伏せた本文と突き合わせて弱い鍵を総当たりで戻せる）。同じ入力が
 * 2 度届いても 1 行になる。同じ turn の id に同じ文面が 2 度届いたとき（同じ文面の打ち足しや応答）も 1 行になる。
 */
const digest = (s: string): string => sha256(s).toString("hex").slice(0, 16);

const saidDir = (): string => path.join(spoolDir(), "said");

/**
 * 持ち主の最後の発言の id を session ごとに覚える。その後に触ったファイルはこの発言へ結ぶ（完了通知や伝言から
 * 始まった turn には持ち主の発言が無く、turn の id では結べない）。読みかけに半端な値を返さないよう、別名で書いてから
 * 置き換える。30 日触らなかった session の分は消す。
 */
/**
 * 宛先が空くまで待つ回数と間隔（合計 300ms）。
 * ウイルス対策が掴む時間は数ミリ秒から数百ミリ秒に散るので、回数より実時間で足りるかを見る。
 */
const RENAME_TRIES = 20;
const RENAME_WAIT_MS = 15;

/**
 * 同期のまま待つ。**この経路は hook から同期で呼ばれるので await できない。**
 * `Atomics.wait` は Node のメインスレッドでも待つ（実測: v24 で 120ms 指定に 125ms）。
 */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function remember(session: string, id: string): void {
  const dir = saidDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, uuidFrom(session));
  const tmp = `${file}.${process.pid}`;
  fs.writeFileSync(tmp, id, { mode: 0o600 });
  // Windows は宛先を開いているプロセス（エディタ、ウイルス対策）がいる間 EPERM / EBUSY を返す。
  // ここで諦めると、後続の編集と Read の記録が前の発言へ誤って結ばれるか、結ばれずに捨てられる。
  // **実時間を空けて繰り返す。**空けずに回すと、相手が離す前に回数を使い切って同じ結果になる。
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= RENAME_TRIES || (code !== "EPERM" && code !== "EBUSY")) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      sleepSync(RENAME_WAIT_MS);
    }
  }
  const old = Date.now() - 30 * 86_400_000;
  for (const f of fs.readdirSync(dir)) {
    const st = fs.statSync(path.join(dir, f), { throwIfNoEntry: false });
    if (st && st.mtimeMs < old) fs.rmSync(path.join(dir, f), { force: true });
  }
}

function lastSaid(session: string): string | null {
  try {
    return fs.readFileSync(path.join(saidDir(), uuidFrom(session)), "utf8");
  } catch {
    return null; // この session で持ち主がまだ何も言っていない
  }
}

/**
 * AskUserQuestion で持ち主が選んだ答えと、答えに添えたメモ。質問と答えの組を持ち主の発言として残す。
 * tool_response は `{ questions, answers: {質問: 答え}, annotations: {質問: { notes }} }`（transcript の実物で確認）。
 * **答えは tool_response からだけ取る。**tool_input はモデルが書くので、そこにある値を持ち主の答えにしない。
 */
export function answersOf(input: HookInput): string | null {
  const response = input.tool_response as
    | { answers?: Record<string, unknown>; annotations?: Record<string, { notes?: unknown }> }
    | undefined;
  const answers = response?.answers;
  if (!answers || typeof answers !== "object") return null;
  const lines = Object.entries(answers).map(([q, a]) => {
    const notes = response?.annotations?.[q]?.notes;
    const memo = typeof notes === "string" && notes.trim() ? `\nメモ: ${notes.trim()}` : "";
    return `Q: ${q}\nA: ${Array.isArray(a) ? a.join(" / ") : String(a)}${memo}`;
  });
  return lines.length ? lines.join("\n\n") : null;
}

/**
 * 自動記録が止まっているなら、session の開始時に持ち主へ出す表示。**黙って待ち行列を積み続けない。**
 * 鍵が無い・送信が失敗し続けている・DB が受け付けなかった記録がある、のどれか。
 */
export function captureNotice(env: Env): string | null {
  if (!env[KEY.capture])
    return panel(
      `gleanery: ${KEY.capture} が無いので、会話を自動記録できない`,
      [],
      "gleanery doctor で確かめる",
    );
  const s = readState();
  if (s.stuck)
    return panel(
      "gleanery: 自動記録を送れていない",
      [`待ち ${s.pending} 件 / 最後の失敗: ${plain(s.stuck.slice(0, 120))}`],
      "gleanery doctor で確かめる",
    );
  if (s.rejected > 0)
    return panel(
      `gleanery: DB が受け付けなかった記録が ${s.rejected} 件ある`,
      [rejectedDir()],
      "直して待ち行列へ戻せば送り直す。gleanery doctor で確かめる",
    );
  return null;
}

/** フック 1 回ぶん。何が起きても作業は止めない（例外は呼び出し側で握る）。 */
export function onHook(host: Host, input: HookInput): { flush: boolean; notice?: string | null } {
  const event = input.hook_event_name;
  if (event === "SessionStart") {
    if (!isOwnerTurn(input)) return { flush: false };
    // エージェントが Bash から起動する子へ、この session の id を継がせる。
    const file = process.env.CLAUDE_ENV_FILE;
    if (file && input.session_id && /^[A-Za-z0-9_-]+$/.test(input.session_id)) {
      fs.appendFileSync(file, `export GLEANERY_PARENT_SESSION=${input.session_id}\n`);
    }
    return { flush: false, notice: captureNotice(loadEnv()) };
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
  const say = (key: string, speaker: "self" | "assistant", raw: string) => {
    const kept = fit(clean(raw).trim());
    if (!kept.body.trim()) return;
    const id = `${key}:${digest(kept.body)}`;
    spool({ ...base, kind: "message", id, speaker, ...kept });
    if (speaker === "self") remember(base.session, id);
  };

  if (event === "UserPromptSubmit" && input.prompt) {
    const prompt = input.prompt.trimStart();
    if (!INJECTED.some((r) => r.test(prompt))) say(`${turn}:self`, "self", prompt);
  }
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
    const message = lastSaid(base.session);
    if (!message) return { flush: false }; // 持ち主がまだ何も言っていない session には結ぶ先が無い
    const cwd = input.cwd ?? place.root;
    const files = (
      tool === "apply_patch"
        ? patchPaths(String(ti.command ?? ""))
        : [ti.file_path, ti.notebook_path].filter((p): p is string => typeof p === "string")
    ).flatMap((p) => relativeTo(place.root, p, cwd) ?? []);
    const action = tool === "Read" ? "read" : "edit";
    for (const p of files) {
      // 読んだファイルは、要件定義・設計書だけを残す。画面のセッション詳細は、そのうち承認済みとして同期された
      // 版だけを出す（draft を読んだ session も、後で承認された成果物に結ばれる）。
      if (action === "read" && !ARTIFACT_PATH.test(p)) continue;
      spool({ ...base, kind: "file", message, path: p, action });
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

/**
 * 待ち行列と送信の状態。`stuck` は送れていないときの最後の失敗で、失敗が残っていて待ちもあるときだけ入る
 * （待ちが空になれば失敗は過去のもの）。session の開始時の警告と doctor が同じ判定を使う。
 */
export function readState(): State & { pending: number; rejected: number; stuck: string | null } {
  const count = (dir: string) => {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).length;
    } catch {
      return 0; // まだ無い
    }
  };
  const counts = { pending: count(spoolDir()), rejected: count(rejectedDir()) };
  // 欄ごとに型を確かめて読む（外から書き換えられても、doctor と SessionStart の警告を落とさない）。
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>;
  } catch {
    // まだ送っていないか、書きかけで壊れていて読めない
  }
  // error は送信の失敗で文字列、成功で null。理由の文が空でも失敗は失敗として扱う。
  const error = typeof raw.error === "string" ? raw.error || "理由の分からない失敗" : null;
  return {
    flushedAt: typeof raw.flushedAt === "string" ? raw.flushedAt : undefined,
    error,
    dropped: typeof raw.dropped === "number" ? raw.dropped : undefined,
    ...counts,
    stuck: error && counts.pending > 0 ? error : null,
  };
}

/**
 * 同時に 2 つ走らせない。鍵は排他的に作り（`wx`）、中に持ち主の pid を書く。取れなければ中を読み、
 * 持ち主がもう居ないか 5 分より古ければ壊して 1 度だけ取り直す（`-p` の終了で殺された送信が鍵を残すと、
 * 次の送信が黙って空振りする。実測で起きた）。作った直後で pid をまだ書いていない鍵は、生きているものとして扱う。
 */
function lock(): (() => void) | null {
  const file = path.join(spoolDir(), ".lock");
  fs.mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      // 自分の鍵だけを外す（古いと見なされて別の送信に取り直された後なら、その鍵を消さない）。
      return () => {
        try {
          if (fs.readFileSync(file, "utf8") === String(process.pid)) fs.rmSync(file, { force: true });
        } catch {
          // もう無い
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st) continue;
    const holder = Number(fs.readFileSync(file, "utf8") || 0);
    const fresh = Date.now() - st.mtimeMs < 5 * 60_000;
    const alive = (() => {
      if (holder <= 0) return fresh; // 書きかけ
      try {
        return process.kill(holder, 0);
      } catch {
        return false;
      }
    })();
    if (alive && fresh) return null;
    fs.rmSync(file, { force: true });
  }
  return null;
}

const BATCH = 500;

type Project = { id: number; name: string };
type Vectors = Map<Spooled, { text: string; v: number[] | undefined }>;

/**
 * 記録の束を 1 つの transaction で書く。**表ごとに 1 往復**（往復の回数は件数に比例して効いてくる）。
 * **衝突先の列を書かない（`on conflict do nothing`）。**列を書くと PostgreSQL はその列の SELECT 権限を求め、
 * 本文を読めない capture の鍵では拒否される。id は待ち行列に書くときに決まるので、送り直しがどの一意制約に当たっても
 * 「もう入っている」。
 */
export async function write(
  db: pg.Client,
  batch: Spooled[],
  projects: Map<string, Project>,
  vectors: Vectors,
): Promise<number> {
  return inClientTransaction(db, async () => {
    const conversations = new Map<
      string,
      { project: number; host: Host; session: string; branch: string | null; at: string }
    >();
    for (const r of batch) {
      const p = projects.get(r.project);
      if (!p) continue;
      const id = conversationId(p.id, r.host, r.session);
      const prev = conversations.get(id);
      if (!prev || Date.parse(r.at) < Date.parse(prev.at))
        conversations.set(id, {
          project: p.id,
          host: r.host,
          session: r.session,
          branch: r.branch,
          at: r.at,
        });
    }
    const c = [...conversations];
    await db.query(
      `insert into gleanery.conversation (id, project_id, origin, external_id, branch, started_at)
       select * from unnest($1::uuid[], $2::bigint[], $3::text[], $4::text[], $5::text[], $6::timestamptz[])
       on conflict do nothing`,
      [
        c.map(([id]) => id),
        c.map(([, v]) => v.project),
        c.map(([, v]) => v.host),
        c.map(([, v]) => v.session),
        c.map(([, v]) => v.branch),
        c.map(([, v]) => v.at),
      ],
    );
    const messages = batch.flatMap((m) => {
      const p = m.kind === "message" ? projects.get(m.project) : undefined;
      if (m.kind !== "message" || !p) return [];
      const conversation = conversationId(p.id, m.host, m.session);
      return [
        { m, conversation, id: uuidFrom(conversation, m.id), indexed: indexesMessage(m.host, m.speaker) },
      ];
    });
    const inserted = await db.query(
      `insert into gleanery.message (id, conversation_id, external_id, turn_id, speaker_kind, body, truncated,
                                  original_bytes, sent_at, content_hash, lexemes)
       select t.id, t.conversation, t.external, t.turn, t.speaker, t.body, t.truncated, t.bytes, t.at, t.hash,
              t.lex::tsvector
       from unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::boolean[],
                   $8::int[], $9::timestamptz[], $10::bytea[], $11::text[])
         as t(id, conversation, external, turn, speaker, body, truncated, bytes, at, hash, lex)
       on conflict do nothing`,
      [
        messages.map((x) => x.id),
        messages.map((x) => x.conversation),
        messages.map((x) => x.m.id),
        messages.map((x) => x.m.turn),
        messages.map((x) => x.m.speaker),
        messages.map((x) => x.m.body),
        messages.map((x) => x.m.truncated),
        messages.map((x) => x.m.originalBytes),
        messages.map((x) => x.m.at),
        messages.map((x) => sha256(x.m.body)),
        messages.map((x) => (x.indexed ? tsvector(x.m.body) : null)),
      ],
    );
    // 埋め込みが取れなかった発言は pending で入れ、次の同期（ingest の鍵）が取り直す。
    const embedded = messages.flatMap((x) => {
      const e = vectors.get(x.m);
      return e ? [{ id: x.id, text: e.text, v: e.v }] : [];
    });
    await db.query(
      `insert into gleanery.message_embedding (message_id, model, source_hash, status, embedding)
       select t.id, $5, t.hash, t.status, t.v::extensions.halfvec
       from unnest($1::uuid[], $2::bytea[], $3::text[], $4::text[]) as t(id, hash, status, v)
       on conflict do nothing`,
      [
        embedded.map((x) => x.id),
        embedded.map((x) => sha256(x.text)),
        embedded.map((x) => (x.v ? "ready" : "pending")),
        embedded.map((x) => (x.v ? vec(x.v) : null)),
        EMBED_MODEL,
      ],
    );
    // 触る前に持ち主が最後にした発言へ結ぶ。その発言がこの会話の DB に無ければ（途中で別の作業場所へ移った session など）
    // 結ぶ先が無いので捨てる。
    const files = batch.flatMap((r) => {
      const p = r.kind === "file" ? projects.get(r.project) : undefined;
      if (r.kind !== "file" || !p) return [];
      return [
        {
          message: uuidFrom(conversationId(p.id, r.host, r.session), r.message),
          path: r.path,
          action: r.action,
        },
      ];
    });
    await db.query(
      `insert into gleanery.message_file (message_id, path, action)
       select t.message, t.path, t.action from unnest($1::uuid[], $2::text[], $3::text[]) as t(message, path, action)
       where exists (select 1 from gleanery.message m where m.id = t.message)
       on conflict do nothing`,
      [files.map((f) => f.message), files.map((f) => f.path), files.map((f) => f.action)],
    );
    return inserted.rowCount ?? 0;
  });
}

/**
 * その記録が原因の失敗か。DB が SQLSTATE を返したものは、接続・資源・停止（08 / 53 / 57 / 58）を除いて
 * 送り直しても同じ結果になる（値の域・制約・索引の上限など）。SQLSTATE の無い失敗（接続断）は束ごと送り直す。
 */
const rejected = (e: unknown): boolean => {
  const code = String((e as { code?: unknown }).code ?? "");
  return /^[0-9A-Z]{5}$/.test(code) && !/^(08|53|57|58)/.test(code);
};

/**
 * 待ち行列を DB へ送る。**鍵は capture（追記だけ）。**同じものを 2 回送っても行は増えない。
 * 登録されていない作業場所の記録は捨てる（記録するのは `gleanery project add` した作業場所だけ）。
 * **1 件の不正な記録で、以後の記録を止めない。**束が値の誤りで落ちたら 1 件ずつ送り直し、落ちた記録だけを
 * rejected/ へ移す（消さない）。接続断などの失敗は、束ごと待ち行列に残して次の送信で送り直す。
 *
 * sent は新しく入った発言の数（送り直した分は数えない）。busy は別の送信が走っていて何もしなかったとき。
 */
export async function flush(
  env: Env,
): Promise<{ sent: number; dropped: number; rejected: number; busy?: boolean }> {
  const unlock = lock();
  if (!unlock) return { sent: 0, dropped: 0, rejected: 0, busy: true };
  const dir = spoolDir();
  let client: pg.Client | null = null;
  try {
    const names = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .sort()
      .slice(0, BATCH);
    if (names.length === 0) return { sent: 0, dropped: 0, rejected: 0 };
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
          "select id, key, name from gleanery.project where key = any($1)",
          [[...new Set(records.map((x) => x.r.project))]],
        )
      ).rows.map((p) => [p.key, { id: Number(p.id), name: p.name }]),
    );
    const known = records.filter((x) => projects.has(x.r.project));
    const dropped = records.length - known.length;

    // 埋め込みは transaction の前に取る。落ちたら pending で入れ、次の同期が取り直す。
    const toEmbed = known.flatMap((x) =>
      x.r.kind === "message" && indexesMessage(x.r.host, x.r.speaker) ? [x.r] : [],
    );
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
    const vectorOf: Vectors = new Map(toEmbed.map((m, n) => [m, { text: texts[n] ?? "", v: vectors?.[n] }]));

    let sent = 0;
    const bad: { name: string; r: Spooled }[] = [];
    try {
      sent = await write(
        db,
        known.map((x) => x.r),
        projects,
        vectorOf,
      );
    } catch (e) {
      if (!rejected(e)) throw e;
      // 1 件ずつ。発言を先に送り、ファイルは後に送る（ファイルは持ち主の発言へ結ぶので、順が逆だと結び先が無い）。
      const ordered = [...known].sort((a, b) => Number(a.r.kind === "file") - Number(b.r.kind === "file"));
      for (const x of ordered) {
        try {
          sent += await write(db, [x.r], projects, vectorOf);
        } catch (e2) {
          if (!rejected(e2)) throw e2;
          bad.push(x);
        }
      }
    }
    // この束で弾かれた持ち主の発言へ結ぶファイルの記録も一緒に残す（送っても結ぶ先が無く 0 行になる）。後の束で届いた
    // ファイルの記録は、結ぶ先が無いまま捨てる。
    const lost = new Set(
      bad.flatMap((x) =>
        x.r.kind === "message" && x.r.speaker === "self" ? [`${x.r.session}\0${x.r.id}`] : [],
      ),
    );
    for (const x of known)
      if (x.r.kind === "file" && lost.has(`${x.r.session}\0${x.r.message}`) && !bad.includes(x)) bad.push(x);
    if (bad.length) {
      fs.mkdirSync(rejectedDir(), { recursive: true, mode: 0o700 });
      for (const x of bad) {
        try {
          fs.renameSync(path.join(dir, x.name), path.join(rejectedDir(), x.name));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // 並んだ送信が先に動かした
        }
      }
    }
    const moved = new Set(bad.map((x) => x.name));
    for (const x of records) if (!moved.has(x.name)) fs.rmSync(path.join(dir, x.name), { force: true });
    writeState({ flushedAt: new Date().toISOString(), error: null, dropped });
    return { sent, dropped, rejected: bad.length };
  } catch (e) {
    writeState({ flushedAt: new Date().toISOString(), error: reason(e).slice(0, 300) });
    throw e;
  } finally {
    await client?.end().catch(() => {});
    unlock();
  }
}

/** フックの入力を読む。塊ごとに文字へ変えると、境目で割れた多バイト文字が化けるので、文字として読ませる。 */
export async function readInput(stream: NodeJS.ReadableStream): Promise<HookInput> {
  stream.setEncoding("utf8");
  let raw = "";
  for await (const chunk of stream) raw += chunk;
  return JSON.parse(raw || "{}") as HookInput;
}

async function main(): Promise<void> {
  if (process.argv[2] === "--flush") {
    await flush(loadEnv());
    return;
  }
  const input = await readInput(process.stdin);
  const host: Host = process.argv[2] === "codex" ? "codex" : "claude-code";
  const { flush: send, notice } = onHook(host, input);
  // systemMessage は持ち主に見える警告で、モデルの文脈には入らない。
  if (notice) process.stdout.write(JSON.stringify({ systemMessage: notice }));
  // 送信は session から切り離したプロセスで行う。フックのプロセスのままだと、session の終わりに
  // ホストが殺し（`-p` では公式にそうなる）、最後の turn が次の送信まで届かない。
  if (send)
    spawn(process.execPath, [process.argv[1] ?? "", "--flush"], { detached: true, stdio: "ignore" }).unref();
}

// フックとして起動されたときだけ動く（テストと CLI は関数だけを使う）。
if (process.argv[1] && /capture\.(ts|js)$/.test(process.argv[1])) {
  main().catch(() => {
    // 記録できなくても作業は止めない。送れなかった分は待ち行列に残る。
  });
}
