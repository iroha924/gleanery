#!/usr/bin/env node
// `.claude/rules/*.md` の `paths` が、載るべきファイルに載り、載ってはいけないファイルに載らないかを見る。
//
// **rule のフロントマターへ期待を書かない。**公式が定義しているキーは `paths` だけで、独自キーが
// 無視されるか警告されるかは記載が無い。期待はここに表として持つ。
//
// paths 付きは「一致するファイルを Claude が読んだとき」に載る（公式 memory の記述）。
// つまり広すぎる paths は、関係ない作業でも文脈を食う。狭すぎると必要な場面で載らない。

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rulesDirectory = path.join(root, ".claude", "rules");

/** 各 rule が載るべき実ファイルと、載ってはいけない実ファイル。**実在するパスだけを書く。** */
const EXPECTED = {
  "ui.md": {
    match: [
      "dashboard/src/features/_chat/ui/chat-page.tsx",
      "dashboard/src/lib/api.ts",
      "dashboard/src/styles.css",
      "dashboard/vite.config.ts",
    ],
    notMatch: [
      "server/src/cli.ts",
      "server/src/http/routes/knowledge.ts",
      "scripts/bundle.mjs",
      "db/schema.sql",
      "AGENTS.md",
    ],
  },
  "comments.md": {
    match: [
      "server/src/db.ts",
      "dashboard/src/lib/api.ts",
      "scripts/bundle.mjs",
      "lefthook.yml",
      "db/compose.yaml",
    ],
    notMatch: ["README.md", "AGENTS.md", "package.json"],
  },
};

/** paths 無しの rule。常時載るので、数と理由を固定する。 */
const ALWAYS = {
  "verification.md": "テストと配布物の検査はどのファイルを触っていても要る",
};

/** glob を正規表現へ。`**` は階層をまたぎ、`*` は 1 階層に閉じる。 */
function toRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` は 0 階層以上、末尾の `**` は何にでも当たる
        if (glob[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close !== -1) {
        out += `(?:${glob
          .slice(i + 1, close)
          .split(",")
          .map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&"))
          .join("|")})`;
        i = close;
        continue;
      }
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function frontmatterPaths(source, file) {
  if (!source.startsWith("---\n")) return null;
  const end = source.indexOf("\n---\n", 4);
  if (end === -1) {
    failures.push(`${file}: フロントマターが閉じていない`);
    return null;
  }
  const lines = source.slice(4, end).split("\n");
  if (!lines.some((l) => l.trim() === "paths:")) return null;
  const globs = [];
  let inPaths = false;
  for (const line of lines) {
    if (line.trim() === "paths:") {
      inPaths = true;
      continue;
    }
    if (inPaths) {
      const m = /^\s*-\s*["']?([^"']+)["']?\s*$/.exec(line);
      if (m) {
        globs.push(m[1]);
        continue;
      }
      if (line.trim() !== "") break;
    }
  }
  return globs;
}

const failures = [];
const files = fs.readdirSync(rulesDirectory).filter((f) => f.endsWith(".md"));
const scoped = [];
const always = [];

for (const file of files) {
  const source = fs.readFileSync(path.join(rulesDirectory, file), "utf8").replaceAll("\r\n", "\n");
  const globs = frontmatterPaths(source, file);

  if (globs === null) {
    always.push(file);
    if (!ALWAYS[file]) {
      failures.push(
        `${file}: paths が無いので常時ロードされる。全ファイルで要るなら scripts/check-rule-scopes.mjs の ` +
          "ALWAYS へ理由付きで足す。要らないなら paths を付ける",
      );
    }
    continue;
  }
  scoped.push(file);
  if (globs.length === 0) {
    failures.push(`${file}: paths が空`);
    continue;
  }

  const expected = EXPECTED[file];
  if (!expected) {
    failures.push(`${file}: 期待を scripts/check-rule-scopes.mjs の EXPECTED へ書く`);
    continue;
  }
  const patterns = globs.map(toRegExp);
  const hits = (target) => patterns.some((p) => p.test(target));

  for (const target of expected.match) {
    if (!fs.existsSync(path.join(root, target))) {
      failures.push(`${file}: 期待に書いた ${target} が実在しない`);
      continue;
    }
    if (!hits(target)) failures.push(`${file}: ${target} で載るべきなのに paths が当たらない`);
  }
  for (const target of expected.notMatch) {
    if (!fs.existsSync(path.join(root, target))) {
      failures.push(`${file}: 期待に書いた ${target} が実在しない`);
      continue;
    }
    if (hits(target)) failures.push(`${file}: ${target} で載ってはいけないのに paths が当たる`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((f) => `- ${f}`).join("\n"));
  process.exit(1);
}

console.log(`ruleの範囲: paths付き ${scoped.length} 本 / 常時 ${always.length} 本`);
