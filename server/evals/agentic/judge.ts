#!/usr/bin/env node
// 各構成の 1 位と eval の正解を、出所を伏せて Opus に判定させる。正解の鍵は各問 1 つで、同じ内容に答える別の記録を外れにするため。
// 判定は (問い, source_key, 判定モデル・プロンプト・本文の hash) ごとにキャッシュする。**id で持たない**（DB を入れ直すと変わる）。
//   bun run evals:judge -- <run の結果の dir か baseline.json> ... [--out server/evals/agentic/baseline.json]

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadEnv, open } from "../../src/db.ts";
import { CASES_SHA, CLAUDE_ENV, cases, OUT, type Result, type summarize } from "./run.ts";

type Grade = "direct" | "partial" | "no";
type Row = {
  kind: string;
  status: string | null;
  heading: string | null;
  body: string;
  reason: string | null;
};
/** slot は判定した組の指紋（source_key・判定モデル・プロンプトの版・本文）。どれかが変われば判定し直す */
type Top = { i: number; rank: number; key: string | null; grade?: Grade; slot?: string };
type System = { summary: ReturnType<typeof summarize>; top: Top[] };
type Baseline = {
  cases: string;
  runs: System[];
  answers: { i: number; key: string; grade?: Grade; slot?: string }[];
};

// 判定のプロンプトを変えたら上げる（古い判定をキャッシュから引かないため）
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
  throw new Error("run の結果の dir（os.tmpdir()/gleanery-evals/<name>/<split>）か baseline.json を渡す");
fs.mkdirSync(CACHE, { recursive: true });

const db = open(loadEnv(), "reader");
const rows = await db
  .selectFrom("gleanery.knowledge")
  .select(["source_key", "kind", "status", "heading", "body", "reason"])
  .execute();
const counted = rows.length;
await db.destroy();
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
    // 問いの文が変わっていれば別の問いなので使わない
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
      throw new Error(`${src} は別の retrieval.json（${b.cases}）で測った。比べられない`);
    // 基準の判定は、同じ判定モデル・プロンプト・本文のときだけ使う（slot が一致する）
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
  if (summary.cases !== CASES_SHA) throw new Error(`${src} は別の retrieval.json で測った。比べられない`);
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
  // 出所（どの構成の 1 位か、正解か）を伏せ、順番も毎回混ぜる
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
  console.error(`q${i} 判定 ${keys.length} 件`);
}

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
        // 持ち主の claude.ai コネクタ（書き込みの道具を含む）を読ませない。判定に渡す本文は untrusted
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
        resolve(String(JSON.parse(out).result ?? ""));
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

const pct = (a: number, b: number) => Math.round((a / Math.max(b, 1)) * 1000) / 10;
const answers = questions.flatMap((i) => {
  const key = cases[i]?.expect[0];
  return key ? [{ i, key, grade: gradeOf(i, key), slot: slotOf(key) }] : [];
});
const graded = answers.filter((a) => a.grade);
console.log(
  `eval の正解そのものの判定: direct ${pct(graded.filter((a) => a.grade === "direct").length, graded.length)}% / partial ${graded.filter((a) => a.grade === "partial").length} / no ${graded.filter((a) => a.grade === "no").length}（${graded.length} 問）`,
);
const withGrades = (s: System): System => ({
  ...s,
  top: s.top.map(({ grade: _, slot: __, ...t }) => {
    const grade = gradeOf(t.i, t.key);
    return grade && t.key ? { ...t, grade, slot: slotOf(t.key) } : t;
  }),
});
const runs = systems.map(withGrades);
const origin = new Map(systems.map((s, n) => [runs[n] as System, fromBaseline.has(s) ? "基準" : "今回"]));
const rowsOut = runs.map((s) => {
  const n = s.top.length;
  return {
    構成: `${origin.get(s)} ${s.summary.name} / ${s.summary.split} / ${s.summary.model}`,
    問: n,
    "鍵の top1": `${s.summary.top1}%`,
    "recall@5": `${s.summary.recall5}%`,
    "判定 direct": `${pct(s.top.filter((t) => t.grade === "direct").length, n)}%`,
    "direct+partial": `${pct(s.top.filter((t) => t.grade === "direct" || t.grade === "partial").length, n)}%`,
    未判定: s.top.filter((t) => !t.grade).length,
    手数: s.summary.turns,
  };
});
console.table(rowsOut);

// 同じ構成でも 1 回ごとに 42 問中 7 問動く（2026-09-23 実測）。ゲートは構成（名前の -rN を除く）・split・モデルごとの平均で比べる
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
      { 回数: m.runs, "鍵の top1": `${m.top1}%`, "recall@5": `${m.recall5}%`, "判定 direct": `${m.direct}%` },
    ]),
  ),
);

if (values.out) {
  const version = JSON.parse(
    fs.readFileSync(path.join(HERE, "../../../plugin/package.json"), "utf8"),
  ).version;
  // 渡した baseline.json の分は書き戻さない（新しく流した run だけで基準を作る）
  const fresh = runs.filter((s) => origin.get(s) === "今回");
  const baseline = {
    note: "PR のゲートで比べる基準。1 位は source_key で持つ（id は DB の入れ直しで変わる）。runs[].top[].grade は盲検の判定で、無いものは 1 位を返さなかったか発言（m:）を返した問い（direct に数えない）。slot は判定した組の指紋。ゲートは means（構成・split・モデルごとの平均）で比べる",
    measured_at: new Date().toLocaleDateString("sv-SE"),
    gleanery: version,
    cases: CASES_SHA,
    prompt_version: PROMPT_VERSION,
    knowledge: counted,
    judge_model: values.model,
    means: means.filter((m) => m.name.startsWith("今回")).map(({ name: _, ...m }) => m),
    runs: fresh,
    answers,
  };
  fs.writeFileSync(values.out, `${JSON.stringify(baseline, null, 1)}\n`);
  console.log(`書いた: ${values.out}`);
}
