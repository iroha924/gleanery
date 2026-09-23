#!/usr/bin/env node
// server/src の SQL の call site が、test の中で本物の SQLite に実行されたかを数える。
//
// **型検査と単体テストは、実行されない SQL を素通りさせる。**test は一時ディレクトリの SQLite に SQL を実際に
// 流すので、実行された call site は SQLite が構文・制約・authorizer ごと受け付けたことになる。検査するのは
// 「実行されたか」だけで、実行されなかった call site を file:line で挙げる。
//
// 到達は V8 のカバレッジで数える（scripts/lib/coverage.mjs。子プロセスのレーンと同じツール）。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { coveredSites } from "./lib/coverage.mjs";
import { root } from "./lib/live-harness.mjs";
import { ALLOWED_UNCOVERED, callSites, LIVE_FILES } from "./lib/sql-call-sites.mjs";

const covDir = fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-sql-reach-"));
process.on("exit", () => fs.rmSync(covDir, { recursive: true, force: true }));

// 数える側と test を同じ command にする。別々にすると、順序が変わっただけで「流していないものを数えて緑」になる。
const r = spawnSync("bun", ["run", "--cwd", "server", "test"], {
  cwd: root,
  env: { ...process.env, NODE_V8_COVERAGE: covDir },
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (r.status !== 0) {
  // node --test は失敗の中身を stdout へ書く。
  console.error("テストが通らないので到達を数えられない。先に `bun run test` を直す。\n");
  console.error(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  process.exit(1);
}

const sites = callSites(root).filter((s) => !LIVE_FILES.some((f) => s.startsWith(`${f}:`)));
const covered = coveredSites(covDir, root, sites);
if (covered.size === 0) {
  console.error("到達が 1 箇所も数えられなかった。カバレッジの書き出しが壊れている可能性がある。");
  process.exit(1);
}
const uncovered = sites.filter((s) => !covered.has(s));
const byFile = new Map();
for (const s of uncovered) {
  const file = s.slice(0, s.lastIndexOf(":"));
  byFile.set(file, [...(byFile.get(file) ?? []), s]);
}

const ledger = [];
for (const [file, list] of [...byFile].sort()) {
  const allowed = ALLOWED_UNCOVERED.find((a) => a.file === file);
  if (!allowed)
    ledger.push(`${file}: ${list.length} 箇所がどのテストからも実行されていない\n    ${list.join("\n    ")}`);
  else if (list.length > allowed.uncovered)
    ledger.push(
      `${file}: 実行されない call site が ${allowed.uncovered} から ${list.length} へ増えた\n    ${list.join("\n    ")}`,
    );
}
for (const a of ALLOWED_UNCOVERED) {
  const now = (byFile.get(a.file) ?? []).length;
  if (now < a.uncovered)
    ledger.push(`${a.file}: 実行されない call site は ${now} 箇所に減った。ALLOWED_UNCOVERED の数を下げる`);
  // 総数も見る。1 箇所を到達させて 1 箇所足す取り替えは、未到達の数だけでは差し引き 0 で素通りする。
  const total = sites.filter((s) => s.startsWith(`${a.file}:`)).length;
  if (total !== a.sites)
    ledger.push(`${a.file}: call site が ${a.sites} から ${total} へ変わった。ALLOWED_UNCOVERED を見直す`);
}
if (ledger.length) {
  console.error("SQL を実行していない call site がある。\n");
  for (const l of ledger) console.error(`  ${l}`);
  console.error(
    "\n実行させられないなら scripts/lib/sql-call-sites.mjs の ALLOWED_UNCOVERED へ理由付きで足す。",
  );
  process.exit(1);
}
console.log(
  `SQL: test から ${sites.length - uncovered.length} / ${sites.length} 箇所を本物の SQLite で実行した` +
    (uncovered.length ? `（残り ${uncovered.length} 箇所は ALLOWED_UNCOVERED に理由付きで載せてある）` : ""),
);
