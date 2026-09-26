#!/usr/bin/env node
// One experiment: bundle a git ref, pilot 10 questions, run a split 3 times, judge, apply the adoption rule, append to <OUT>/ledger.jsonl.
// Measure the base first (--name base); later experiments reuse its runs. Steps: .claude/rules/evals.md
//   SPHICA_DB=<copy> bun run evals:experiment -- --name k1 --ref <git ref> [--base base] [--split dev] [--budget 10]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SPLITS, type Split } from "../cases.ts";
import { Budget, measure, OUT, type Result, runDir, sha256File } from "./run.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const git = (...args: string[]) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    ref: { type: "string", default: "HEAD" },
    base: { type: "string", default: "base" },
    split: { type: "string", default: "dev" },
    budget: { type: "string", default: "10" },
    model: { type: "string", default: "sonnet" },
    effort: { type: "string" },
    par: { type: "string", default: "4" },
    // A memory-like note loaded at session start (run.ts places it as CLAUDE.md)
    memo: { type: "string" },
  },
});
if (!values.name) throw new Error("--name is required");
const name = values.name;
const split = values.split as Split;
if (!(split in SPLITS)) throw new Error(`--split must be one of ${Object.keys(SPLITS).join(" / ")}`);
// The name goes into worktree and bundle paths below, so it passes the run directory check first
runDir(OUT, name, split);
runDir(OUT, values.base, split);
if (!Number.isInteger(Number(values.par)) || Number(values.par) < 1)
  throw new Error(`--par must be a positive integer (${values.par})`);
// Repeats are stored as <name>-r2 and <name>-r3, so such a name would overwrite another setup's runs
if (/-r\d+$/.test(name)) throw new Error(`--name must not end in -r<n> (${name})`);
const budget = new Budget(Number(values.budget));
const RUNS = 3;
const dirsOf = (config: string) =>
  Array.from({ length: RUNS }, (_, n) =>
    path.join(OUT, n === 0 ? config : `${config}-r${n + 1}`, split),
  ).filter((d) => fs.existsSync(path.join(d, "summary.json")));
// A missing base would leave nothing to compare against, while the ledger still recorded a finished experiment
const complete = (d: string) =>
  (JSON.parse(fs.readFileSync(path.join(d, "summary.json"), "utf8")) as { complete?: boolean }).complete !==
  false;
if (name !== values.base && dirsOf(values.base).filter(complete).length !== RUNS)
  throw new Error(`--base ${values.base} has no complete ${RUNS} runs on ${split}. Measure it first`);

/**
 * Bundles the MCP server of a git ref in its own worktree (bundle.mjs rewrites plugin/dist, so the working tree is never touched)
 * and keeps a copy under <OUT>/bundles/<name>/.
 */
function bundle(ref: string): { mcp: string; commit: string } {
  const commit = git("rev-parse", "--verify", `${ref}^{commit}`);
  const wt = path.join(OUT, "worktrees", name);
  if (fs.existsSync(wt)) git("worktree", "remove", "--force", wt);
  git("worktree", "add", "--detach", wt, commit);
  try {
    const lock = (root: string) => fs.readFileSync(path.join(root, "server", "bun.lock"), "utf8");
    // Same lockfile: reuse the installed packages instead of installing per experiment
    if (lock(wt) === lock(REPO))
      fs.symlinkSync(
        path.join(REPO, "server", "node_modules"),
        path.join(wt, "server", "node_modules"),
        "dir",
      );
    else
      execFileSync("bun", ["install", "--cwd", "server", "--frozen-lockfile"], { cwd: wt, stdio: "inherit" });
    execFileSync("node", ["scripts/bundle.mjs"], { cwd: wt, stdio: "inherit" });
    const dir = path.join(OUT, "bundles", name);
    fs.mkdirSync(dir, { recursive: true });
    const mcp = path.join(dir, "mcp.js");
    fs.copyFileSync(path.join(wt, "plugin", "dist", "mcp.js"), mcp);
    return { mcp, commit };
  } finally {
    git("worktree", "remove", "--force", wt);
  }
}

/** Why a question was not answered first, per run: the answer never came back, came back but was not chosen, or the run failed. */
function missOf(r: Result): string | null {
  if (r.rank === 0) return null;
  if (r.error) return r.error.startsWith("cannot parse") ? "format failure" : "error";
  return r.session?.exposed ? "exposed, not chosen" : "never exposed";
}

const ledger = path.join(OUT, "ledger.jsonl");
const log = (entry: object) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.appendFileSync(ledger, `${JSON.stringify({ at: new Date().toISOString(), name, ...entry })}\n`);
};

const { mcp, commit } = bundle(values.ref);
const common = {
  split,
  model: values.model,
  effort: values.effort,
  par: Number(values.par),
  mcp,
  budget,
  memo: values.memo,
};

// The pilot always uses dev questions, so a holdout gate shows nothing before its verdict
const pilot = await measure({
  ...common,
  split: split.startsWith("message") ? "message-dev" : "dev",
  name: `${name}-pilot`,
  limit: 10,
});
const broken = pilot.results.filter((r) => r.error);
if (broken.length) {
  log({
    commit,
    bundle: sha256File(mcp),
    stopped: "pilot",
    errors: broken.map((r) => `q${r.i}: ${r.error}`),
  });
  throw new Error(`pilot failed on ${broken.length} of ${pilot.results.length} questions (see ${pilot.dir})`);
}

const runs: Awaited<ReturnType<typeof measure>>[] = [];
for (let n = 1; n <= RUNS; n++) {
  const run = await measure({ ...common, name: n === 1 ? name : `${name}-r${n}` });
  runs.push(run);
  if (!run.summary.complete) break;
}

const misses: Record<string, string[]> = {};
for (const run of runs)
  for (const r of run.results) {
    const m = missOf(r);
    if (m) misses[`q${r.i}`] = [...(misses[`q${r.i}`] ?? []), `${m} (${path.join(run.dir, `q${r.i}`)})`];
  }

let verdicts: unknown = null;
if (name !== values.base) {
  const out = path.join(OUT, name, `verdict-${split}.json`);
  execFileSync(
    "node",
    [
      path.join(HERE, "judge.ts"),
      ...dirsOf(values.base),
      ...runs.map((r) => r.dir),
      "--base",
      values.base,
      "--json",
      out,
    ],
    { stdio: "inherit" },
  );
  verdicts = JSON.parse(fs.readFileSync(out, "utf8"));
  if (!Array.isArray(verdicts) || verdicts.length === 0)
    throw new Error(`no verdict against ${values.base}: its runs and ${name}'s differ in split or model`);
}

log({
  commit,
  bundle: sha256File(mcp),
  split,
  runs: runs.map((r) => ({ dir: r.dir, summary: r.summary })),
  spent: Math.round(budget.spent * 100) / 100,
  verdicts,
  misses,
});
console.log(`spent $${budget.spent.toFixed(2)} of $${budget.cap}; ledger: ${ledger}`);
