#!/usr/bin/env node
// 束ねた依存の著作権表示とライセンス文を集める。
//
// **bundle して 1 ファイルにしても、同梱の義務は消えない。**MIT は著作権表示とライセンス文の
// 同梱を求め、Apache-2.0 は 4 条で LICENSE の写しと（あれば）NOTICE の内容を求める。
// dist/*.js は依存のコードをそのまま含むので、配る tarball にこの文書が要る。
//
// 対象は server の dependencies の推移閉包。bundle が実際に取り込むのはそのうち import された
// ものだけだが、**多く挙げる方へ倒す** — 足りない方の誤りだけが義務違反になる。

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nm = path.join(root, "server", "node_modules");

const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
const manifest = (name) => {
  const raw = read(path.join(nm, name, "package.json"));
  return raw ? JSON.parse(raw) : null;
};

// 推移閉包。optional / peer は取り込まれないので辿らない。
const direct = Object.keys(JSON.parse(read(path.join(root, "server", "package.json"))).dependencies ?? {});
const seen = new Set();
for (const queue = [...direct]; queue.length; ) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  const m = manifest(name);
  if (!m) continue;
  seen.add(name);
  queue.push(...Object.keys(m.dependencies ?? {}));
}

/** その package が配っているライセンス文。無ければ null（SPDX だけ載せる）。 */
const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENCE", "COPYING"];
const licenseText = (name) => {
  for (const f of LICENSE_FILES) {
    const t = read(path.join(nm, name, f));
    if (t?.trim()) return t.trim();
  }
  return null;
};
/** Apache-2.0 の 4(d) が要求する NOTICE の内容。 */
const noticeText = (name) => read(path.join(nm, name, "NOTICE"))?.trim() ?? null;

/**
 * ライセンス文を同梱しない package のための写し。
 * **Apache-2.0 は「この License の写しを渡す」ことを 4(a) で求める**ので、package が入れて
 * いなくても再配布する側が用意する。全文は定型で著作権者を含まないので、写しを 1 つ持てば足りる。
 * MIT は著作権表示が package ごとに違うため、写しで代用できない（出典を指す）。
 */
const SPARE = path.join(path.dirname(fileURLToPath(import.meta.url)), "licenses");
const spareText = (spdx) => read(path.join(SPARE, `${spdx}.txt`))?.trim() ?? null;

const source = (m) => {
  const r = typeof m?.repository === "string" ? m.repository : m?.repository?.url;
  return (
    r
      ?.replace(/^git\+/, "")
      .replace(/^git:\/\//, "https://")
      .replace(/\.git$/, "") ?? null
  );
};

const entries = [...seen].sort().map((name) => {
  const m = manifest(name);
  const spdx = typeof m?.license === "string" ? m.license : (m?.license?.type ?? "不明");
  const own = licenseText(name);
  return {
    name,
    version: m?.version ?? "不明",
    spdx,
    text: own ?? spareText(spdx),
    // 写しで補ったものは、どこから来た文かを書く（package 自身の文と区別する）。
    spare: !own && spareText(spdx) !== null,
    notice: noticeText(name),
    source: source(m),
  };
});

const missing = entries.filter((e) => !e.text);
const out = [
  "# 同梱した第三者のソフトウェア",
  "",
  "`dist/` の JavaScript は次の package を束ねている。各 package の著作権は各権利者にあり、",
  "ライセンスは以下のとおり。gleanery 自身のライセンスは `LICENSE`（MIT）にある。",
  "",
  "この文書は `node scripts/third-party-notices.mjs` が生成する。手で書き足さない。",
  "",
  "| package | 版 | ライセンス |",
  "|---|---|---|",
  ...entries.map((e) => `| ${e.name} | ${e.version} | ${e.spdx} |`),
  "",
];
for (const e of entries) {
  out.push(`## ${e.name} ${e.version}`, "", `SPDX: ${e.spdx}`);
  if (e.source) out.push(`出典: ${e.source}`);
  out.push("");
  if (e.notice) out.push("NOTICE:", "", "```", e.notice, "```", "");
  if (e.spare) out.push(`_この package はライセンス文を同梱していない。${e.spdx} の全文を載せる。_`, "");
  if (e.text) {
    out.push("```", e.text, "```");
  } else {
    out.push(`_この package はライセンス文を同梱していない。${e.spdx} の条件は上の出典にある。_`);
  }
  out.push("");
}

const dest = path.join(root, "plugin", "THIRD_PARTY_NOTICES.md");
fs.writeFileSync(dest, `${out.join("\n").trimEnd()}\n`);
console.log(`同梱の告知: ${entries.length} package（ライセンス文が無いもの ${missing.length} 件）`);
if (missing.length) console.log(`  文が無い: ${missing.map((e) => e.name).join(", ")}`);
if (process.argv.includes("--check")) {
  // 生成物を commit しないので、ここでは「集められたか」だけを見る。
  const unknown = entries.filter((e) => e.spdx === "不明");
  if (unknown.length) {
    console.error(`ライセンスが読めない package がある: ${unknown.map((e) => e.name).join(", ")}`);
    process.exit(1);
  }
}
