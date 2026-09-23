#!/usr/bin/env node
// 出荷の plugin/dist/mcp.js を `claude -p` に渡して retrieval.json の問いを解かせる（先に bun run bundle）。
// **実 DB と持ち主のサブスクを使うので verify に入れない。**結果は os.tmpdir()/gleanery-evals/<name>/<split>/ に残る。
//   bun run evals:agentic -- --name base --split dev --model sonnet（同じ構成の繰り返しは base-r2, base-r3 と名付ける）

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openReader } from "../../src/db.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
export const OUT = path.join(os.tmpdir(), "gleanery-evals");

export type Case = { q: string; expect: string[]; kind: string; source: string };
const CASES = fs.readFileSync(path.join(HERE, "../retrieval.json"), "utf8");
export const { cases } = JSON.parse(CASES) as { cases: Case[] };
/** 問いの集合の指紋。retrieval.json を作り直すと split の中身が入れ替わるので、違う集合どうしを比べない */
export const CASES_SHA = crypto.createHash("sha256").update(CASES).digest("hex").slice(0, 16);

// 番号は retrieval.json の cases の添字で、変えない。dev（知識の偶数番）でツールを直し、holdout（奇数番）は
// ゲートの判定でだけ流す（見て直すと、ゲートが改善の途中を測るだけになる）。message は正解が発言の id。
export const SPLITS = {
  dev: (c: Case, i: number) => c.source !== "message" && i % 2 === 0,
  holdout: (c: Case, i: number) => c.source !== "message" && i % 2 === 1,
  message: (c: Case) => c.source === "message",
} as const;
export type Split = keyof typeof SPLITS;

export type Result = {
  i: number;
  q: string;
  kind: string;
  /** 正解の順位（0 始まり）。上位 5 件に無ければ -1 */
  rank: number;
  refs: string[];
  /** refs を正解と同じ鍵（知識は source_key、発言は id）へ直したもの。DB を入れ直しても比べられる */
  keys: (string | null)[];
  turns: number;
  cost: number;
  ms: number;
  /** 実際に使われたモデルの ID と Claude Code のバージョン（trace の init から）。別名（sonnet / opus）の指す先は変わる */
  resolved: { model: string | null; claude: string | null };
  error?: string;
};

const ANSWER = [
  "gleanery の recall と read には all_projects: true を付ける（記録は複数のプロジェクトにまたがる）。",
  '最後の行に {"refs":["k:1","k:2"]} の形の JSON だけを出す（問いに最も直接答える記録を関連の高い順に最大 5 件）。',
].join("\n");

async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: "string", default: "base" },
      split: { type: "string", default: "dev" },
      model: { type: "string", default: "sonnet" },
      // 渡さなければ Claude Code の既定の effort で測る（基準もそうして取った）。既定はバージョンで変わるので、バージョンと一緒に記録する
      effort: { type: "string" },
      par: { type: "string", default: "4" },
    },
  });
  const split = values.split as Split;
  if (!(split in SPLITS)) throw new Error(`--split は ${Object.keys(SPLITS).join(" / ")} のどれか`);
  const mcp = path.join(REPO, "plugin/dist/mcp.js");
  if (!fs.existsSync(mcp)) throw new Error("plugin/dist/mcp.js が無い。先に bun run bundle");

  const run = path.join(OUT, values.name, split);
  fs.rmSync(run, { recursive: true, force: true });
  fs.mkdirSync(run, { recursive: true });
  const keyOf = await keys();

  const todo = cases.map((c, i) => ({ c, i })).filter(({ c, i }) => SPLITS[split](c, i));
  const results: Result[] = [];
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: Number(values.par) }, async () => {
      for (let x = todo.shift(); x; x = todo.shift()) {
        const r = await solve(x.c, x.i, { run, mcp, model: values.model, effort: values.effort, keyOf });
        results.push(r);
        console.error(
          `q${r.i} ${r.rank === 0 ? "✓" : r.rank < 0 ? "✗" : `${r.rank + 1} 位`}${r.error ? ` ${r.error}` : ""}`,
        );
      }
    }),
  );
  results.sort((a, b) => a.i - b.i);
  const summary = summarize(results, {
    name: values.name,
    split,
    model: values.model,
    // --effort が無ければ、環境変数、それも無ければモデルの既定（2.1.280 では Sonnet 5 は high、Opus 5.5 は medium）で決まる。
    // プロジェクトは一時ディレクトリなので、repository の設定の effortLevel は読まれない
    effort:
      values.effort ??
      (process.env.CLAUDE_CODE_EFFORT_LEVEL ? `環境変数 ${process.env.CLAUDE_CODE_EFFORT_LEVEL}` : "既定"),
    cases: CASES_SHA,
    ms: Date.now() - t0,
  });
  fs.writeFileSync(path.join(run, "summary.json"), JSON.stringify({ ...summary, results }, null, 1));
  console.log(JSON.stringify(summary));
  for (const r of results)
    if (r.rank !== 0)
      console.log(
        `  ${r.rank < 0 ? "圏外" : `${r.rank + 1} 位`} [${r.kind}] q${r.i} ${r.q}${r.error ? ` (${r.error})` : ""}`,
      );
  console.log(`結果: ${run}`);
}

/** ref から正解と同じ鍵へ。id では突き合わせない（入れ直しで変わる）。発言は id がそのまま鍵。 */
async function keys(): Promise<(ref: string) => string | null> {
  const db = openReader();
  try {
    const rows = await db.selectFrom("knowledge").select(["id", "source_key"]).execute();
    const byRef = new Map(rows.map((r) => [`k:${r.id}`, r.source_key]));
    return (ref) => (ref.startsWith("m:") ? ref.slice(2) : (byRef.get(ref) ?? null));
  } finally {
    await db.destroy();
  }
}

async function solve(
  c: Case,
  i: number,
  o: {
    run: string;
    mcp: string;
    model: string;
    effort: string | undefined;
    keyOf: (ref: string) => string | null;
  },
): Promise<Result> {
  const dir = path.join(o.run, `q${i}`);
  fs.mkdirSync(dir);
  // 作業ディレクトリは repository でも ~/.gleanery でもない空の場所にする。持ち主の CLAUDE.md・plugin・hook を
  // 読ませると、測るのが出荷のツールではなく持ち主の設定になる（hook は自動記録まで走らせる）。
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-evals-cwd-"));
  const config = path.join(dir, "mcp.json");
  // 評価用に写した DB を測るときは GLEANERY_DB で指す。MCP へ明示して渡す（親の環境が届くかに頼らない）。
  const env = process.env.GLEANERY_DB ? { GLEANERY_DB: process.env.GLEANERY_DB } : undefined;
  fs.writeFileSync(
    config,
    JSON.stringify({ mcpServers: { gleanery: { command: "node", args: [o.mcp], env } } }),
  );
  const t0 = Date.now();
  try {
    const events = await claude(
      [
        "-p",
        `${c.q}\n\n${ANSWER}`,
        "--model",
        o.model,
        ...(o.effort ? ["--effort", o.effort] : []),
        "--setting-sources",
        "project",
        "--strict-mcp-config",
        "--mcp-config",
        config,
        "--tools",
        "",
        "--allowedTools",
        "mcp__gleanery__recall,mcp__gleanery__read",
        // stream-json はツールの呼び出しを 1 行ずつ出す。json では最後の応答しか残らず、なぜ外したかを追えない
        "--output-format",
        "stream-json",
        "--verbose",
        // 付けないと ~/.claude/projects/ に 1 問 1 つずつセッションが溜まる（実験で 379 個できた）
        "--no-session-persistence",
      ],
      cwd,
    );
    fs.writeFileSync(path.join(dir, "trace.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
    const last = events.findLast((e) => e.type === "result");
    const init = events.find((e) => e.type === "system" && e.subtype === "init");
    const refs = refsOf(String(last?.result ?? ""));
    const keys = (refs ?? []).map(o.keyOf);
    const res: Result = {
      i,
      q: c.q,
      kind: c.kind,
      rank: keys.findIndex((k) => k !== null && c.expect.includes(k)),
      refs: refs ?? [],
      keys,
      turns: Number(last?.num_turns ?? 0),
      cost: Number(last?.total_cost_usd ?? 0),
      ms: Date.now() - t0,
      resolved: {
        model: typeof init?.model === "string" ? init.model : null,
        claude: typeof init?.claude_code_version === "string" ? init.claude_code_version : null,
      },
      ...(last === undefined || last.is_error
        ? { error: String(last?.result ?? "応答が無い").slice(0, 200) }
        : refs === null
          ? { error: "最後の refs の JSON が読めない（書式の失敗で、検索の外れではない）" }
          : {}),
    };
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(res, null, 1));
    return res;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

type Event = { type?: string; [k: string]: unknown };

// --no-session-persistence でも、cwd ごとに ~/.claude/projects/<cwd>/memory/ が作られる（実測: 42 問で 42 個）
export const CLAUDE_ENV = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };

function claude(args: string[], cwd: string): Promise<Event[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, env: CLAUDE_ENV, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
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
      if (!events.some((e) => e.type === "result"))
        events.push({
          type: "result",
          is_error: true,
          result: `claude が ${code} で終わった: ${err.slice(0, 300)}`,
        });
      resolve(events);
    });
  });
}

/** 最後の行の `{"refs":[...]}`。途中の例示を拾わないよう最後の一致を使う。読めなければ null */
export function refsOf(text: string): string[] | null {
  const m = [...text.matchAll(/\{\s*"refs"\s*:\s*\[[^\]]*\]\s*\}/g)].pop();
  if (!m) return null;
  try {
    return (JSON.parse(m[0]).refs as unknown[]).filter((r): r is string => typeof r === "string").slice(0, 5);
  } catch {
    return null;
  }
}

export function summarize(
  results: Result[],
  meta: { name: string; split: string; model: string; effort: string; cases: string; ms: number },
) {
  const n = results.length;
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
    cost_usd_list: Math.round(results.reduce((s, r) => s + r.cost, 0) * 100) / 100,
    minutes: Math.round(meta.ms / 6000) / 10,
    errors: results.filter((r) => r.error).length,
    resolved_models: distinct(results.map((r) => r.resolved?.model ?? null)),
    claude_code: distinct(results.map((r) => r.resolved?.claude ?? null)),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
