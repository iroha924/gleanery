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

// ---- 状態の印が、CLI と review の台帳で揃っているか ----
//
// 正本は server/src/panel.ts の MARKS。review Skill は台帳の 4 状態に同じ印を書く（Skill から panel.ts は読めない）。
// 片方だけ変えると、CLI と Skill の報告で同じ状態が別の印になる。印の字を書いてよいのは凡例の 1 行と「### 形」の例の
// 台帳の表（見出しに Claude と Codex の列を持つ表）の状態のセルだけと決め（注記の中は除く。Skill にもそう書いてある）、
// そこは決まった形で読んで組を突き合わせ、ほかの場所に印の字があれば落とす。pre-commit が commit ごとに守らせるので、
// 印を変えても古い印は外に残らない。フックを経ない commit では守られず、CI（PR と main）は先端しか見ない。
// 印でない記号と状態名を並べた書き方（「● 実行」など）は見ない。本文の書き方を読み分けようとすると終わりが無い。
const LEDGER = { ok: "実行", warn: "打ち切り", fail: "不能", none: "未実行" };
const marks = Object.fromEntries(
  [
    ...(
      grab("server/src/panel.ts", /const MARKS = \{([\s\S]*?)\} as const;/, "panel.ts の MARKS") ?? ""
    ).matchAll(/(\w+): \["(.)",/g),
  ].map((m) => [m[1], m[2]]),
);
if (Object.keys(LEDGER).every((k) => marks[k])) {
  const states = Object.values(LEDGER).join("|");
  const skill = "plugin/skills/review/SKILL.md";
  const lines = read(skill).split("\n");
  const pairs = [];
  const legendAt = lines.findIndex((l) => l.includes("状態は印（"));
  const legend = lines[legendAt]?.match(/状態は印（(.*?)）/)?.[1];
  if (legend === undefined) fail.push("review Skill の台帳の凡例（「状態は印（…）」）を取り出せない");
  for (const part of legend?.split(" / ") ?? []) {
    const m = part.match(new RegExp(`^\`([^\`]+)\` (${states})$`));
    if (m) pairs.push([m[1], m[2], "凡例"]);
    else fail.push(`review Skill の台帳の凡例「${part}」は「\`印\` 状態」の形で書く`);
  }
  const missing = Object.values(LEDGER).filter((state) => !pairs.some(([, s]) => s === state));
  if (legend !== undefined && missing.length)
    fail.push(`review Skill の台帳の凡例に ${missing.join(" / ")} が無い`);
  const at = lines.indexOf("### 形");
  const open = at < 0 ? -1 : lines.indexOf("```", at);
  const close = open < 0 ? -1 : lines.indexOf("```", open + 1);
  if (close < 0) fail.push("review Skill の「### 形」の例（``` で囲んだ塊）を取り出せない");
  // GFM の表は両端の | を省けて、\| はセルの中の | になる。空行までが表。
  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/(?<!\\)\|$/, "")
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
  // 印の字を書いてはいけない部分。凡例の中身と、台帳の表の状態のセル（注記の中は除く）だけを外す。
  const outside = [...lines];
  if (legend !== undefined) outside[legendAt] = lines[legendAt].replace(/状態は印（.*?）/, "");
  let tables = 0;
  for (let i = open + 1; i < close; i++) {
    const head = cells(lines[i]);
    if (!head.includes("Claude") || !head.includes("Codex")) continue;
    tables++;
    // 見出しの次の 1 行が区切り（GFM の決まり）。そこから空行までが表の行で、1 列目は観点。
    if (!cells(lines[i + 1] ?? "").every((c) => /^:?-+:?$/.test(c)))
      fail.push(`review Skill の ${i + 2} 行目は、台帳の表の見出しの次なので区切りの行（|---|）にする`);
    for (i += 2; i < close && lines[i].trim(); i++) {
      const [aspect, ...row] = cells(lines[i]);
      outside[i] = aspect;
      for (const cell of row) {
        const m = cell.match(new RegExp(`^(\\S+) (${states})(?:（([^）]*)）)?$`, "u"));
        if (!m) {
          fail.push(`review Skill の「形」の例の台帳のセル「${cell}」は「印 状態（注記）」の形で書く`);
          continue;
        }
        pairs.push([m[1], m[2], "例の台帳"]);
        outside[i] += ` ${m[3] ?? ""}`;
      }
    }
  }
  if (close >= 0 && tables === 0)
    fail.push("review Skill の「形」の例に、Claude と Codex の列を持つ台帳の表が無い");
  outside.forEach((text, i) => {
    for (const glyph of Object.values(marks).filter((g) => text.includes(g)))
      fail.push(
        `review Skill の ${i + 1} 行目に印の ${glyph} がある。印を書くのは凡例と、「形」の例の台帳の表の状態のセル（注記の外）だけにする`,
      );
  });
  for (const [glyph, state, where] of pairs) {
    const key = Object.keys(LEDGER).find((k) => LEDGER[k] === state);
    if (marks[key] !== glyph)
      fail.push(
        `review Skill の${where}が「${state}」に ${glyph} を書いている。panel.ts の ${key} は ${marks[key]}`,
      );
  }
} else {
  fail.push(
    "panel.ts の MARKS から ok / warn / fail / none の印を取り出せない。check-pairs.mjs の正規表現が実物とずれている",
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
