// DB と Voyage への接続。**資格情報はここでしか読まない。**
//
// ナレッジの書き込みは CLI と GitHub worker だけが行い、MCP は読み取り専用で繋ぐ。
// 推論する層と資格情報を持つ層を分けるため（rules/ai-agent-security.md）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

// **CA を同梱しない。**繋ぎ先はマネージドの PostgreSQL で、公開 CA の証明書を出す。
// Node の既定の信頼ストアをそのまま使うと `NODE_EXTRA_CA_CERTS` も効く
// （`tls.rootCertificates` を明示すると、あれは固定の一覧なので追加が落ちる。
// 実測: 120 件のまま増えない）。
//
// **`rejectUnauthorized` は切らない** — 検証を切ると、経路を握った相手が返した行が
// そのままフックの additionalContext と MCP の応答になる。
/**
 * @param as どの鍵で繋ぐか。
 *   read   = MCP・フック・画面の読み取り（SELECT だけ）
 *   config = 画面の設定（scope / group / GitHub App の接続だけ書ける）
 *   github = GitHub worker（GitHub由来の記録と同期状態だけ書ける）
 *   admin  = 取り込み CLI（全部）
 */
/** クエリを投げられるもの。**接続 1 本を占有する必要がある処理は `pg.Client` のままにする** — トランザクションはプール越しには張れない。 */
export type Db = Pick<pg.Client, "query">;

/** どの鍵で繋ぐか。 */
type As = "admin" | "read" | "config" | "github";

/**
 * 接続の設定を 1 つにまとめる。**`connect()` と `pool()` の両方がここを通る。**
 * 分けて書くと、TLS の固定と接続文字列の検査が片方だけ緩む。
 */
function settings(env: Env, as: As): pg.ClientConfig {
  // 鍵を用途で分ける。用意されていない環境では管理側へ落ちる（設定していなくても動くように）。
  // **推論する層は、管理側の鍵へ落とさない。**落ちると MCP・フック・画面の API が
  // 「全部書ける鍵」を持つことになり、ロールを分けた意味が消える
  // （20260906120000_readonly_role_for_mcp.sql）。落とさないと決めたので、
  // セッションを読み取り専用にする迂回も要らなくなる。
  // **read だけでなく config も落とさない。**画面の設定書き込みが管理鍵になると、
  // 「chat / term / group しか書けない」前提が消えて `record` と `node` まで書ける。
  // 手元は knowledge.env を丸ごと持つので踏まないが、**デプロイ先は 1 変数ずつ手で入れる**ので、
  // CFG を入れ忘れただけでインターネット向けの API が全部書ける鍵を持つ。
  const named =
    as === "read"
      ? env.KNOWLEDGE_DB_URL_RO
      : as === "config"
        ? env.KNOWLEDGE_DB_URL_CFG
        : as === "github"
          ? env.KNOWLEDGE_DB_URL_GITHUB
          : undefined;
  if (as !== "admin" && !named) {
    const key =
      as === "read"
        ? "KNOWLEDGE_DB_URL_RO"
        : as === "config"
          ? "KNOWLEDGE_DB_URL_CFG"
          : "KNOWLEDGE_DB_URL_GITHUB";
    throw new Error(
      `${key} が無い。管理側の鍵へは落とさない（MCP・編集フック・画面の API・GitHub worker）。` +
        "~/.claude/knowledge.env か、デプロイ先の環境変数に入れる",
    );
  }
  const raw = named ?? env.KNOWLEDGE_DB_URL;
  if (!raw) {
    throw new Error("KNOWLEDGE_DB_URL が無い。~/.claude/knowledge.env に接続文字列を入れる");
  }

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // **元の文字列を例外へ乗せない。**URL の TypeError は err.input に入力全体を持ち、
    // Node は未捕捉例外でその自前プロパティも印字する。接続文字列にはパスワードが入っている。
    throw new Error("KNOWLEDGE_DB_URL が URL として読めない（値は伏せる）");
  }

  // 接続文字列側の指定は pg の中で ssl オプションより後に効く。`?ssl=0` の 5 文字で
  // TLS が丸ごと消え、`?sslrootcert=` は固定した CA を差し替える（実測で再現した）。
  // sslmode だけを弾いても足りないので、**接続文字列そのものを pg へ渡さない。**
  // 接続先の指定だけを取り出し、TLS はここで決める。
  const bad = ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey"].filter((k) => u.searchParams.has(k));
  if (bad.length) {
    throw new Error(
      `KNOWLEDGE_DB_URL の ${bad.join(" / ")} は使えない。TLS はコード側で固定している。この指定を消す`,
    );
  }

  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, "") || "postgres",
    ssl: { rejectUnauthorized: true },
  };
}

// **繋ぎ先に PgBouncer（Neon の `-pooler` 付きホスト）を使わない。**下の 2 つはセッション変数で、
// トランザクションプーリングでは文ごとに別のサーバー接続へ振られて落ちる。
// 実測（同時 8 本 x 25 回 = 200 回、2 巡）: pooled は search_path が 19 / 29 回消え、
// `<#>` が 24 / 35 回「operator does not exist」で失敗した。direct は 2 巡とも 0 / 200。
// **ここでプールするのはクライアント側で、接続 1 本 = セッション 1 つは保たれる。**
//
// **search_path をロール任せにしない。**pgvector は `extensions` スキーマに置いてある。
// ロールごとの既定 search_path にそれが入る保証は無いので、`<#>` を使う
// 読み取り専用ロールだけ「operator does not exist」で落ちる（実測）。
//
// HNSW の既定は絞り込みを効かせると結果が LIMIT を下回る。
// set local はトランザクションの外では次の文へ残らないので、セッションで 1 回入れる。
const SESSION = "set search_path = public, extensions; set hnsw.iterative_scan = relaxed_order";

export async function connect(env: Env, { as = "admin" }: { as?: As } = {}): Promise<pg.Client> {
  const client = new pg.Client(settings(env, as));
  await client.connect();
  await client.query(SESSION);
  // アイドル中の切断は 'error' として飛んでくる。リスナが無いと uncaughtException になり、
  // クエリを投げていなくても長命のサーバーが落ちる。
  client.on("error", () => {});
  return client;
}

/**
 * 長命のプロセス（画面の API と MCP）が使う接続。
 *
 * **1 本を共有しない。**同時に来た 2 本目以降は pg が 1 本のキューへ積み、
 * その挙動は pg@9 で無くなる（実測: 8.23 が DeprecationWarning を出す）。
 * ツール呼び出しも画面の読み込みも同時に来るので、重なるのは例外ではなく普通の状態である。
 *
 * **セッション変数は `verify` で張る。**`on("connect")` だと `set` がキューに残ったまま
 * 借り手へ渡り、同じ警告を踏む。`verify` は新しい接続にだけ走り、
 * `done` を呼ぶまで借り手へ渡さない（`pg-pool/index.js` の `_acquireClient`）。
 */
export function pool(env: Env, { as = "admin" }: { as?: As } = {}): pg.Pool {
  const p = new pg.Pool({
    ...settings(env, as),
    // **Neon の接続枠を食い潰さない。**Vercel は実体を複数持つので、1 実体あたりの上限が要る。
    max: 5,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: true,
    verify: (client, done) => {
      // **借りている間の切断を、プロセスごと落とさない。**pg は切断でクエリを reject した
      // 後に `emit("error")` まで行う（`pg/lib/client.js` の `_handleErrorEvent`）。
      // プールは貸し出しの前にアイドル用のリスナを外すので、受け手が 1 つも居なくなり
      // uncaughtException になる（実測: 借りた接続を reset して再現した）。
      client.on("error", () => {});
      client.query(SESSION).then(() => done(), done);
    },
  });
  // アイドル中に切られた接続は 'error' で飛ぶ。プールはその 1 本を捨てて次を張るので、
  // ここで受けないと uncaughtException になる。
  p.on("error", () => {});
  return p;
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
  // 1 回の要求は「120,000 トークンまで」かつ「1,000 件まで」。件数だけで割ると、
  // 長い記録が並んだときにトークン側で 400 になる。日本語は 1 字がおよそ 1 トークンなので、
  // **文字数で保守的に切る。**バイト数ではなく文字数で測るのは、トークンが文字に近いため。
  const MAX_CHARS = 90_000;
  const MAX_ITEMS = 96;
  const batches: string[][] = [];
  let cur: string[] = [];
  let curChars = 0;
  for (const t of texts) {
    // 1 件で上限を超える記録は、そこで切る。落とすと取り込みが黙って欠ける。
    const one = t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t;
    if (cur.length > 0 && (cur.length >= MAX_ITEMS || curChars + one.length > MAX_CHARS)) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(one);
    curChars += one.length;
  }
  if (cur.length) batches.push(cur);

  for (const batch of batches) {
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
