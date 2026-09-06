#!/usr/bin/env node
// OpenAI の使用量。**推定ではなく、応答が返した実測値の合計。**
// 鍵に上限があるので、残りを推測で語らないための道具。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG = path.join(os.homedir(), ".claude", "mitos-usage.jsonl");
const LIMIT = Number(process.env.MITOS_USAGE_LIMIT ?? 5);

if (!fs.existsSync(LOG)) {
  console.log("まだ記録がありません。");
  process.exit(0);
}

type Row = { at: string; model: string; in?: number; out?: number; cost?: number };
const rows: Row[] = fs
  .readFileSync(LOG, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Row);

const byModel = new Map<string, { n: number; in: number; out: number; cost: number }>();
for (const r of rows) {
  const a = byModel.get(r.model) ?? { n: 0, in: 0, out: 0, cost: 0 };
  byModel.set(r.model, {
    n: a.n + 1,
    in: a.in + (r.in ?? 0),
    out: a.out + (r.out ?? 0),
    cost: a.cost + (r.cost ?? 0),
  });
}

console.table(
  Object.fromEntries(
    [...byModel].map(([m, v]) => [
      m,
      { 回数: v.n, 入力: v.in.toLocaleString(), 出力: v.out.toLocaleString(), 費用: `$${v.cost.toFixed(4)}` },
    ]),
  ),
);

const total = rows.reduce((a, r) => a + (r.cost ?? 0), 0);
const per = total / Math.max(rows.length, 1);
console.log(`合計 $${total.toFixed(4)} / 上限 $${LIMIT}（${((total / LIMIT) * 100).toFixed(1)}%）`);
console.log(
  `1 回あたり $${per.toFixed(4)} — 残りおよそ ${Math.floor((LIMIT - total) / per).toLocaleString()} 回`,
);
if (total >= LIMIT * 0.6) console.log("\n※ 上限の 60% に達しています。");
