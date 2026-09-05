#!/usr/bin/env node
// PreToolUse（Edit / Write）: これから触るファイルについて「触らない」と決めた記録を提示する。
//
// README「フックを置く条件」に当てはめた形:
//   判定対象が有限        パスの完全一致だけ。意味の推論をしない
//   塞がずに情報を足す    提示するだけで編集は止めない
//   過剰マッチが無害      出自が付くので、関係なければ捨てられる
//   過小マッチは現状維持  当たらなければ今までどおり
//   決定的・短く・fail-open  索引の完全一致 1 回。DB が落ちていればそのまま進む
//
// **fail-open を守る。**DB へ繋がらない・遅い・壊れている、のどれでも編集は止めない。
// ここで止めると、ナレッジ DB が作業を止める装置になってしまう。

import path from "node:path";
import type pg from "pg";
import { connect, loadEnv } from "./db.ts";
import { identify } from "./scope.ts";
import { quote, scopeFamily, whatAboutPath } from "./search.ts";

const TIMEOUT_MS = 2500;

function done(text: string | null): never {
  if (text) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } }),
    );
  }
  process.exit(0);
}

const input = await new Promise<string>((res) => {
  let s = "";
  process.stdin.on("data", (d) => {
    s += d;
  });
  process.stdin.on("end", () => res(s));
  setTimeout(() => res(s), 1500);
});

let payload: { tool_input?: { file_path?: string }; cwd?: string };
try {
  payload = JSON.parse(input || "{}");
} catch {
  done(null);
}

const filePath = payload.tool_input?.file_path;
const cwd = payload.cwd ?? process.cwd();
if (!filePath) done(null);

// 記録には相対パスで入っていることが多いので、両方で引く。
const abs = path.resolve(cwd, filePath);
const rel = path.relative(cwd, abs);
const keys = [...new Set([rel, abs, filePath])].filter(Boolean);

const timer = setTimeout(() => done(null), TIMEOUT_MS);
let client: pg.Client | null = null;
try {
  const env = loadEnv(process.env.KNOWLEDGE_ENV_DIR ?? cwd);
  if (!env.SUPABASE_DB_URL) done(null);
  client = await connect(env);

  const me = identify(cwd);
  // 未登録のディレクトリでは何も出さない。全件を見せると無関係な決定が混ざる。
  const s = await client.query<{ id: number }>("select id::int as id from scope where ident = $1", [
    me.ident,
  ]);
  const row = s.rows[0];
  if (!row) {
    clearTimeout(timer);
    done(null);
  }
  const scopeIds = await scopeFamily(client, row.id);

  const seen = new Set<string>();
  const rows: Awaited<ReturnType<typeof whatAboutPath>> = [];
  for (const k of keys) {
    for (const r of await whatAboutPath(client, k, scopeIds)) {
      if (!seen.has(r.key)) {
        seen.add(r.key);
        rows.push(r);
      }
    }
  }
  clearTimeout(timer);
  if (rows.length === 0) done(null);

  // 本文は過去の記録であって、第三者が書き換えうる untrusted なテキストである。
  // 枠は quote() が張る。ここで組み立てると、枠を張り忘れた経路が増える。
  done(
    quote(
      rows,
      `${rel} について、過去に「触らない」と決めた記録が ${rows.length} 件あります。\n` +
        `直す前に、これが欠陥なのか意図なのかを確かめてください。`,
    ),
  );
} catch {
  // 何が起きても編集は止めない
  clearTimeout(timer);
  done(null);
} finally {
  try {
    await client?.end();
  } catch {
    /* 閉じられなくても構わない */
  }
}
