// DB と Voyage への接続。**資格情報はここでしか読まない。**
//
// 鍵は操作ごとに分かれ、どの鍵も別の鍵へ落とさない（db/schema.sql のロールの節）。
// untrusted な文章を読む出口（MCP・画面）が書き込みの鍵を持つと、読んだ文章に書かされる経路ができる。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

export type Env = Record<string, string | undefined>;

// どのプロジェクトからでも同じものを指せるよう、置き場所を 1 つに固定する。
export const GLOBAL_ENV = path.join(os.homedir(), ".gleanery", "env");

export function parseEnv(text: string): Env {
  const out: Env = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m?.[1] && out[m[1]] === undefined) out[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

function readInto(out: Env, file: string): boolean {
  if (!fs.existsSync(file)) return false;
  for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(file, "utf8")))) {
    if (!process.env[k] && out[k] === undefined) out[k] = v;
  }
  return true;
}

/**
 * 探索順: プロセスの環境変数 → GLEANERY_ENV_DIR/.env → ~/.gleanery/env
 *
 * **作業ディレクトリから上へ .env を探さない。**フックは編集中のプロジェクトを cwd として起動するので、
 * 他人のリポジトリがコミットした .env が接続先の候補になる。
 */
export function loadEnv(): Env {
  const out: Env = { ...process.env };
  if (process.env.GLEANERY_ENV_DIR) readInto(out, path.join(process.env.GLEANERY_ENV_DIR, ".env"));
  readInto(out, GLOBAL_ENV);
  return out;
}

/**
 * どの鍵で繋ぐか。
 *   owner   schema の適用と migration だけ（server/src/admin.ts）
 *   reader  MCP・画面の API（読むだけ）
 *   ingest  取り込み・trace・名簿（CLI）
 *   capture 会話の自動記録（追記だけ）
 */
export type Role = "owner" | "reader" | "ingest" | "capture";

export const KEY: Record<Role, string> = {
  owner: "GLEANERY_DB_URL",
  reader: "GLEANERY_DB_URL_RO",
  ingest: "GLEANERY_DB_URL_INGEST",
  capture: "GLEANERY_DB_URL_CAPTURE",
};

/** MCP と CLI が期待する schema の版。db/schema.sql の schema コメントと同じ数にする（テストが突き合わせる）。 */
export const SCHEMA_REVISION = 5;

/** pg は int8（bigint と count(*)）を string、timestamptz を Date で返す。`query<T>` の結果型はこれに合わせて書く。 */
export type Db = Pick<pg.Client, "query">;

export function settings(env: Env, role: Role): pg.ClientConfig {
  const raw = env[KEY[role]];
  if (!raw) throw new Error(`${KEY[role]} が無い。~/.gleanery/env か、デプロイ先の環境変数に入れる`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // URL の TypeError は input に接続文字列全体を持ち、未捕捉なら Node が印字する。パスワードを含む。
    throw new Error(`${KEY[role]} が URL として読めない（値は伏せる）`);
  }
  // pg は接続文字列の TLS 指定を ssl オプションより後に効かせ、`?ssl=0` だけで TLS が消える。
  // 接続先だけを取り出して渡し、TLS はここで固定する。
  const bad = ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey"].filter((k) => u.searchParams.has(k));
  if (bad.length) {
    throw new Error(`${KEY[role]} の ${bad.join(" / ")} は使えない。TLS は接続先から決める。この指定を消す`);
  }
  // URL は IPv6 を角括弧付きで返す。net.connect はそれを受け付けない。
  const hostname = u.hostname.replace(/^\[(.+)\]$/, "$1");
  // **完全一致でだけ loopback と認める。**URL パーサは host を正規化しないので、
  // `127.1` や `0x7f.1` は綴りのまま届く。取りこぼすと TLS を要求して接続に失敗するだけだが、
  // 曖昧な一致を許すと、loopback でない相手へ平文で繋ぐ側へ倒れる。
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(hostname.toLowerCase());
  return {
    host: hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, "") || "postgres",
    // 手元の DB は TLS を張らない（公式イメージの既定が ssl = off）。
    // 他所へ繋ぐときは検証を切らない。切ると、経路を握った相手が返した行がそのまま MCP の応答になる。
    // CA は同梱せず Node の信頼ストアに任せる（NODE_EXTRA_CA_CERTS も効く）。
    ssl: loopback ? false : { rejectUnauthorized: true },
  };
}

/**
 * DB の schema が、このコードの期待する版か。**食い違えば止める。**
 * 古い schema に新しいコードで書くと、列の意味が黙ってずれる。
 */
export async function checkSchema(db: Db): Promise<void> {
  const r = await db.query<{ comment: string | null }>(
    "select obj_description(n.oid, 'pg_namespace') as comment from pg_namespace n where n.nspname = 'gleanery'",
  );
  const comment = r.rows[0]?.comment;
  if (comment === undefined) throw new Error("DB に gleanery の schema が無い。`bun run db:apply` で作る");
  const got = Number(comment?.match(/revision (\d+)/)?.[1]);
  if (got !== SCHEMA_REVISION) {
    throw new Error(
      `DB の schema は revision ${Number.isNaN(got) ? "不明" : got}、このコードは revision ${SCHEMA_REVISION} を期待している。` +
        (got < SCHEMA_REVISION
          ? "持ち主が gleanery のリポジトリで `bun run db:migrate` を当てる"
          : "gleanery を更新する"),
    );
  }
}

export async function connect(env: Env, role: Role): Promise<pg.Client> {
  const client = new pg.Client(settings(env, role));
  await client.connect();
  // アイドル中の切断は 'error' で飛ぶ。リスナが無いと uncaughtException で長命のプロセスが落ちる。
  client.on("error", () => {});
  return client;
}

/**
 * 長命のプロセス（画面の API と MCP）が使う接続。同時に来たクエリを 1 本へ積まない。
 *
 * 返すのは「最初の呼び出しで schema の版を確かめてから pool を渡す」関数。起動時に確かめると、
 * DB に届かないだけで MCP が立ち上がらなくなる。失敗は覚えず、次の呼び出しで確かめ直す。
 */
export function lazyPool(env: Env, role: Role): () => Promise<pg.Pool> {
  let ready: Promise<pg.Pool> | null = null;
  return () => {
    ready ??= (async () => {
      const p = new pg.Pool({
        ...settings(env, role),
        max: 5,
        idleTimeoutMillis: 30_000,
        allowExitOnIdle: true,
      });
      // 借りている間の切断は、pg が reject の後に emit("error") まで行う。受け手が無いとプロセスごと落ちる。
      p.on("connect", (client) => client.on("error", () => {}));
      p.on("error", () => {});
      try {
        await checkSchema(p);
      } catch (e) {
        await p.end().catch(() => {});
        throw e;
      }
      return p;
    })().catch((e: unknown) => {
      ready = null;
      throw e;
    });
    return ready;
  };
}

/** 1 つの接続を占有して transaction を張る。失敗したら rollback して元の例外を投げる。 */
export async function inTransaction<T>(client: pg.Client, fn: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    const out = await fn();
    await client.query("commit");
    return out;
  } catch (e) {
    // rollback 自体が投げると本来の原因が消える。
    await client.query("rollback").catch(() => {});
    throw e;
  }
}

const VOYAGE = "https://api.voyageai.com/v1/embeddings";
export const EMBED_MODEL = "voyage-4-large";
export const RERANK_MODEL = "rerank-3";

/** Voyage が HTTP のエラーを返した。status で「本文を受け付けない」と「鍵・上限・障害」を分ける。 */
export class VoyageError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * 埋め込みを取る。**input_type を省略しない。**Voyage は query と document で前置プロンプトを変える。
 */
export async function embed(env: Env, texts: string[], inputType: "query" | "document"): Promise<number[][]> {
  if (!env.VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY が無い");
  if (texts.length === 0) return [];
  // 1 回の要求は 120,000 トークンかつ 1,000 件まで。日本語は 1 字がほぼ 1 トークンなので文字数で保守的に切る。
  const MAX_CHARS = 90_000;
  const MAX_ITEMS = 96;
  const batches: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const t of texts) {
    const one = t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t;
    if (cur.length > 0 && (cur.length >= MAX_ITEMS || chars + one.length > MAX_CHARS)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(one);
    chars += one.length;
  }
  if (cur.length) batches.push(cur);

  const out: number[][] = [];
  for (const batch of batches) {
    const res = await fetch(VOYAGE, {
      signal: AbortSignal.timeout(30_000),
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.VOYAGE_API_KEY}` },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: batch,
        input_type: inputType,
        output_dimension: 1024,
        output_dtype: "float",
      }),
    });
    if (!res.ok)
      throw new VoyageError(`Voyage が ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    for (const d of json.data.sort((a, b) => a.index - b.index)) out.push(d.embedding);
  }
  return out;
}

/** pgvector のリテラル。halfvec も同じ形で受ける。 */
export const vec = (a: number[]): string => `[${a.join(",")}]`;
