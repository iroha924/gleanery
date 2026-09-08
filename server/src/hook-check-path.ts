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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { connect, loadEnv } from "./db.ts";
import { identify } from "./scope.ts";
import { adviceForPath, quote, scopeFamily, whatAboutPath } from "./search.ts";

const TIMEOUT_MS = 2500;

// 良くなったかを測るための記録。
//
// **DB へは書かない。**フックが持つ鍵は読み取り専用で、そこを崩すと
// 「推論する層は書けない」という設計が壊れる。ファイルなら経路を増やさずに済む。
// 追記だけで、失敗しても編集は止めない。
const LOG = path.join(os.homedir(), ".claude", "mitos-advice.jsonl");

type Shot = { at: string; path: string; line: number | null; candidates: number; shown: string[] };

/** 直近に出したもの。**同じ助言を出し続けない**ための材料。 */
function recent(hours = 24): Set<string> {
  try {
    const since = Date.now() - hours * 36e5;
    const lines = fs.readFileSync(LOG, "utf8").split("\n").slice(-400);
    const out = new Set<string>();
    for (const l of lines) {
      if (!l.startsWith("{")) continue;
      const r = JSON.parse(l) as Shot;
      if (Date.parse(r.at) >= since) for (const k of r.shown) out.add(k);
    }
    return out;
  } catch {
    return new Set();
  }
}

function record(shot: Shot): void {
  try {
    fs.appendFileSync(LOG, `${JSON.stringify(shot)}\n`);
  } catch {
    // 記録できなくても編集は止めない
  }
}

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

let payload: { tool_input?: { file_path?: string; old_string?: string }; cwd?: string };
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

/**
 * これから触る行。**Edit は old_string しか渡さない**ので、いまのファイルから位置を割り出す。
 * 分からなければ null（そのときは行の距離を使わず、PR の重複回避と新しさで選ぶ）。
 */
function editedLine(): number | null {
  const old = payload.tool_input?.old_string;
  if (!old) return null;
  try {
    const body = fs.readFileSync(abs, "utf8");
    const at = body.indexOf(old);
    if (at < 0) return null;
    // 先頭からの改行の数 + 1 が行番号。substring を数えるだけなので数 ms で済む。
    let line = 1;
    for (let i = 0; i < at; i++) if (body.charCodeAt(i) === 10) line++;
    return line;
  } catch {
    return null;
  }
}

const timer = setTimeout(() => done(null), TIMEOUT_MS);
let client: pg.Client | null = null;
try {
  const env = loadEnv(process.env.KNOWLEDGE_ENV_DIR ?? cwd);
  if (!env.KNOWLEDGE_DB_URL) done(null);
  client = await connect(env, { as: "read" });

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
  // 「触らない」が 1 件でもあれば、それだけを出す。**制約は助言より強い。**
  if (rows.length > 0) {
    clearTimeout(timer);
    // **出したことをここでも記録する。**この分岐は done() で抜けるので、書かずに通すと
    // 最も強い助言（「触らない」と決めた記録）を出した編集が分母からも分子からも消え、
    // `mitos advice` のヒット率が実際より低く出る。
    record({
      at: new Date().toISOString(),
      path: rel,
      line: editedLine(),
      candidates: rows.length,
      shown: rows.map((r) => r.text.slice(0, 120)),
    });
    // 本文は過去の記録であって、第三者が書き換えうる untrusted なテキストである。
    // 枠は quote() が張る。ここで組み立てると、枠を張り忘れた経路が増える。
    done(
      quote(
        rows,
        `${rel} について、過去に「触らない」と決めた記録が ${rows.length} 件あります。\n` +
          `直す前に、これが欠陥なのか意図なのかを確かめてください。`,
      ),
    );
  }

  // 制約が無ければ、そのファイルの「過去に言われたこと」を最大 2 件だけ。
  const line = editedLine();
  const shownBefore = recent();
  const seenPr = new Set<number | string>();
  const advice: Awaited<ReturnType<typeof adviceForPath>> = [];
  let candidates = 0;
  for (const k of keys) {
    for (const a of await adviceForPath(client, k, scopeIds, line, 5)) {
      candidates++;
      const id = a.pr ?? a.key;
      if (seenPr.has(id)) continue;
      seenPr.add(id);
      // **一度出したものは 24 時間出さない。**同じファイルを続けて直すたびに
      // 同じ指摘が並ぶと、読まれなくなる（Codex の指摘）。
      if (shownBefore.has(`${a.record_id}|${a.key}`)) continue;
      advice.push(a);
    }
  }
  clearTimeout(timer);
  const shown = advice.slice(0, 2);
  // **出さなかったことも記録する。**分母が無いとヒット率が出せない。
  record({
    at: new Date().toISOString(),
    path: rel,
    line,
    candidates,
    shown: shown.map((a) => `${a.record_id}|${a.key}`),
  });
  if (shown.length === 0) done(null);

  done(
    quote(
      shown,
      `${rel}${line ? ` の ${line} 行目あたり` : ""} について、` +
        `マージ済みの PR で言われたことが ${shown.length} 件あります。\n` +
        `**当時の話なので、いまも当てはまるかは自分で判断してください。**`,
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
