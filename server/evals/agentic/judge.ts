#!/usr/bin/env node
// Has Opus grade each setup's top hit and the eval answer blind to their source. Each question has one answer key, which would count other records with the same content as misses.
// Grades are cached per (question, source_key, hash of judge model, prompt, and body). **Never keyed by id** (ids change on reimport).
//   bun run evals:judge -- <run result dir or baseline.json> ... [--out server/evals/agentic/baseline.json]

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openReader } from "../../src/db.ts";
import { CASES_SHA, CLAUDE_ENV, cases, OUT, type Result, type summarize } from "./run.ts";

type Grade = "direct" | "partial" | "no";
type Row = {
  kind: string;
  status: string | null;
  heading: string | null;
  body: string;
  reason: string | null;
};
/** slot fingerprints a graded pair (source_key, judge model, prompt version, body). Any change triggers a new grade */
type Top = { i: number; rank: number; key: string | null; grade?: Grade; slot?: string };
type System = { summary: ReturnType<typeof summarize>; top: Top[] };
type Baseline = {
  cases: string;
  runs: System[];
  answers: { i: number; key: string; grade?: Grade; slot?: string }[];
};

// Bump when the judge prompt changes (so old grades are not read from the cache)
const PROMPT_VERSION = 1;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(OUT, "judge");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    model: { type: "string", default: "opus" },
    par: { type: "string", default: "4" },
  },
});
if (positionals.length === 0)
  throw new Error("pass a run result dir (os.tmpdir()/gleanery-evals/<name>/<split>) or baseline.json");
fs.mkdirSync(CACHE, { recursive: true });

const db = openReader();
const rows = await db
  .selectFrom("knowledge")
  .select(["source_key", "kind", "status", "heading", "body", "reason"])
  .execute();
const counted = rows.length;
await db.destroy();
// Part of the judge prompt and the slot hash. Translating it would invalidate cached and baseline grades.
const text = (r: Row) =>
  `種類: ${r.kind}${r.status ? `/${r.status}` : ""}\n見出し: ${r.heading ?? ""}\n本文: ${r.body.slice(0, 1500)}${r.reason ? `\n理由: ${r.reason.slice(0, 400)}` : ""}`;
const byKey = new Map<string, Row>(rows.map((r) => [r.source_key, r]));
const slotOf = (key: string): string | undefined => {
  const r = byKey.get(key);
  if (!r) return undefined;
  const h = crypto.createHash("sha256").update(`${PROMPT_VERSION}\0${values.model}\0${text(r)}`);
  return `${key}@${h.digest("hex").slice(0, 12)}`;
};
const gradeOf = (i: number, key: string | null | undefined): Grade | undefined => {
  const slot = key ? slotOf(key) : undefined;
  return slot ? cached(i)[slot] : undefined;
};

const cache = new Map<number, Record<string, Grade>>();
const cacheFile = (i: number) => path.join(CACHE, `q${i}.json`);
function cached(i: number): Record<string, Grade> {
  let g = cache.get(i);
  if (g) return g;
  g = {};
  const f = cacheFile(i);
  if (fs.existsSync(f)) {
    const saved = JSON.parse(fs.readFileSync(f, "utf8")) as { q: string; grades: Record<string, Grade> };
    // A changed question text means a different question, so skip it
    if (saved.q === cases[i]?.q) g = saved.grades;
  }
  cache.set(i, g);
  return g;
}
function remember(i: number, key: string, grade: Grade) {
  const g = cached(i);
  g[key] = grade;
  fs.writeFileSync(cacheFile(i), JSON.stringify({ q: cases[i]?.q, grades: g }, null, 1));
}

const systems: System[] = [];
const fromBaseline = new Set<System>();
for (const src of positionals) {
  if (src.endsWith(".json")) {
    const b = JSON.parse(fs.readFileSync(src, "utf8")) as Baseline;
    if (b.cases !== CASES_SHA)
      throw new Error(
        `${src} was measured with a different retrieval.json (${b.cases}) and cannot be compared`,
      );
    // Baseline grades are reused only for the same judge model, prompt, and body (matching slot)
    const seed = (i: number, key: string | null, grade?: Grade, slot?: string) => {
      if (key && grade && slot && slot === slotOf(key) && !cached(i)[slot]) remember(i, slot, grade);
    };
    for (const s of b.runs) {
      systems.push(s);
      fromBaseline.add(s);
      for (const t of s.top) seed(t.i, t.key, t.grade, t.slot);
    }
    for (const a of b.answers) seed(a.i, a.key, a.grade, a.slot);
    continue;
  }
  const s = JSON.parse(fs.readFileSync(path.join(src, "summary.json"), "utf8")) as ReturnType<
    typeof summarize
  > & {
    results: Result[];
  };
  const { results, ...summary } = s;
  if (summary.cases !== CASES_SHA)
    throw new Error(`${src} was measured with a different retrieval.json and cannot be compared`);
  systems.push({ summary, top: results.map((r) => ({ i: r.i, rank: r.rank, key: r.keys[0] ?? null })) });
}
const questions = [...new Set(systems.flatMap((s) => s.top.map((t) => t.i)))].sort((a, b) => a - b);

async function judge(i: number) {
  const c = cases[i];
  if (!c) return;
  const keys = [...new Set([...systems.map((s) => s.top.find((t) => t.i === i)?.key), c.expect[0]])].filter(
    (k): k is string => !!k && byKey.has(k) && !gradeOf(i, k),
  );
  if (keys.length === 0) return;
  // Hide the source (which setup's top hit, or the answer) and shuffle the order every time.
  // The prompt is part of the measurement (PROMPT_VERSION), so it stays as written
  keys.sort(() => Math.random() - 0.5);
  const labels = keys.map((_, n) => String.fromCharCode(65 + n));
  const out = await claude(
    [
      "開発記録の検索の評価。問いと、候補の記録がある。各候補が問いに答えているかを、候補ごとに独立に判定する。",
      "direct: 問いが聞いていることに直接答えている。partial: 関係はあるが、問いの核心（どの判断・どの理由・どの手順か）には答えていない。no: 答えていない。",
      "同じ内容に直接答える記録が複数あれば、どれも direct にしてよい。",
      "",
      `問い: ${c.q}`,
      "",
      ...keys.map((k, n) => `候補 ${labels[n]}:\n${text(byKey.get(k) as Row)}\n`),
      `最後の行に {"A":"direct","B":"no"} の形の JSON だけを出す（候補 ${labels.join("・")} すべて）。`,
    ].join("\n"),
  );
  const m = [...out.matchAll(/\{[^{}]*\}/g)].pop();
  let g: Record<string, unknown> = {};
  try {
    g = m ? JSON.parse(m[0]) : {};
  } catch {}
  keys.forEach((k, n) => {
    const v = g[labels[n] as string];
    const slot = slotOf(k);
    if (slot && (v === "direct" || v === "partial" || v === "no")) remember(i, slot, v);
  });
  console.error(`q${i} graded ${keys.length}`);
}

/** Model ids that graded in this run (`--model` is an alias whose target changes by version). Cached grades do not count */
const judgedBy = new Set<string>();

function claude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--model",
        values.model,
        "--setting-sources",
        "project",
        "--tools",
        "",
        // Keep out the owner's claude.ai connectors (which include write tools). The graded text is untrusted
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--output-format",
        "json",
        "--no-session-persistence",
      ],
      { cwd: CACHE, env: CLAUDE_ENV, stdio: ["ignore", "pipe", "ignore"] },
    );
    const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out) as { result?: unknown; modelUsage?: Record<string, unknown> };
        for (const m of Object.keys(j.modelUsage ?? {})) judgedBy.add(m);
        resolve(String(j.result ?? ""));
      } catch {
        resolve("");
      }
    });
  });
}

const pool = [...questions];
await Promise.all(
  Array.from({ length: Number(values.par) }, async () => {
    for (let i = pool.shift(); i !== undefined; i = pool.shift()) await judge(i);
  }),
);

if (judgedBy.size > 1)
  console.log(`⚠ grades in this run came from more than one model: ${[...judgedBy].join(", ")}`);
console.log(`judge model: ${judgedBy.size ? [...judgedBy].join(", ") : "no new grades (all from cache)"}`);
const pct = (a: number, b: number) => Math.round((a / Math.max(b, 1)) * 1000) / 10;
const answers = questions.flatMap((i) => {
  const key = cases[i]?.expect[0];
  return key ? [{ i, key, grade: gradeOf(i, key), slot: slotOf(key) }] : [];
});
const graded = answers.filter((a) => a.grade);
console.log(
  `grades of the eval answers themselves: direct ${pct(graded.filter((a) => a.grade === "direct").length, graded.length)}% / partial ${graded.filter((a) => a.grade === "partial").length} / no ${graded.filter((a) => a.grade === "no").length} (${graded.length} questions)`,
);
const withGrades = (s: System): System => ({
  ...s,
  top: s.top.map(({ grade: _, slot: __, ...t }) => {
    const grade = gradeOf(t.i, t.key);
    return grade && t.key ? { ...t, grade, slot: slotOf(t.key) } : t;
  }),
});
const runs = systems.map(withGrades);
const origin = new Map(
  systems.map((s, n) => [runs[n] as System, fromBaseline.has(s) ? "baseline" : "current"]),
);
const rowsOut = runs.map((s) => {
  const n = s.top.length;
  return {
    setup: `${origin.get(s)} ${s.summary.name} / ${s.summary.split} / ${s.summary.model}`,
    questions: n,
    "answer top1": `${s.summary.top1}%`,
    "recall@5": `${s.summary.recall5}%`,
    "graded direct": `${pct(s.top.filter((t) => t.grade === "direct").length, n)}%`,
    "direct+partial": `${pct(s.top.filter((t) => t.grade === "direct" || t.grade === "partial").length, n)}%`,
    ungraded: s.top.filter((t) => !t.grade).length,
    turns: s.summary.turns,
  };
});
console.table(rowsOut);

// Even the same setup moves 7 of 42 questions per run (measured 2026-09-23). The gate compares means per setup (name without -rN), split, and model
const configOf = (s: System) => s.summary.name.replace(/-r\d+$/, "");
const groups = Map.groupBy(
  runs,
  (s) => `${origin.get(s)} ${configOf(s)} ${s.summary.split} ${s.summary.model}`,
);
const mean = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)) * 10) / 10;
const means = [...groups].map(([name, ss]) => ({
  name,
  config: ss[0] ? configOf(ss[0]) : "",
  split: ss[0]?.summary.split,
  model: ss[0]?.summary.model,
  runs: ss.length,
  top1: mean(ss.map((s) => s.summary.top1)),
  recall5: mean(ss.map((s) => s.summary.recall5)),
  direct: mean(ss.map((s) => pct(s.top.filter((t) => t.grade === "direct").length, s.top.length))),
}));
console.table(
  Object.fromEntries(
    means.map((m) => [
      m.name,
      {
        runs: m.runs,
        "answer top1": `${m.top1}%`,
        "recall@5": `${m.recall5}%`,
        "graded direct": `${m.direct}%`,
      },
    ]),
  ),
);

// **Whether the conditions match.** Alias targets (sonnet / opus) and Claude Code's default effort change by version. If they differ,
// the gap may come from the model or effort rather than the tools (on 2026-09-23 Opus 5.5 became the default and the default effort changed).
const conditionOf = (s: System) => {
  const x = s.summary as Partial<ReturnType<typeof summarize>>;
  return `model ${(x.resolved_models ?? ["not recorded"]).join(", ")} / Claude Code ${(x.claude_code ?? ["not recorded"]).join(", ")} / effort ${x.effort ?? "not recorded"}`;
};
for (const [key, ss] of Map.groupBy(runs, (s) => `${s.summary.split} ${s.summary.model}`)) {
  const seen = [...new Set(ss.map(conditionOf))];
  if (seen.length > 1)
    console.log(
      `⚠ ${key} runs differ in conditions (the gap may come from the model or effort):\n  ${seen.join("\n  ")}`,
    );
}

if (values.out) {
  const version = JSON.parse(
    fs.readFileSync(path.join(HERE, "../../../plugin/package.json"), "utf8"),
  ).version;
  // Do not write back the runs from the given baseline.json (the baseline is built only from new runs)
  const fresh = runs.filter((s) => origin.get(s) === "current");
  const baseline = {
    note: "Baseline for the PR gate. Top hits are stored by source_key (ids change on reimport). runs[].top[].grade is a blind grade; a missing grade means the question returned no top hit or returned a message (m:), and is not counted as direct. slot fingerprints the graded pair. The gate compares means (averages per setup, split, and model)",
    measured_at: new Date().toLocaleDateString("sv-SE"),
    gleanery: version,
    cases: CASES_SHA,
    prompt_version: PROMPT_VERSION,
    knowledge: counted,
    judge_model: values.model,
    judge_resolved: [...judgedBy],
    means: means.filter((m) => m.name.startsWith("current")).map(({ name: _, ...m }) => m),
    runs: fresh,
    answers,
  };
  fs.writeFileSync(values.out, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`wrote: ${values.out}`);
}
