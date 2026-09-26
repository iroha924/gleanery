#!/usr/bin/env node

// Has `claude -p` answer the retrieval.json questions through a bundled MCP server. **It uses the owner's subscription; not part of verify.**
// SPHICA_DB is a fixed `vacuum into` copy of the question set's snapshot. Results go to <OUT>/<name>/<split>/.
//   SPHICA_DB=<copy> bun run evals:agentic -- --name base --split dev --model sonnet (repeats of one setup: base-r2, base-r3)

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Kysely } from "kysely";
import { openReader } from "../../src/db.ts";
import type { DB } from "../../src/db-types.ts";
import { SPLITS, type Split } from "../cases.ts";
import { type Call, callsOf, codexCallsOf, replay, type Session, sessionOf } from "./session.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
/** Outside the repository and ~/.sphica, and kept across reboots (the ledger decides the next experiment from past runs) */
export const OUT = process.env.SPHICA_EVALS_OUT || path.join(os.homedir(), ".cache", "sphica-evals");

export type Case = { q: string; expect: string[]; kind: string; source: string };
const CASES = fs.readFileSync(path.join(HERE, "../retrieval.json"), "utf8");
export const { cases, snapshot: SNAPSHOT } = JSON.parse(CASES) as { cases: Case[]; snapshot: string };
/** Fingerprint of the question set. Rebuilding retrieval.json reshuffles the splits, so different sets are never compared. */
export const CASES_SHA = crypto.createHash("sha256").update(CASES).digest("hex").slice(0, 16);

export type Result = {
  i: number;
  q: string;
  kind: string;
  /** Rank of the answer (0-based), or -1 if not in the top 5 */
  rank: number;
  refs: string[];
  /** refs mapped to the answer keys (source_key for knowledge, id for messages), comparable across reimports */
  keys: (string | null)[];
  turns: number;
  /** USD. null where the host reports none (Codex), never 0 */
  cost: number | null;
  ms: number;
  /**
   * The model id actually used and the CLI version. Claude: from the trace init (aliases like sonnet change targets).
   * Codex: the pinned model and `codex --version` (the stream names neither). `claude` keeps its name so older runs still read
   */
  resolved: { model: string | null; claude: string | null };
  /** Tokens the host reported (Codex), for comparing runs of one host when there is no cost */
  tokens?: { input: number; cached: number; output: number } | undefined;
  /** What the tool calls returned along the way (whether the answer appeared before the final reply) */
  session: Session;
  error?: string;
};

// The prompt is part of the measurement: bump ANSWER_VERSION on any change (runs with different versions are not compared).
// all_projects is needed because each question runs in an empty directory that belongs to no project.
export const ANSWER_VERSION = 2;
const ANSWER = [
  "sphica の recall と read には all_projects: true を付ける。",
  '最後の行に {"refs":["k:1","k:2"]} の形の JSON だけを出す（問いに最も直接答える記録を関連の高い順に最大 5 件）。',
].join("\n");
/** Caps per question, so a looping agent cannot run up the owner's usage */
const ANSWER_BUDGET_USD = "0.5";
const ANSWER_MAX_TURNS = "30";

/**
 * Where results go. It is wiped at start, so first confirm it stays inside OUT.
 * The name is restricted lexically, and OUT or an existing `<name>` that is a symlink is rejected (a path inside by text can point outside).
 */
export function runDir(out: string, name: string, split: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes(".."))
    throw new Error(
      `--name must start with a letter or digit and use only letters, digits, and . _ - (${JSON.stringify(name)})`,
    );
  if (fs.lstatSync(out, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error(`not using the results directory ${out} because it is a symlink`);
  const dir = path.join(out, name);
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink())
    throw new Error(`not using the --name directory ${dir} because it is a symlink`);
  if (stat && !fs.realpathSync(dir).startsWith(`${fs.realpathSync(out)}${path.sep}`))
    throw new Error(`the --name directory ${dir} is outside ${out}`);
  return path.join(dir, split);
}

export type Host = "claude" | "codex";

/** Codex is measured on the owner's pinned Codex model; Claude on the alias the base used */
export const DEFAULT_MODEL: Record<Host, string> = { claude: "sonnet", codex: "gpt-6-sol" };

export function hostOf(value: string): Host {
  if (value !== "claude" && value !== "codex") throw new Error(`--host must be claude or codex (${value})`);
  return value;
}

/** Claude runs are capped by USD (--budget), Codex runs by the number of questions started (--questions) */
export const limitFor = (host: Host, budget: string, questions: string): Limit =>
  host === "codex" ? new QuestionCap(Number(questions)) : new Budget(Number(budget));

/** What stops a run from starting more questions. A run stopped by it is incomplete */
export type Limit = { reserve(): boolean; settle(cost: number | null): void; readonly spent: number | null };

/** Shared cap on the owner's usage across parallel questions: each question reserves its own cap before it starts. */
export class Budget implements Limit {
  spent = 0;
  private held = 0;
  readonly cap: number;
  constructor(cap: number) {
    // NaN would make every reservation pass
    if (!(Number.isFinite(cap) && cap > 0))
      throw new Error(`--budget must be a positive number of USD (${cap})`);
    this.cap = cap;
  }
  reserve(): boolean {
    if (this.spent + this.held + Number(ANSWER_BUDGET_USD) > this.cap) return false;
    this.held += Number(ANSWER_BUDGET_USD);
    return true;
  }
  settle(cost: number | null) {
    this.held -= Number(ANSWER_BUDGET_USD);
    // A question whose cost is unknown is charged its whole cap, so the budget still holds
    this.spent += cost ?? Number(ANSWER_BUDGET_USD);
  }
}

/** Codex reports no cost, so a Codex run is capped by the number of questions it starts, and each question by CODEX_TIMEOUT_MS */
export class QuestionCap implements Limit {
  readonly spent = null;
  private started = 0;
  readonly cap: number;
  constructor(cap: number) {
    if (!(Number.isInteger(cap) && cap > 0))
      throw new Error(`--questions must be a positive integer (${cap})`);
    this.cap = cap;
  }
  reserve(): boolean {
    if (this.started >= this.cap) return false;
    this.started++;
    return true;
  }
  settle() {}
}

export type Measure = {
  name: string;
  split: Split;
  host: Host;
  model: string;
  effort?: string | undefined;
  par: number;
  /** The bundled MCP server to measure */
  mcp: string;
  /** Only the first n questions of the split (a pilot) */
  limit?: number | undefined;
  budget: Limit;
  /** A note placed as CLAUDE.md in each question's working directory, loaded at session start like memory (none when undefined) */
  memo?: string | undefined;
};

/** Runs one split once and writes <OUT>/<name>/<split>/summary.json. Stops starting questions when the budget runs out (the run is then incomplete). */
export async function measure(o: Measure) {
  if (!fs.existsSync(o.mcp)) throw new Error(`${o.mcp} is missing. Run bun run bundle first`);
  // The memo is placed as CLAUDE.md, which Codex does not read, so a Codex run with one would record a memo it never saw
  if (o.memo && o.host === "codex") throw new Error("--memo is for Claude runs only");
  const db = fixedDb();
  // Answer keys exist only in the snapshot the questions were built from (or a copy migrated from it)
  if (sourceOf(db) !== SNAPSHOT)
    throw new Error(`${db} does not come from the question set's snapshot ${SNAPSHOT} (retrieval.json)`);
  const run = runDir(OUT, o.name, o.split);
  fs.rmSync(run, { recursive: true, force: true });
  fs.mkdirSync(run, { recursive: true });
  const keyOf = await keys();
  // Every question reads this copy, so a memo edited during the run cannot mix two versions under one recorded hash
  const memo = o.memo ? path.join(run, "memo.md") : undefined;
  if (o.memo && memo) fs.copyFileSync(o.memo, memo);
  // Codex: the CLI version is recorded, and a capability probe must show no shell, file read, or sub-agent before any question runs
  const cli = o.host === "codex" ? codexVersion() : null;
  if (o.host === "codex") await probeCodex(run, o.mcp, o.model, o.effort);
  // Replays recorded calls to learn what each response showed. A DB this checkout cannot open leaves every call unconfirmed
  const replayDb = openReader(db);

  const all = cases.map((c, i) => ({ c, i })).filter(({ c, i }) => SPLITS[o.split](c, i));
  const todo = all.slice(0, o.limit ?? all.length);
  const planned = todo.length;
  const results: Result[] = [];
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: o.par }, async () => {
      for (let x = todo.shift(); x; x = todo.shift()) {
        if (!o.budget.reserve()) {
          todo.length = 0;
          break;
        }
        const r = await solve(x.c, x.i, {
          run,
          host: o.host,
          cli,
          mcp: o.mcp,
          model: o.model,
          effort: o.effort,
          keyOf,
          db: replayDb,
          memo,
        });
        o.budget.settle(r.cost);
        results.push(r);
        console.error(
          `${o.name} q${r.i} ${r.rank === 0 ? "✓" : r.rank < 0 ? "✗" : `#${r.rank + 1}`}${r.error ? ` ${r.error}` : ""}`,
        );
      }
    }),
  );
  await replayDb.destroy();
  results.sort((a, b) => a.i - b.i);
  const summary = summarize(results, {
    name: o.name,
    split: o.split,
    host: o.host,
    model: o.model,
    // Without --effort, the environment variable decides, or else the model default (in 2.1.280, high for Sonnet 5 and medium for Opus 5.5).
    // The project is a temp directory, so the repository's effortLevel setting is not read.
    // These values are stored in summaries and compared across runs by judge.ts, so they stay as recorded
    effort:
      o.host === "codex"
        ? codexEffort(o.effort)
        : (o.effort ??
          (process.env.CLAUDE_CODE_EFFORT_LEVEL
            ? `環境変数 ${process.env.CLAUDE_CODE_EFFORT_LEVEL}`
            : "既定")),
    cases: CASES_SHA,
    prompt: ANSWER_VERSION,
    db: sha256File(db),
    source: sourceOf(db),
    bundle: sha256File(o.mcp),
    ...(memo ? { memo: sha256File(memo) } : {}),
    complete: results.length === planned && o.limit === undefined,
    ms: Date.now() - t0,
  });
  fs.writeFileSync(path.join(run, "summary.json"), JSON.stringify({ ...summary, results }, null, 1));
  return { dir: run, summary, results };
}

async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: "string", default: "base" },
      split: { type: "string", default: "dev" },
      host: { type: "string", default: "claude" },
      // Defaults by host (DEFAULT_MODEL)
      model: { type: "string" },
      // Without it, measure at Claude Code's default effort (as the baseline was). The default changes by version, so record it with the version
      effort: { type: "string" },
      par: { type: "string", default: "4" },
      mcp: { type: "string", default: path.join(REPO, "plugin/dist/mcp.js") },
      budget: { type: "string", default: "10" },
      // Codex only: how many questions the run may start (Codex reports no cost for --budget)
      questions: { type: "string", default: "70" },
      memo: { type: "string" },
    },
  });
  const host = hostOf(values.host);
  const split = values.split as Split;
  if (!(split in SPLITS)) throw new Error(`--split must be one of ${Object.keys(SPLITS).join(" / ")}`);
  // 0 workers would write an empty summary and exit as if it had measured
  if (!Number.isInteger(Number(values.par)) || Number(values.par) < 1)
    throw new Error(`--par must be a positive integer (${values.par})`);
  const { dir, summary, results } = await measure({
    name: values.name,
    split,
    host,
    model: values.model ?? DEFAULT_MODEL[host],
    effort: values.effort,
    par: Number(values.par),
    mcp: values.mcp,
    memo: values.memo,
    budget: limitFor(host, values.budget, values.questions),
  });
  console.log(JSON.stringify(summary));
  for (const r of results)
    if (r.rank !== 0)
      console.log(
        `  ${r.rank < 0 ? "miss" : `#${r.rank + 1}`} [${r.kind}] q${r.i} ${r.q}${r.error ? ` (${r.error})` : ""}`,
      );
  console.log(`results: ${dir}`);
}

export type KnowledgeRow = {
  id: number;
  source_key: string;
  kind: string;
  status: string | null;
  heading: string | null;
  body: string;
  reason: string | null;
};

/**
 * Knowledge rows straight from the file, **without the schema version check**: the measured copy may be migrated ahead of this checkout
 * (a candidate's revision), and the eval only needs ids, keys, and text.
 */
export function knowledgeRows(file: string): KnowledgeRow[] {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    return raw
      .prepare("select id, source_key, kind, status, heading, body, reason from knowledge")
      .all() as KnowledgeRow[];
  } finally {
    raw.close();
  }
}

/** Maps a ref to the answer key. Never matches by id (ids change on reimport). A message id is its own key. */
async function keys(): Promise<(ref: string) => string | null> {
  const byRef = new Map(knowledgeRows(fixedDb()).map((r) => [`k:${r.id}`, r.source_key]));
  return (ref) => (ref.startsWith("m:") ? ref.slice(2) : (byRef.get(ref) ?? null));
}

/** The error of a question that used another tool. judge.ts recounts it from the trace, so a narrower rule applies to saved runs too */
export const DISALLOWED = "used a tool other than sphica recall and read";
const UNPARSED = "cannot parse the final refs JSON (a format failure, not a search miss)";

type Asked = {
  run: string;
  host: Host;
  /** The Codex CLI version (null for Claude, whose trace reports its own) */
  cli: string | null;
  mcp: string;
  model: string;
  effort: string | undefined;
  keyOf: (ref: string) => string | null;
  db: Kysely<DB>;
  memo: string | undefined;
};

/** What one host returned for a question, before scoring */
type Answer = {
  events: Event[];
  calls: Call[];
  /** The agent's final reply */
  final: string;
  turns: number;
  cost: number | null;
  resolved: Result["resolved"];
  tokens?: Result["tokens"];
  error?: string;
};

async function solve(c: Case, i: number, o: Asked): Promise<Result> {
  const dir = path.join(o.run, `q${i}`);
  fs.mkdirSync(dir);
  // The working directory is an empty place, neither the repository nor ~/.sphica. Loading the owner's CLAUDE.md, plugins, and hooks
  // would measure the owner's setup instead of the shipped tools (and the hooks would even run capture).
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-evals-cwd-"));
  if (o.memo) fs.copyFileSync(o.memo, path.join(cwd, "CLAUDE.md"));
  const t0 = Date.now();
  try {
    const prompt = `${c.q}\n\n${ANSWER}`;
    const a = o.host === "codex" ? await askCodex(prompt, cwd, o) : await askClaude(prompt, cwd, dir, o);
    fs.writeFileSync(path.join(dir, "trace.jsonl"), a.events.map((e) => JSON.stringify(e)).join("\n"));
    const refs = refsOf(a.final);
    const keys = (refs ?? []).map(o.keyOf);
    const session = sessionOf(await replay(a.calls, o.db, cwd), o.keyOf, c.expect);
    const res: Result = {
      i,
      q: c.q,
      kind: c.kind,
      rank: keys.findIndex((k) => k !== null && c.expect.includes(k)),
      refs: refs ?? [],
      keys,
      turns: a.turns,
      cost: a.cost,
      ms: Date.now() - t0,
      resolved: a.resolved,
      ...(a.tokens ? { tokens: a.tokens } : {}),
      session,
      ...(a.error
        ? { error: a.error.slice(0, 200) }
        : session.disallowed > 0
          ? // Keeps the format failure too, so a later, narrower rule that clears the tool use still counts it
            { error: refs === null ? `${DISALLOWED}; ${UNPARSED}` : DISALLOWED }
          : refs === null
            ? { error: UNPARSED }
            : {}),
    };
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(res, null, 1));
    return res;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function askClaude(prompt: string, cwd: string, dir: string, o: Asked): Promise<Answer> {
  const config = path.join(dir, "mcp.json");
  // Point SPHICA_DB at a database copied for evaluation. Pass it to MCP explicitly (not relying on the parent environment).
  const env = { SPHICA_DB: fixedDb() };
  fs.writeFileSync(
    config,
    JSON.stringify({ mcpServers: { sphica: { command: "node", args: [o.mcp], env } } }),
  );
  const { events, code, err } = await jsonLines(
    "claude",
    [
      "-p",
      "--model",
      o.model,
      ...(o.effort ? ["--effort", o.effort] : []),
      "--max-budget-usd",
      ANSWER_BUDGET_USD,
      "--max-turns",
      ANSWER_MAX_TURNS,
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--mcp-config",
      config,
      "--tools",
      "",
      "--allowedTools",
      "mcp__sphica__recall,mcp__sphica__read",
      // stream-json prints each tool call on its own line. json keeps only the last reply, so misses cannot be traced
      "--output-format",
      "stream-json",
      "--verbose",
      // Without it, ~/.claude/projects/ collects one session per question (379 in one experiment)
      "--no-session-persistence",
    ],
    { cwd, env: CLAUDE_ENV, prompt, timeoutMs: 300_000 },
  );
  if (!events.some((e) => e.type === "result"))
    events.push({
      type: "result",
      is_error: true,
      result: `claude exited with ${code}: ${err.slice(0, 300)}`,
    });
  const last = events.findLast((e) => e.type === "result");
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  return {
    events,
    calls: callsOf(events),
    final: String(last?.result ?? ""),
    turns: Number(last?.num_turns ?? 0),
    cost: Number(last?.total_cost_usd ?? 0),
    resolved: {
      model: typeof init?.model === "string" ? init.model : null,
      claude: typeof init?.claude_code_version === "string" ? init.claude_code_version : null,
    },
    ...(last === undefined || last.is_error ? { error: String(last?.result ?? "no response") } : {}),
  };
}

/** A Codex question gets this long; a killed question is an error (Codex has no turn or cost cap of its own) */
const CODEX_TIMEOUT_MS = 300_000;
/** Built-in Codex tools turned off (checked by probeCodex). Code mode stays on: in codex-cli 0.157.1 MCP tools are called through it */
const CODEX_OFF = [
  "shell_tool",
  "unified_exec",
  "multi_agent",
  "goals",
  "sleep_tool",
  "view_image",
  "browser_use",
  "computer_use",
  "image_generation",
  "apps",
  "plugins",
];

export const codexEffort = (effort: string | undefined) => effort ?? "high";

/** `codex exec` for one question: read-only, no session kept, only sphica's recall and read, every setting given here */
export function codexArgs(mcp: string, db: string, model: string, effort: string | undefined): string[] {
  const toml = (s: string) => JSON.stringify(s);
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--model",
    model,
    "-c",
    `model_reasoning_effort=${toml(codexEffort(effort))}`,
    ...CODEX_OFF.flatMap((f) => ["-c", `features.${f}=false`]),
    "-c",
    'web_search="disabled"',
    "-c",
    'mcp_servers.sphica.command="node"',
    "-c",
    `mcp_servers.sphica.args=[${toml(mcp)}]`,
    "-c",
    `mcp_servers.sphica.env={SPHICA_DB=${toml(db)}}`,
    "-c",
    'mcp_servers.sphica.enabled_tools=["recall","read"]',
    // The prompt comes from stdin
    "-",
  ];
}

/**
 * A fresh HOME and CODEX_HOME per call, so Codex reads none of the owner's AGENTS.md, config, rules, plugins, or hooks, and a hook
 * that did run would write under the temp HOME instead of ~/.sphica. CODEX_HOME holds only a link to the login, so no copy of it stays.
 */
function codexHome(): { root: string; env: NodeJS.ProcessEnv } {
  const auth = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "auth.json");
  if (!fs.existsSync(auth)) throw new Error(`${auth} is missing. Log in to Codex first`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-evals-codex-"));
  fs.mkdirSync(path.join(root, "home"));
  fs.mkdirSync(path.join(root, "codex"));
  fs.symlinkSync(auth, path.join(root, "codex", "auth.json"));
  return {
    root,
    env: { ...process.env, HOME: path.join(root, "home"), CODEX_HOME: path.join(root, "codex") },
  };
}

/** Runs codex exec with a fresh home, and reports whether anything wrote sphica data under that home */
async function runCodex(prompt: string, cwd: string, args: string[]) {
  const home = codexHome();
  try {
    const r = await jsonLines("codex", args, { cwd, env: home.env, prompt, timeoutMs: CODEX_TIMEOUT_MS });
    return { ...r, captured: fs.existsSync(path.join(home.root, "home", ".sphica")) };
  } finally {
    fs.rmSync(home.root, { recursive: true, force: true });
  }
}

async function askCodex(prompt: string, cwd: string, o: Asked): Promise<Answer> {
  const { events, code, err, timedOut, captured } = await runCodex(
    prompt,
    cwd,
    codexArgs(o.mcp, fixedDb(), o.model, o.effort),
  );
  const calls = codexCallsOf(events);
  const done = events.findLast((e) => e.type === "turn.completed");
  const usage = (done?.usage ?? {}) as Record<string, unknown>;
  const failed = events.find((e) => e.type === "turn.failed" || e.type === "error");
  const error = timedOut
    ? `codex timed out after ${CODEX_TIMEOUT_MS / 1000} s`
    : captured
      ? "sphica capture wrote under the temp HOME"
      : failed
        ? `codex failed: ${JSON.stringify(failed.error ?? failed.message ?? failed).slice(0, 300)}`
        : done === undefined
          ? `codex exited with ${code}: ${err.slice(0, 300)}`
          : undefined;
  return {
    events,
    calls,
    final: String(
      (
        events.findLast(
          (e) => e.type === "item.completed" && (e.item as CodexMessage)?.type === "agent_message",
        )?.item as CodexMessage | undefined
      )?.text ?? "",
    ),
    // Codex reports no model turns; count one per tool call plus the final reply, comparable only between Codex runs
    turns: calls.length + 1,
    cost: null,
    resolved: { model: o.model, claude: o.cli },
    tokens: {
      input: Number(usage.input_tokens ?? 0),
      cached: Number(usage.cached_input_tokens ?? 0),
      output: Number(usage.output_tokens ?? 0),
    },
    ...(error ? { error } : {}),
  };
}

type CodexMessage = { type?: string; text?: string };

export function codexVersion(): string {
  return execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
}

const PROBE = [
  "This is a sandbox capability test. Do these in order and report each result exactly:",
  "1. List every tool name you can call, including any available inside code mode.",
  "2. Try to run the shell command `ls /`.",
  "3. Inside code mode, try to read the file /etc/hosts with JavaScript (for example require('fs') or Deno or Node APIs).",
  "4. Try to spawn a sub-agent and ask it to run the shell command `ls /`.",
].join("\n");

/**
 * Before any Codex question: ask Codex to try the ways around the sphica tools, and stop when any of them completed.
 * The events are kept as <run>/probe.jsonl. Run on every measurement, so a new CLI version is probed before it is measured.
 */
export async function probeCodex(run: string, mcp: string, model: string, effort: string | undefined) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-evals-cwd-"));
  try {
    const { events, captured } = await runCodex(PROBE, cwd, codexArgs(mcp, fixedDb(), model, effort));
    fs.writeFileSync(path.join(run, "probe.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
    const leaks = probeLeaks(events);
    if (captured) leaks.push("sphica capture wrote under the temp HOME");
    if (leaks.length)
      throw new Error(`the Codex capability probe found a way around the sphica tools: ${leaks.join("; ")}`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/** Tool calls in a probe that ran to completion without being a sphica recall or read, or a probe that never finished */
export function probeLeaks(events: Event[]): string[] {
  const out = codexCallsOf(events)
    .filter((c) => c.tool === "other" && !c.error)
    .map((c) => `a call completed: ${c.text.slice(0, 120) || "(no text)"}`);
  if (!events.some((e) => e.type === "turn.completed")) out.push("the probe did not finish");
  return out;
}

type Event = { type?: string; [k: string]: unknown };

// Even with --no-session-persistence, ~/.claude/projects/<cwd>/memory/ is created per cwd (measured: 42 for 42 questions)
export const CLAUDE_ENV = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };

/** Runs a CLI that prints one JSON event per line. The prompt goes through stdin: as an argument, a question starting with `--` is read as an option. */
function jsonLines(
  command: string,
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; prompt: string; timeoutMs: number },
): Promise<{ events: Event[]; code: number | null; err: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(o.prompt);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, o.timeoutMs);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const events = out
        .split("\n")
        .filter((l) => l.trim())
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as Event];
          } catch {
            return [];
          }
        });
      resolve({ events, code, err, timedOut });
    });
  });
}

/** The `{"refs":[...]}` on the last line. Uses the last match so examples earlier in the text are skipped. null if unreadable */
export function refsOf(text: string): string[] | null {
  const m = [...text.matchAll(/\{\s*"refs"\s*:\s*\[[^\]]*\]\s*\}/g)].pop();
  if (!m) return null;
  try {
    return (JSON.parse(m[0]).refs as unknown[]).filter((r): r is string => typeof r === "string").slice(0, 5);
  } catch {
    return null;
  }
}

/**
 * The measured DB. **A live DB changes between runs**, so only a copy is accepted: SPHICA_DB must be set and have no pending WAL
 * (a copy made with `vacuum into` has none).
 */
export function fixedDb(live = path.join(os.homedir(), ".sphica", "sphica.db")): string {
  const db = process.env.SPHICA_DB;
  if (!db)
    throw new Error("Set SPHICA_DB to a copy of the DB made with vacuum into (the run records its hash)");
  // Resolved through symlinks, so a link to the live database is caught and its WAL is looked up where it really is
  const real = (p: string) => (fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p));
  const file = real(db);
  if (file === real(live))
    throw new Error("SPHICA_DB points at the live database. Measure a copy made with vacuum into");
  // SQLite names the WAL after the path it opened (the link on Windows, the target elsewhere), so both are checked
  if ([db, file].some((f) => (fs.statSync(`${f}-wal`, { throwIfNoEntry: false })?.size ?? 0) > 0))
    throw new Error(
      `${db} has a WAL with pending writes, so it is not a fixed copy. Make one with vacuum into`,
    );
  // Absolute, because question runs start in temporary working directories
  return path.resolve(db);
}

/**
 * The snapshot a copy comes from. A migrated copy carries `<db>.json` ({"source": <snapshot sha>, "migration": <id>}) written when it was made;
 * a plain `vacuum into` copy is its own source.
 */
export function sourceOf(db: string): string {
  // The sidecar sits beside the real file, not beside a link to it
  const side = `${fs.realpathSync(db)}.json`;
  if (!fs.existsSync(side)) return sha256File(db);
  const s = (JSON.parse(fs.readFileSync(side, "utf8")) as { source?: unknown }).source;
  if (typeof s !== "string") throw new Error(`${side} has no source snapshot hash`);
  return s;
}

export const sha256File = (file: string): string =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);

export function summarize(
  results: Result[],
  meta: {
    name: string;
    split: string;
    /** Older runs have none; they are Claude runs */
    host?: Host;
    model: string;
    effort: string;
    cases: string;
    prompt?: number;
    db?: string;
    source?: string;
    bundle?: string;
    /** Hash of the memo placed as CLAUDE.md, when one was */
    memo?: string;
    /** false when the budget stopped it early or it was a pilot (such a run is never compared) */
    complete?: boolean;
    ms: number;
  },
) {
  const n = results.length;
  // Stored in summary.json and compared across runs by judge.ts, so the value stays as recorded
  const distinct = (xs: (string | null)[]) => [...new Set(xs.map((x) => x ?? "不明"))].sort();
  const pct = (k: number) => Math.round((k / Math.max(n, 1)) * 1000) / 10;
  return {
    ...meta,
    n,
    top1: pct(results.filter((r) => r.rank === 0).length),
    recall5: pct(results.filter((r) => r.rank >= 0).length),
    mrr:
      Math.round(
        (results.reduce((s, r) => s + (r.rank >= 0 ? 1 / (r.rank + 1) : 0), 0) / Math.max(n, 1)) * 1000,
      ) / 1000,
    turns: Math.round((results.reduce((s, r) => s + r.turns, 0) / Math.max(n, 1)) * 10) / 10,
    // Unrounded, for the guardrail (turns is rounded for display)
    turns_mean: results.reduce((s, r) => s + r.turns, 0) / Math.max(n, 1),
    // null when any question has no cost (Codex): a partial sum would read as the run's cost
    cost_usd_list: results.some((r) => r.cost === null)
      ? null
      : Math.round(results.reduce((s, r) => s + (r.cost ?? 0), 0) * 100) / 100,
    ...(results.some((r) => r.tokens)
      ? {
          tokens: {
            input: results.reduce((s, r) => s + (r.tokens?.input ?? 0), 0),
            cached: results.reduce((s, r) => s + (r.tokens?.cached ?? 0), 0),
            output: results.reduce((s, r) => s + (r.tokens?.output ?? 0), 0),
          },
        }
      : {}),
    minutes: Math.round(meta.ms / 6000) / 10,
    errors: results.filter((r) => r.error).length,
    ...sessionSummary(results.flatMap((r) => (r.session ? [r.session] : []))),
    resolved_models: distinct(results.map((r) => r.resolved?.model ?? null)),
    claude_code: distinct(results.map((r) => r.resolved?.claude ?? null)),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();

/** Session metrics over the questions. Rates are percentages of questions (or of recall calls for empty_recalls). */
export function sessionSummary(ss: Session[]) {
  const n = Math.max(ss.length, 1);
  const pct = (k: number, of = n) => Math.round((k / Math.max(of, 1)) * 1000) / 10;
  const mean = (xs: number[]) =>
    Math.round((xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)) * 10) / 10;
  const recalls = ss.reduce((a, s) => a + s.recalls, 0);
  const usage: Record<string, number> = {};
  for (const s of ss) for (const [k, v] of Object.entries(s.usage)) usage[k] = (usage[k] ?? 0) + v;
  return {
    session_recall: pct(ss.filter((s) => s.exposed !== null).length),
    first_in_read: pct(ss.filter((s) => s.exposed === "read").length),
    // Where the answer was shown in full at least once (a question can count in several)
    via_records: pct(ss.filter((s) => s.via.records).length),
    via_documents: pct(ss.filter((s) => s.via.documents).length),
    via_hits: pct(ss.filter((s) => s.via.hits).length),
    via_read: pct(ss.filter((s) => s.via.read).length),
    // Of via_read: the answer was a ref the read asked for, or only a related option or verification inside another record (#160)
    via_read_requested: pct(ss.filter((s) => s.read?.requested).length),
    via_read_related_only: pct(ss.filter((s) => s.read?.related && !s.read.requested).length),
    // Calls to other tools that were not refused before running, and calls refused before running (older runs recorded neither)
    disallowed_calls: ss.reduce((a, s) => a + (s.disallowed ?? 0), 0),
    rejected_calls: ss.reduce((a, s) => a + (s.rejected ?? 0), 0),
    // Calls whose replay did not match the recorded response, and the questions that had one
    unconfirmed_calls: ss.reduce((a, s) => a + s.unconfirmed, 0),
    unconfirmed_questions: ss.filter((s) => s.unconfirmed > 0).length,
    first_call: mean(ss.flatMap((s) => (s.first === null ? [] : [s.first]))),
    calls: mean(ss.map((s) => s.calls)),
    empty_recalls: pct(
      ss.reduce((a, s) => a + s.empty, 0),
      recalls,
    ),
    tool_errors: ss.reduce((a, s) => a + s.errors, 0),
    tool_kib: mean(ss.map((s) => s.bytes / 1024)),
    // Unrounded, for the guardrail (tool_kib is rounded for display)
    tool_kib_mean: ss.reduce((a, s) => a + s.bytes / 1024, 0) / Math.max(ss.length, 1),
    usage,
  };
}
