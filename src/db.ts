// DB と Voyage への接続。**資格情報はここでしか読まない。**
//
// 書き込みは CLI だけが行い、MCP は読み取り専用で繋ぐ。
// 推論する層と資格情報を持つ層を分けるため（rules/ai-agent-security.md）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Env = Record<string, string | undefined>;

// 資格情報の置き場所。**どのプロジェクトからでも同じものを指せる必要がある。**
// 作業ディレクトリから上へ .env を探すだけだと、別のリポジトリで作業したときに見つからない。
export const GLOBAL_ENV = path.join(os.homedir(), ".claude", "knowledge.env");

function readInto(out: Env, file: string): boolean {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m?.[1] && !process.env[m[1]] && out[m[1]] === undefined) {
      out[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "").trim();
    }
  }
  return true;
}

/**
 * 探索順: プロセスの環境変数 → KNOWLEDGE_ENV_DIR/.env → ~/.claude/knowledge.env
 *
 * **作業ディレクトリから上へ .env を探さない。**フックは Edit/Write のたびに、編集中の
 * プロジェクトを cwd として起動する。そこを探すと、他人のリポジトリがコミットした .env が
 * 接続先の候補になる。資格情報の出所は、この 2 つだけに固定する。
 */
export function loadEnv(_from?: string): Env {
  const out: Env = { ...process.env };
  if (process.env.KNOWLEDGE_ENV_DIR) readInto(out, path.join(process.env.KNOWLEDGE_ENV_DIR, ".env"));
  readInto(out, GLOBAL_ENV);
  return out;
}

// Supabase の pooler は Supabase Root 2021 CA が発行した証明書を出すので、公開 CA では検証できない。
// 検証を切ると、経路を握った相手が返した行がそのままフックの additionalContext と MCP の応答になる。
const CA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "certs", "prod-ca-2021.crt");
let ca: string | null = null;

export async function connect(env: Env): Promise<pg.Client> {
  const raw = env.SUPABASE_DB_URL;
  if (!raw) {
    throw new Error("SUPABASE_DB_URL が無い。~/.claude/knowledge.env に Session pooler の接続文字列を入れる");
  }
  ca ??= fs.readFileSync(CA_PATH, "utf8");

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // **元の文字列を例外へ乗せない。**URL の TypeError は err.input に入力全体を持ち、
    // Node は未捕捉例外でその自前プロパティも印字する。接続文字列にはパスワードが入っている。
    throw new Error("SUPABASE_DB_URL が URL として読めない（値は伏せる）");
  }

  // 接続文字列側の指定は pg の中で ssl オプションより後に効く。`?ssl=0` の 5 文字で
  // TLS が丸ごと消え、`?sslrootcert=` は固定した CA を差し替える（実測で再現した）。
  // sslmode だけを弾いても足りないので、**接続文字列そのものを pg へ渡さない。**
  // 接続先の指定だけを取り出し、TLS はここで決める。
  const bad = ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey"].filter((k) => u.searchParams.has(k));
  if (bad.length) {
    throw new Error(
      `SUPABASE_DB_URL の ${bad.join(" / ")} は使えない。TLS はコード側で固定している。この指定を消す`,
    );
  }

  const client = new pg.Client({
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, "") || "postgres",
    ssl: { ca, rejectUnauthorized: true },
  });
  await client.connect();
  // HNSW の既定は絞り込みを効かせると結果が LIMIT を下回る。
  // set local はトランザクションの外では次の文へ残らないので、セッションで 1 回入れる。
  await client.query("set hnsw.iterative_scan = relaxed_order");
  // アイドル中の切断は 'error' として飛んでくる。リスナが無いと uncaughtException になり、
  // クエリを投げていなくても長命のサーバーが落ちる。
  client.on("error", () => {});
  return client;
}

const VOYAGE = "https://api.voyageai.com/v1/embeddings";
export const EMBED_MODEL = "voyage-4-large";

/**
 * 埋め込みを取る。**input_type を省略しない。**
 * Voyage の FAQ が "Do not omit input_type or set input_type=None" と名指しで禁じており、
 * query と document で前置プロンプトが変わる。
 */
export async function embed(env: Env, texts: string[], inputType: "query" | "document"): Promise<number[][]> {
  if (!env.VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY が無い");
  if (texts.length === 0) return [];

  const out: number[][] = [];
  // 3M TPM が voyage-4-large の上限。1 回に詰めすぎない。
  for (let i = 0; i < texts.length; i += 96) {
    const batch = texts.slice(i, i + 96);
    const res = await fetch(VOYAGE, {
      // 取り込みは begin の中でここを呼ぶ。詰まった分だけ行のロックを持ち続けるので、
      // 呼び出し側の都合ではなくここで切る。
      signal: AbortSignal.timeout(30_000),
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.VOYAGE_API_KEY}` },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: batch,
        input_type: inputType,
        output_dimension: 1024, // pgvector の HNSW は 2000 次元まで。1024 なら索引が張れる
        output_dtype: "float",
      }),
    });
    if (!res.ok) throw new Error(`Voyage が ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    for (const d of json.data.sort((a, b) => a.index - b.index)) out.push(d.embedding);
  }
  return out;
}

/** pgvector のリテラル。 */
export const vec = (a: number[] | null | undefined): string | null => (a ? `[${a.join(",")}]` : null);
