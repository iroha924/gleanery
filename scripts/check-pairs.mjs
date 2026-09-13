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
/** 引用符で囲んだ語を並べる。1 つも無ければ取り出しの失敗として報告する。 */
const words = (text, quote, what) => {
  const got = [...(text ?? "").matchAll(new RegExp(`${quote}([a-z_-]+)${quote}`, "g"))].map((m) => m[1]);
  if (text !== null && got.length === 0) fail.push(`${what} から値を 1 つも取り出せない`);
  return got;
};
const same = (a, b) => [...a].sort().join() === [...b].sort().join();

// ---- 値の域が、DB の CHECK とコードで揃っているか ----
//
// 正本は db/schema.sql の CHECK。コード側（server/src/knowledge.ts）の写しを、MCP の入力・trace の検査・札・
// 自動記録と取り込みの型が参照する（札の表は型で全部の状態を持たされる）。**片方に足してもう片方を忘れた**を捕まえる。
// DB だけに足すと検索の札が空になり、コードだけに足すと取り込みや自動記録が CHECK で落ちる
// （Read した成果物を action 'read' で送り、CHECK が edit / review しか許さずに自動記録が止まった実例がある）。
const schema = read("db/schema.sql");
const knowledgeTable = schema.slice(
  schema.indexOf("create table mitos.knowledge ("),
  schema.indexOf("create index knowledge_listing"),
);
const PAIRS = [
  ["knowledge.kind", /kind in \(([^)]*)\)\s*\),\s*status text/, "KINDS"],
  ["message.speaker_kind", /speaker_kind text not null check \(speaker_kind in \(([^)]*)\)\)/, "SPEAKERS"],
  ["conversation.origin", /origin text not null check \(origin in \(([^)]*)\)\)/, "ORIGINS"],
  ["message_file.action", /action text not null check \(action in \(([^)]*)\)\)/, "FILE_ACTIONS"],
];
for (const [column, re, constant] of PAIRS) {
  const db = words(grab("db/schema.sql", re, `${column} の CHECK`), "'", `${column} の CHECK`);
  const code = words(
    grab(
      "server/src/knowledge.ts",
      new RegExp(`export const ${constant} = \\[([^\\]]*)\\]`),
      `knowledge.ts の ${constant}`,
    ),
    '"',
    `knowledge.ts の ${constant}`,
  );
  if (db.length && code.length && !same(db, code))
    fail.push(
      `${column} が揃っていない: DB は ${db.join(" / ")}、knowledge.ts の ${constant} は ${code.join(" / ")}`,
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

// ---- 成果物の種別が、同期と画面で揃っているか ----
//
// 同期（server/src/artifacts.ts）が承認を判定する path の種別と、画面が出す成果物の種別は同じ集合でなければならない。
// 自動記録は同じ ARTIFACT_PATH を読み込むので、ここでは突き合わせない。
const artifactPattern = grab(
  "server/src/artifacts.ts",
  /export const ARTIFACT_PATH = (\/.*\/);/,
  "server の ARTIFACT_PATH",
);
const pathKinds = artifactPattern?.match(/\(([a-z|]+)\)\\\.md/)?.[1]?.split("|");
if (artifactPattern && !pathKinds?.length) fail.push("ARTIFACT_PATH から成果物の種別を取り出せない");
const screenKinds = grab(
  "dashboard/src/app/(dashboard)/sessions/_sessions/api/sessions.ts",
  /kind: ((?:"[a-z]+"(?: \| )?)+);/,
  "画面の SessionArtifact.kind",
)?.match(/[a-z]+/g);
if (pathKinds && screenKinds && !same(pathKinds, screenKinds)) {
  fail.push(
    `成果物の種別が揃っていない: path は ${pathKinds.join(" / ")}、画面の SessionArtifact.kind は ${screenKinds.join(" / ")}`,
  );
}

// ---- README の CLI 一覧を USAGE から書き出す ----
//
// **突き合わせずに消す。**同じ説明を 2 箇所に書くと必ずずれる（実測: README 側にだけ書かれた説明と、
// README 側だけが更新された説明が両方あった）。
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
