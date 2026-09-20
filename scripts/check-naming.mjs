#!/usr/bin/env node
// 旧い名前が残っていないかを見る。**改名は 1 度きりの作業ではない** — 消したつもりの綴りは、
// あとから書くコードとドキュメントに紛れて戻ってくる。
//
// 生成物（plugin/dist、plugin/db）は追跡していないので対象外。
// **例外は理由付きでここに書く。**書かずに通すと、次に見た人が消してよいのか分からない。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

/** 残っていてよい綴りと、その理由。 */
const ALLOWED = [
  {
    // 過去に実際に踏んだ事実の記録。今の構成の説明ではない。
    file: ".github/workflows/check.yml",
    pattern: /Vercel で実際に踏んだ/,
  },
  {
    // 規約の根拠が変わったことの記録。消すと「なぜこの規約があるか」が復元できない。
    file: ".agents/skills/knowledge-schema/SKILL.md",
    pattern: /Neonの80ms前後の往復/,
  },
];

const OLD = [
  { name: "旧いツール名", re: /mitos/i },
  // 旧名の由来はギリシャ文字で書かれていたので、ラテン文字の綴りを探しても当たらない。
  { name: "旧いツール名の由来", re: /μίτος/i },
  // 環境変数だけを見る。SQL の列一覧（KNOWLEDGE_COLS）のような定数名は対象外。
  { name: "旧い環境変数", re: /\bKNOWLEDGE_(DB_URL|ENV_DIR)\b/ },
  { name: "旧い設定ファイル", re: /knowledge\.env/ },
  { name: "消したサービス", re: /\b(Vercel|Neon|Clerk)\b/i },
];

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
// この検査は探す綴りを自分の中にパターンとして持つので、自分を見れば必ず当たる。
const SELF = "scripts/check-naming.mjs";
const skip = /^(plugin\/dist|plugin\/db)\//;
const binary = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|zip|lock)$/;

const hits = [];
for (const file of tracked) {
  if (file === SELF || skip.test(file) || binary.test(file)) continue;
  let body;
  try {
    body = fs.readFileSync(file, "utf8");
  } catch {
    continue; // symlink の先が無い等。ここでは名前だけを見る
  }
  const lines = body.split("\n");
  for (const [i, line] of lines.entries()) {
    for (const { name, re } of OLD) {
      if (!re.test(line)) continue;
      if (ALLOWED.some((a) => a.file === file && a.pattern.test(line))) continue;
      hits.push(`${file}:${i + 1}  ${name}: ${line.trim().slice(0, 100)}`);
    }
  }
}

for (const file of tracked) {
  if (/mitos/i.test(file)) hits.push(`${file}  旧いツール名がファイル名にある`);
}

if (hits.length) {
  console.error(`旧い名前が ${hits.length} 箇所に残っている。\n`);
  console.error(hits.slice(0, 40).join("\n"));
  if (hits.length > 40) console.error(`\n…ほか ${hits.length - 40} 箇所`);
  console.error("\n消せない理由があるなら scripts/check-naming.mjs の ALLOWED へ理由付きで足す。");
  process.exit(1);
}

console.log(`名前: 旧い綴りは残っていない（${tracked.length} ファイルを見た）`);
