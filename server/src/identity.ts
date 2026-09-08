// 作業場所が何なのかを、リポジトリを読んで決める。
//
// **人に書かせない。**`mitos describe` で人が一行説明を書く案は棄却されている
// （d-infer-project-identity）— 「明示しないと理解できないのは JARVIS ではない」。
//
// **null のときだけ埋める。**取り込みのたびに作り直すと遅く、リポジトリの説明はほとんど変わらない。
// 古びたら `mitos describe` で人が上書きできる（逃げ道であって既定の経路ではない）。
//
// **書くのは CLI だけ。**MCP と編集フックは読み取り専用の資格情報で動くので、ここは通らない。
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type pg from "pg";
import type { Env } from "./db.ts";
import { HOST } from "./scope.ts";

/** 読む順。**最初に当たったところで止める。**README の無いリポジトリでも必ず何かは読める。 */
const SOURCES = ["README.md", "CLAUDE.md", "AGENTS.md", "package.json"];
const MAX = 6000;

/** そのディレクトリが何なのかを説明していそうな文を 1 つ選ぶ。 */
function material(absPath: string): string | null {
  for (const name of SOURCES) {
    try {
      const body = fs.readFileSync(path.join(absPath, name), "utf8").trim();
      if (body) return `# ${name}\n${body.slice(0, MAX)}`;
    } catch {
      // 次の候補を試す
    }
  }
  try {
    const top = fs
      .readdirSync(absPath, { withFileTypes: true })
      .filter((d) => !d.name.startsWith("."))
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
      .slice(0, 60);
    return top.length ? `# 置いてあるもの\n${top.join("\n")}` : null;
  } catch {
    return null;
  }
}

const PROMPT =
  "次はあるリポジトリの中身の一部です。これが何なのかを日本語で答えてください。\n" +
  '{"role": "...", "summary": "..."} の JSON だけを返すこと。\n' +
  "role: 5〜15 字の名詞句。何であるかを一言で（例: 個人用のナレッジ基盤、社内向けの請求書 API）。\n" +
  "summary: 1〜2 文。何を解く道具かと、誰が使うか。**書いていないことを補わない。**\n" +
  '判断できるだけの材料が無ければ {"role": null, "summary": null} を返すこと。';

export async function inferIdentity(
  env: Env,
  absPath: string,
): Promise<{ role: string; summary: string } | null> {
  if (!env.OPENAI_API_KEY) return null;
  const body = material(absPath);
  if (!body) return null;
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const r = await openai.responses.create({
    model: env.MITOS_IDENTITY_MODEL ?? "gpt-5.6-luna",
    reasoning: { effort: "low" },
    instructions: PROMPT,
    input: body,
  });
  try {
    const o = JSON.parse(r.output_text.replace(/^```json\s*|\s*```$/g, "")) as {
      role?: string | null;
      summary?: string | null;
    };
    if (!o.role || !o.summary) return null;
    return { role: String(o.role).slice(0, 60), summary: String(o.summary).slice(0, 400) };
  } catch {
    // 形が違えば埋めない。**推測で埋めるくらいなら空のままにする。**
    return null;
  }
}

/** 取り込みのついでに、まだ空なら埋める。埋めたときだけ人向けの 1 行を返す。 */
export async function ensureIdentity(c: pg.Client, env: Env, scopeId: number): Promise<string | null> {
  // **置き場所はこのホストのものを引く。**リポジトリを実際に読むので、
  // 別のマシンで登録されたパスを渡しても開けない。
  const r = await c.query<{
    role: string | null;
    summary: string | null;
    label: string;
    abs_path: string | null;
  }>(
    `select s.role, s.summary, s.label, p.abs_path from scope s
     left join scope_path p on p.scope_id = s.id and p.host = $2
     where s.id = $1`,
    [scopeId, HOST],
  );
  const s = r.rows[0];
  if (!s || (s.role && s.summary)) return null;
  if (!s.abs_path || !fs.existsSync(s.abs_path)) return null;
  const got = await inferIdentity(env, s.abs_path);
  if (!got) return null;
  // **人が書いた値を上書きしない。**片方だけ埋まっている場合は、空いている側だけ入る。
  await c.query(
    "update scope set role = coalesce(role, $1), summary = coalesce(summary, $2), updated_at = now() where id = $3",
    [got.role, got.summary, scopeId],
  );
  return `${s.label} を読み取りました: ${got.role} — ${got.summary}`;
}
