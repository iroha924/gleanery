#!/usr/bin/env node
// schema の適用と作り直し、ロールの鍵づくり。持ち主が手元で叩く（plugin の配布物には入れない）。
//
//   bun run db:apply                 空の DB に db/schema.sql を当てる（mitos の schema が既にあれば止める）
//   bun run db:reset                 mitos の schema だけを消して作り直す。接続先の endpoint 名を打ち直させる
//   bun run db:roles [--env <file>]  3 つのロールに新しいパスワードを付け、接続文字列を env ファイルへ書く
//
// どれも owner の鍵（KNOWLEDGE_DB_URL）で繋ぐ。**パスワードと接続文字列は画面に出さない。**

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connect, GLOBAL_ENV, inTransaction, KEY, loadEnv } from "./db.ts";

const SCHEMA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "schema.sql");

/** 繋ぎ先。資格情報を除いた host と database だけを出す。 */
function target(url: string | undefined): { host: string; endpoint: string; database: string } {
  if (!url) throw new Error(`${KEY.owner} が無い。owner の接続文字列を ~/.claude/knowledge.env に入れる`);
  const u = new URL(url);
  return {
    host: u.hostname,
    endpoint: u.hostname.split(".")[0] ?? "",
    database: u.pathname.replace(/^\//, ""),
  };
}

async function apply(): Promise<void> {
  const env = loadEnv();
  const t = target(env[KEY.owner]);
  const c = await connect(env, "owner");
  try {
    const exists = await c.query("select 1 from pg_namespace where nspname = 'mitos'");
    if (exists.rowCount)
      throw new Error(`${t.endpoint}/${t.database} には mitos の schema が既にある。作り直すなら db:reset`);
    await inTransaction(c, () => c.query(fs.readFileSync(SCHEMA, "utf8")));
    console.log(`当てた: ${t.endpoint}/${t.database}`);
  } finally {
    await c.end();
  }
}

async function reset(): Promise<void> {
  const env = loadEnv();
  const t = target(env[KEY.owner]);
  const c = await connect(env, "owner");
  try {
    const counts = await c
      .query<{ t: string; n: string }>(
        `select 'conversation' as t, count(*)::text as n from mitos.conversation
         union all select 'message', count(*)::text from mitos.message
         union all select 'knowledge', count(*)::text from mitos.knowledge`,
      )
      .catch(() => ({ rows: [] as { t: string; n: string }[] }));
    console.log(`接続先: ${t.host} / database ${t.database}`);
    console.log(
      `いまの mitos: ${counts.rows.length ? counts.rows.map((r) => `${r.t} ${r.n}`).join(" / ") : "無い"}`,
    );
    console.log("mitos の schema を消して作り直す。**元に戻せない。**");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const typed = (
      await rl.question(`続けるなら endpoint 名（${t.endpoint}）を打つ: `).catch(() => "")
    ).trim();
    rl.close();
    if (typed !== t.endpoint) {
      console.log("一致しないので止めた。");
      process.exitCode = 1;
      return;
    }
    await inTransaction(c, async () => {
      await c.query("drop schema if exists mitos cascade");
      await c.query(fs.readFileSync(SCHEMA, "utf8"));
    });
    console.log(`作り直した: ${t.endpoint}/${t.database}`);
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
 * **どの時点で止まっても鍵を失わない順にする。**ロールごとに、新しい鍵を書いた 0600 の一時ファイルを先に作り、
 * パスワードを変え、通ってから一時ファイルで置き換える（既存のファイルの権限にも引きずられない）。
 * Neon はパスワードの変更を control plane へ渡すので、transaction で巻き戻せる保証が無い。
 * Neon は平文のパスワードしか受け付けない（SCRAM の verifier を渡すと control plane が 400 を返す。実測）。
 */
async function roles(given: string): Promise<void> {
  // symlink の env ファイルは、link ではなく実体を置き換える（link を通常のファイルで潰さない）。
  const file = fs.existsSync(given) ? fs.realpathSync(given) : given;
  const env = loadEnv();
  const owner = env[KEY.owner];
  const t = target(owner);
  const c = await connect(env, "owner");
  const done: string[] = [];
  try {
    for (const [role, name] of [
      ["reader", "mitos_reader"],
      ["ingest", "mitos_ingest"],
      ["capture", "mitos_capture"],
    ] as const) {
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
        fs.renameSync(tmp, file);
      } catch (e) {
        throw new Error(
          `${name} のパスワードは変えたが ${file} を置き換えられなかった。新しい鍵は ${tmp} にある（0600）: ${e instanceof Error ? e.message : e}`,
        );
      }
      done.push(KEY[role]);
    }
  } finally {
    await c.end();
    if (done.length)
      console.log(
        `${t.endpoint} のロールに新しいパスワードを付け、${done.join(" / ")} を ${file} に書いた。`,
      );
  }
  console.log(
    "ほかの PC の knowledge.env と、Vercel の KNOWLEDGE_DB_URL_RO も同じ値へ差し替える（値は表示しない）。",
  );
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    options: { env: { type: "string" } },
    allowPositionals: true,
  });
  const cmd = positionals[0];
  if (cmd === "apply") return apply();
  if (cmd === "reset") return reset();
  if (cmd === "roles") {
    const dir = process.env.KNOWLEDGE_ENV_DIR;
    return roles(values.env ?? (dir ? path.join(dir, ".env") : GLOBAL_ENV));
  }
  throw new Error("使い方: node server/src/admin.ts apply | reset | roles [--env <file>]");
}

// 直接起動されたときだけ動く（テストは rewriteEnv だけを使う）。
if (process.argv[1] && /admin\.ts$/.test(process.argv[1])) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
