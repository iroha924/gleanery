#!/usr/bin/env node
// この PC の DB の面倒を見る。持ち主が手元で叩く。
//
//   gleanery db init                    鍵づくり・起動・schema・ロールの鍵。何度流してもよい
//   gleanery db up / down               docker compose の起動と停止（down でもデータは残る）
//   gleanery db migrate [--yes]         DB の版より新しい db/migrations を当てる。接続先を打ち直させる
//   bun run db:apply                 空の DB に db/schema.sql を当てる（gleanery の schema が既にあれば止める）
//   bun run db:roles [--env <file>]  3 つのロールに新しいパスワードを付け、接続文字列を env ファイルへ書く
//
// どれも owner の鍵（GLEANERY_DB_URL）で繋ぐ。docker を触る init / up / down は、その接続先が
// loopback でなければ何もせずに止まる（migrate は他所の DB へ当てられる）。
// **パスワードと接続文字列は画面に出さない。**
// docker へも引数ではなく子プロセスの環境変数で渡す（引数は同じ PC の他の利用者から見える）。

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { dbDir } from "./assets.ts";
import { connect, type Db, type Env, GLOBAL_ENV, inClientTransaction, KEY, loadEnv, parseEnv } from "./db.ts";
import { reason } from "./text.ts";

// 同梱物の在り処は assets.ts が 1 箇所で決める（配る形と作業ツリーで置かれ方が違う）。
const SCHEMA = (): string => path.join(dbDir(), "schema.sql");
const MIGRATIONS = (): string => path.join(dbDir(), "migrations");
const COMPOSE = (): string => path.join(dbDir(), "compose.yaml");

/**
 * db migrate どうしを排他する advisory lock の鍵。**値そのものに意味は無く、変えない。**
 * 変えると、前の値で lock を取っている古いプロセスと排他できなくなり、同時に当たる。
 */
const MIGRATE_LOCK = 0x6d69746f73;

const ROLES = ["reader", "ingest", "capture"] as const;

/** 繋ぎ先。資格情報を除いた host:port/database だけを出す。対話の確認でもこの文字列を打たせる。 */
function target(url: string | undefined): string {
  if (!url) throw new Error(`${KEY.owner} が無い。\`gleanery db init\` でこの PC の DB を用意する`);
  const u = new URL(url);
  return `${u.hostname}:${u.port || "5432"}/${u.pathname.replace(/^\//, "")}`;
}

/**
 * 一時ファイルで置き換える。Windows は宛先を開いているプロセス（エディタ、ウイルス対策）がいる間
 * EPERM / EBUSY を返すので、短く待って繰り返す。
 */
async function replace(tmp: string, file: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (i >= 10 || (code !== "EPERM" && code !== "EBUSY")) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/** env ファイルの鍵を書き換える。symlink は実体を置き換える（link を通常のファイルで潰さない）。 */
async function writeKeys(given: string, set: Record<string, string>): Promise<string> {
  const file = fs.existsSync(given) ? fs.realpathSync(given) : given;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, rewriteEnv(before, set), { mode: 0o600, flag: "wx" });
  await replace(tmp, file);
  return file;
}

/** 新しい DB を空の schema へ当てる。既にあれば false（`db init` を何度流してもよい）。 */
async function applySchema(env: Env): Promise<boolean> {
  const c = await connect(env, "owner");
  try {
    const exists = await c.query("select 1 from pg_namespace where nspname = 'gleanery'");
    if (exists.rowCount) return false;
    await inClientTransaction(c, () => c.query(fs.readFileSync(SCHEMA(), "utf8")));
    return true;
  } finally {
    await c.end();
  }
}

async function apply(): Promise<void> {
  const env = loadEnv();
  const t = target(env[KEY.owner]);
  if (!(await applySchema(env)))
    throw new Error(`${t} には gleanery の schema が既にある。既存の DB は \`gleanery db migrate\` で進める`);
  console.log(`当てた: ${t}`);
}

/**
 * 名前の NNNN は当てた後の版。名前の形と重複は当てるものが無くても検査する（飛ばした 1 本は、版が進むと二度と当たらない）。
 */
export function pendingMigrations(files: string[], current: number): { revision: number; file: string }[] {
  const all = files
    // `.` で始まる名前は OS やエディタの隠しファイル（.DS_Store、vim の swap）で、書き損じた migration ではない。
    .filter((file) => !file.startsWith("."))
    .map((file) => {
      const revision = file.match(/^(\d{4})_[a-z0-9_]+\.sql$/)?.[1];
      if (!revision) throw new Error(`db/migrations/${file} の名前が NNNN_<英小文字・数字・_>.sql でない`);
      return { revision: Number(revision), file };
    })
    .sort((a, b) => a.revision - b.revision);
  const seen = new Map<number, string>();
  for (const m of all) {
    const other = seen.get(m.revision);
    if (other) throw new Error(`db/migrations に revision ${m.revision} が 2 本ある: ${other} と ${m.file}`);
    seen.set(m.revision, m.file);
  }
  const pending = all.filter((m) => m.revision > current);
  for (const [i, m] of pending.entries()) {
    if (m.revision !== current + 1 + i)
      throw new Error(`db/migrations に revision ${current + 1 + i} の migration が無い`);
  }
  return pending;
}

async function revisionOf(db: Db): Promise<number> {
  const r = await db.query<{ comment: string | null }>(
    "select obj_description(n.oid, 'pg_namespace') as comment from pg_namespace n where n.nspname = 'gleanery'",
  );
  const row = r.rows[0];
  if (!row) throw new Error("DB に gleanery の schema が無い。`gleanery db init` で作る");
  const got = Number(row.comment?.match(/revision (\d+)/)?.[1]);
  if (Number.isNaN(got)) throw new Error("gleanery の schema コメントから revision を読めない");
  return got;
}

/**
 * DB の版より新しい migration を当てる。**接続先を打ち直させる**（打ち間違いで別の DB へ DDL を当てない）。
 * 端末でないときは打たせられないので `--yes` を要る形にする。
 */
export async function migrate(yes: boolean): Promise<void> {
  const env = loadEnv();
  const t = target(env[KEY.owner]);
  if (!yes && !process.stdin.isTTY) throw new Error(`端末でないときは --yes を付ける（${t} へ当てる）`);
  const c = await connect(env, "owner");
  try {
    const files = fs.readdirSync(MIGRATIONS());
    const current = await revisionOf(c);
    const todo = pendingMigrations(files, current);
    if (todo.length === 0) {
      console.log(`当てるものは無い: ${t} は revision ${current}`);
      return;
    }
    console.log(`接続先: ${t}`);
    console.log(`いまの revision: ${current}`);
    console.log(`当てる: ${todo.map((m) => m.file).join(" / ")}`);
    if (!yes) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      // 標準入力が EOF で閉じても question は settle せず、owner の接続を開いたまま止まる。
      const closed = new AbortController();
      rl.once("close", () => closed.abort());
      const typed = (
        await rl.question(`続けるなら接続先（${t}）を打つ: `, { signal: closed.signal }).catch(() => "")
      ).trim();
      rl.close();
      if (typed !== t) {
        console.log("一致しないので止めた。");
        process.exitCode = 1;
        return;
      }
    }
    const applied = await inClientTransaction(c, async () => {
      // DDL が表の lock を待ち続けると、後ろに並んだほかの接続の query まで止まる。
      await c.query("set local lock_timeout = '10s'");
      const lock = await c.query<{ ok: boolean }>("select pg_try_advisory_xact_lock($1::bigint) as ok", [
        MIGRATE_LOCK,
      ]);
      if (!lock.rows[0]?.ok) throw new Error("別の db migrate が走っている。終わってから打ち直す");
      // 確かめている間に別の db migrate が版を進めていれば、その残りだけを当てる。
      const now = pendingMigrations(files, await revisionOf(c));
      for (const m of now) await c.query(fs.readFileSync(path.join(MIGRATIONS(), m.file), "utf8"));
      const last = now.at(-1);
      if (last) await c.query(`comment on schema gleanery is 'gleanery schema revision ${last.revision}'`);
      return now;
    });
    console.log(`当てた: ${applied.map((m) => m.file).join(" / ") || "無し"}`);
    console.log(`${t} は revision ${await revisionOf(c)}`);
  } finally {
    await c.end();
  }
}

/** env ファイルの鍵を書き換える。ほかの行（コメントと別の鍵）は残す。 */
export function rewriteEnv(body: string, set: Record<string, string>): string {
  const names = new Set(Object.keys(set));
  const kept = body
    .split("\n")
    .filter((line) => !names.has(line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/)?.[1] ?? ""));
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  return `${[...kept, ...Object.entries(set).map(([k, v]) => `${k}=${v}`)].join("\n")}\n`;
}

/**
 * 3 つのロールに新しいパスワードを付け、接続文字列を env ファイルへ書く。
 * **どの時点で止まっても鍵を失わない順にする。**ロールごとに、新しい鍵を書いた一時ファイルを先に作り、
 * パスワードを変え、通ってから一時ファイルで置き換える（既存のファイルの権限にも引きずられない）。
 */
async function roles(given: string): Promise<void> {
  const file = fs.existsSync(given) ? fs.realpathSync(given) : given;
  const env = loadEnv();
  const owner = env[KEY.owner];
  const t = target(owner);
  const c = await connect(env, "owner");
  const done: string[] = [];
  try {
    for (const role of ROLES) {
      const name = `gleanery_${role}`;
      // base64url は ' を含まないので、そのまま文字列リテラルに置ける（alter role はパラメータを取れない）。
      const password = crypto.randomBytes(24).toString("base64url");
      const u = new URL(owner as string);
      u.username = name;
      u.password = password;
      const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, rewriteEnv(before, { [KEY[role]]: u.toString() }), { mode: 0o600, flag: "wx" });
      try {
        await c.query(`alter role ${name} with login password '${password}'`);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      try {
        await replace(tmp, file);
      } catch (e) {
        throw new Error(
          `${name} のパスワードは変えたが ${file} を置き換えられなかった。新しい鍵は ${tmp} にある: ${reason(e)}`,
        );
      }
      done.push(KEY[role]);
    }
  } finally {
    await c.end();
    if (done.length)
      console.log(`${t} のロールに新しいパスワードを付け、${done.join(" / ")} を ${file} に書いた。`);
  }
}

/** docker compose に渡す環境。**パスワードは argv に載せない。** */
function composeEnv(url: string): NodeJS.ProcessEnv {
  const u = new URL(url);
  return {
    ...process.env,
    POSTGRES_PASSWORD: decodeURIComponent(u.password),
    POSTGRES_DB: u.pathname.replace(/^\//, "") || "postgres",
    POSTGRES_PORT: u.port || "5432",
  };
}

/**
 * owner の接続先がこの PC か。**完全一致でだけ loopback と認める**（db.ts の settings() と同じ判定）。
 * URL パーサは host を正規化しないので、`127.1` や `0x7f.1` は綴りのまま届く。
 * ここを緩めると、手元のコンテナを起動したまま、schema とロールのパスワードを外の DB へ当てにいく。
 */
function requireLocal(url: string): void {
  const hostname = new URL(url).hostname.replace(/^\[(.+)\]$/, "$1");
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname.toLowerCase()))
    throw new Error(
      `${KEY.owner} の接続先 ${target(url)} はこの PC の DB でない。` +
        "docker を触る db init / up / down は手元の DB にだけ使う（他所の DB は `gleanery db migrate`）",
    );
}

/**
 * docker を shell を通さずに呼ぶ（引数配列のまま渡す）。失敗すれば投げる。
 * compose.yaml は POSTGRES_PASSWORD が無ければ止まるので、up も down も owner の鍵が要る。
 */
function compose(env: Env, ...args: string[]): void {
  const url = env[KEY.owner];
  if (!url) throw new Error(`${KEY.owner} が無い。\`gleanery db init\` でこの PC の DB を用意する`);
  requireLocal(url);
  execFileSync("docker", ["compose", "-f", COMPOSE(), ...args], {
    env: composeEnv(url),
    stdio: ["ignore", "inherit", "inherit"],
  });
}

export function dbUp(): void {
  const env = loadEnv();
  compose(env, "up", "-d");
  console.log(`起動した: ${target(env[KEY.owner])}`);
}

export function dbDown(): void {
  const env = loadEnv();
  compose(env, "down");
  console.log("止めた（データは残る）");
}

/** 起動した直後の PostgreSQL は接続を受けるまで数秒かかる。受けるまで待つ。 */
async function waitForDb(env: Env): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const c = await connect(env, "owner");
      await c.end();
      return;
    } catch (e) {
      if (Date.now() >= deadline) throw new Error(`DB が 60 秒で接続を受けなかった: ${reason(e)}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * ロールの鍵を作り直すか。**schema を当てた直後は、env に 3 鍵が残っていても作り直す。**
 * 作りたての DB のロールはパスワードを持たない（db/schema.sql の create role）ので、前の DB の鍵を
 * 残すと、`docker compose down -v` の後の `gleanery db init` が成功したまま 3 つの出口とも認証に落ちる。
 */
export function needsRoleKeys(schemaApplied: boolean, have: Env): boolean {
  return schemaApplied || ROLES.some((r) => !have[KEY[r]]);
}

/**
 * この PC の DB を用意する。**既にできている段は飛ばす**ので何度流してもよい。
 * owner のパスワードは生成した後どこにも出さない（env ファイルだけが持つ）。
 */
export async function dbInit(): Promise<void> {
  if (!parseEnv(fs.existsSync(GLOBAL_ENV) ? fs.readFileSync(GLOBAL_ENV, "utf8") : "")[KEY.owner]) {
    const password = crypto.randomBytes(24).toString("base64url");
    const file = await writeKeys(GLOBAL_ENV, {
      [KEY.owner]: `postgres://postgres:${password}@127.0.0.1:5432/gleanery`,
    });
    console.log(`owner の鍵を作った: ${file}`);
  } else {
    console.log(`owner の鍵は既にある: ${GLOBAL_ENV}`);
  }
  const env = loadEnv();
  compose(env, "up", "-d");
  console.log(`起動した: ${target(env[KEY.owner])}`);
  await waitForDb(env);
  const applied = await applySchema(env);
  console.log(applied ? "schema を当てた" : "schema は既にある");
  const have = parseEnv(fs.readFileSync(GLOBAL_ENV, "utf8"));
  if (needsRoleKeys(applied, have)) await roles(GLOBAL_ENV);
  else console.log("3 つのロールの鍵は既にある");
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    options: { env: { type: "string" }, yes: { type: "boolean" } },
    allowPositionals: true,
  });
  const cmd = positionals[0];
  if (cmd === "apply") return apply();
  if (cmd === "migrate") return migrate(values.yes === true);
  if (cmd === "roles") {
    const dir = process.env.GLEANERY_ENV_DIR;
    return roles(values.env ?? (dir ? path.join(dir, ".env") : GLOBAL_ENV));
  }
  throw new Error("使い方: node server/src/admin.ts apply | migrate [--yes] | roles [--env <file>]");
}

// 直接起動されたときだけ動く（cli.ts とテストはこの module を import する）。
if (process.argv[1] && /admin\.ts$/.test(process.argv[1])) {
  main().catch((e: unknown) => {
    console.error(reason(e));
    process.exit(1);
  });
}
