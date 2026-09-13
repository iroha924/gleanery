#!/usr/bin/env node
// 同じ知識が複数の出口に写されている場所を突き合わせる。
//
// 対を探す理由と過去の事例は docs/ai-development.md が正本。
// 片方の出口だけ直しても、もう片方が動いてしまうので気付けない。
//
// **扱えるのは集合として列挙できる対だけ。**説明文が一致しているかは表現の揺れで
// 判定できないので、そこは突き合わせずに**写しそのものを消す**（README の CLI 一覧を
// USAGE から書き出す）。集合にならない対（同じ検査を経路の各段で行う、同じデータを
// 別の形で 2 つの出口が組み立てる）はここでは捕まらない。AGENTS.md の節がそれを扱う。

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const read = (f) => fs.readFileSync(f, "utf8");
const fail = [];

// **取り出せなかったら黙って通さない。**正規表現が実物とずれると抽出が 0 件になり、
// 「差が無い」と読めてしまう。検査そのものが壊れたことを、差と同じ強さで報告する。
const grab = (file, re, what) => {
  const m = read(file).match(re);
  if (!m?.[1]) {
    fail.push(`${what} を ${file} から取り出せない。check-pairs.mjs の正規表現が実物とずれている`);
    return null;
  }
  return m[1];
};

// ---- 知識の種類と状態が、DB の CHECK とコードで揃っているか ----
//
// 正本は db/schema.sql の knowledge の CHECK。コード側（server/src/knowledge.ts）は MCP の入力、画面のチャットの道具、
// 札が読む写し。**片方に足してもう片方を忘れた**を捕まえる。DB だけに足すと検索の札が空になり、
// コードだけに足すと取り込みが CHECK で落ちる。
const schema = read("db/schema.sql");
const knowledgeTable = schema.slice(
  schema.indexOf("create table mitos.knowledge ("),
  schema.indexOf("create index knowledge_listing"),
);
const dbKinds = grab("db/schema.sql", /kind in \(([^)]*)\)\s*\),\s*status text/, "knowledge.kind の CHECK")
  ?.match(/'([a-z_]+)'/g)
  ?.map((x) => x.replaceAll("'", ""));
const codeKinds = grab(
  "server/src/knowledge.ts",
  /export const KINDS = \[([^\]]*)\]/,
  "knowledge.ts の KINDS",
)
  ?.match(/"([a-z_]+)"/g)
  ?.map((x) => x.replaceAll('"', ""));
if (dbKinds && codeKinds && [...dbKinds].sort().join() !== [...codeKinds].sort().join()) {
  fail.push(
    `知識の種類が揃っていない: DB は ${dbKinds.join(" / ")}、knowledge.ts は ${codeKinds.join(" / ")}`,
  );
}
const dbStatuses = Object.fromEntries(
  [...knowledgeTable.matchAll(/when '([a-z_]+)' then status is not null and status in \(([^)]*)\)/g)].map(
    (m) => [
      m[1],
      [...m[2].matchAll(/'([a-z_]+)'/g)]
        .map((x) => x[1])
        .sort()
        .join(),
    ],
  ),
);
const codeStatuses = Object.fromEntries(
  [
    ...(
      grab(
        "server/src/knowledge.ts",
        /export const STATUSES = \{(.*?)\} as const/s,
        "knowledge.ts の STATUSES",
      ) ?? ""
    ).matchAll(/([a-z_]+): \[([^\]]*)\]/g),
  ].map((m) => [
    m[1],
    [...m[2].matchAll(/"([a-z_]+)"/g)]
      .map((x) => x[1])
      .sort()
      .join(),
  ]),
);
if (Object.keys(dbStatuses).length === 0)
  fail.push(
    "db/schema.sql から状態の CHECK を 1 つも取り出せない。check-pairs.mjs の正規表現が実物とずれている",
  );
for (const kind of new Set([...Object.keys(dbStatuses), ...Object.keys(codeStatuses)])) {
  if (dbStatuses[kind] !== codeStatuses[kind]) {
    fail.push(
      `${kind} の状態が揃っていない: DB は ${dbStatuses[kind] ?? "無し"}、knowledge.ts は ${codeStatuses[kind] ?? "無し"}`,
    );
  }
}

// ---- 成果物の path の形が、同期・trace・画面で揃っているか ----
//
// 同期（server/src/artifacts.ts）が承認を判定する path と、trace（collect.mjs）がセッションへ結ぶ path は
// 同じ集合でなければならない。片方だけ変えると、結んだのに表示されない、または承認を通らない path が結ばれる。
const artifactPatterns = {
  "server/src/artifacts.ts（同期と API）": grab(
    "server/src/artifacts.ts",
    /const ARTIFACT_PATH = (\/.*\/);/,
    "server の ARTIFACT_PATH",
  ),
  "plugin/skills/trace/lib/collect.mjs（trace）": grab(
    "plugin/skills/trace/lib/collect.mjs",
    /export const ARTIFACT = (\/.*\/);/,
    "trace の ARTIFACT",
  ),
};
if (new Set(Object.values(artifactPatterns).filter(Boolean)).size > 1) {
  fail.push(
    `成果物の path の形が揃っていない。次を同じ正規表現にする:\n    ${Object.entries(artifactPatterns)
      .map(([where, re]) => `${where}: ${re}`)
      .join("\n    ")}`,
  );
}
const pathKinds = Object.values(artifactPatterns)[0]
  ?.match(/\(([a-z|]+)\)\\\.md/)?.[1]
  ?.split("|");
const screenKinds = grab(
  "dashboard/src/app/(dashboard)/sessions/_sessions/api/sessions.ts",
  /kind: ((?:"[a-z]+"(?: \| )?)+);/,
  "画面の SessionArtifact.kind",
)?.match(/[a-z]+/g);
if (pathKinds && screenKinds && pathKinds.sort().join() !== [...screenKinds].sort().join()) {
  fail.push(
    `成果物の種別が揃っていない: path は ${pathKinds.join(" / ")}、画面の SessionArtifact.kind は ${screenKinds.join(" / ")}`,
  );
}

// ---- README の CLI 一覧を USAGE から書き出す ----
//
// **突き合わせずに消す。**同じ説明を 2 箇所に書くと必ずずれる（実測: 9 コマンドのうち
// import-github だけが README 側で issue に触れ、doctor は README だけが更新されていた）。
// 正本は USAGE — 端末で `mitos` を叩いた人が見るのはこちらで、README は読み物だから。
const usage = grab("server/src/cli.ts", /const USAGE = `使い方:\n(.*?)\n\n/s, "cli.ts の USAGE");
if (usage) {
  const list = usage
    .split("\n")
    .map((l) => l.replace(/^ {2}/, ""))
    .join("\n");
  const before = read("README.md");
  const block = /(## CLI\n\n```\n)[\s\S]*?(\n```\n)/;
  // **「置換が起きたか」と「中身が変わったか」を分ける。**同じにすると、既に一致している
  // ときと節が消えたときが区別できず、揃っているだけで落ちる。
  if (!block.test(before)) {
    fail.push("README.md の「## CLI」直後のコードブロックが見つからない。節を消したなら本スクリプトも直す");
  } else {
    const after = before.replace(block, `$1${list}$2`);
    if (after !== before) {
      fs.writeFileSync("README.md", after);
      // **書いたときだけ staged へ戻す。**呼び出し側で無条件に `git add README.md` すると、
      // 一覧が既に一致している場合でも走り、README に残していた別件の編集を
      // そのコミットへ巻き込む（生成物だけの plugin/dist とは違い、ここは人が書く本文を含む）。
      execFileSync("git", ["add", "README.md"], { stdio: "ignore" });
      console.log("README.md の CLI 一覧を cli.ts の USAGE から書き直して staged へ戻した");
    }
  }
}

if (fail.length) {
  console.error(`\n${fail.map((f) => `  ${f}`).join("\n\n")}\n`);
  process.exit(1);
}
