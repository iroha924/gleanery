#!/usr/bin/env node
// 同じ知識が複数の出口に写されている場所を突き合わせる。
//
// **理由は AGENTS.md「片方を直したら対を探す」。**1 日で 6 回踏んだ形で、
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

// ---- node.kind の一覧が 3 つの出口で揃っているか ----
//
// 正本は DB の check 制約だが、広げる移行が複数ファイルに散るので、出口どうしを突き合わせる。
// **片方に足してもう片方を忘れた**を捕まえられれば足りる。
// 漏れると何が起きるかは .claude/rules/knowledge-schema.md「種別を足したら、出口にも足す」。
const kindSets = {
  "server/src/mcp.ts（MCP の kinds）": grab(
    "server/src/mcp.ts",
    /kinds:\s*z\s*\.array\(\s*z\.enum\(\[([^\]]*)\]\)/,
    "MCP の kinds enum",
  )?.match(/"[a-z_]+"/g),
  "server/src/search.ts（再ランクへ渡す札）": grab(
    "server/src/search.ts",
    /const LABEL[^{]*\{(.*?)^\};/ms,
    "search.ts の LABEL",
  )?.match(/^\s*"([a-z_]+)\//gm),
  "dashboard/src/app/(dashboard)/search/page.tsx（画面の絞り込み）": grab(
    "dashboard/src/app/(dashboard)/search/page.tsx",
    /const KINDS = \[(.*?)\] as const;/s,
    "画面の KINDS",
  )?.match(/\["[a-z_]+"/g),
};

const kinds = {};
for (const [where, hit] of Object.entries(kindSets)) {
  // **0 件を「差が無い」と読ませない。**ここで黙って飛ばすと、その出口が照合から外れたまま
  // 全体は成功で終わる。検査が効かなくなったこと自体を差と同じ強さで報告する。
  if (!hit?.length) {
    fail.push(`${where} から kind を 1 つも取り出せない。check-pairs.mjs の正規表現が実物とずれている`);
    continue;
  }
  kinds[where] = new Set(hit.map((s) => s.replace(/[^a-z_]/g, "")));
}
const all = new Set(Object.values(kinds).flatMap((s) => [...s]));
for (const [where, set] of Object.entries(kinds)) {
  const missing = [...all].filter((k) => !set.has(k)).sort();
  if (missing.length) {
    fail.push(
      `kind の ${missing.join(" / ")} が ${where} に無い。` +
        "足し方は .claude/rules/knowledge-schema.md「種別を足したら、出口にも足す」",
    );
  }
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
