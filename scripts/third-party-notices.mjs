#!/usr/bin/env node
// バンドルした依存の著作権表示とライセンス文を集める。
//
// **bundle して 1 ファイルにしても、同梱の義務は消えない。**MIT は著作権表示と許諾文の同梱を求め、
// Apache-2.0 は 4 条で License の写しと（あれば）NOTICE の内容を求める。配る物には次が入るので対象になる。
//
//   dist/{cli,mcp,capture}.js  server の依存をバンドルしたもの（Ink と React も入る）
//
// **optional を外さない。**「取り込まれない」と決めつけると、実際にバンドルされたものを落とす。
// 多く挙げる方へ倒す — 足りない側の誤りだけが義務違反になる。peer は解決された実体が node_modules にあるときだけ拾う。

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** バンドルする入力を持つワークスペース。 */
const WORKSPACES = ["server"];

const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

/**
 * name を from から辿って解決する。node の解決と同じく、近い node_modules から上へ探す。
 * 同じ名前でバージョンが違う実体が並ぶので（入れ子の chalk 4 と 5 など）、解決先の実体で数えないと、配る物と違うバージョンを載せる。
 */
const resolveFrom = (from, name) => {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const cand = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(cand, "package.json"))) return cand;
    if (path.dirname(dir) === dir || dir === root) return null;
  }
};
const manifestAt = (dir) => {
  const raw = dir && read(path.join(dir, "package.json"));
  return raw ? JSON.parse(raw) : null;
};

// 推移閉包。解決先の実体 path で数える（同じ名前の別のバージョンを 1 つに潰さない）。
// dependencies と optionalDependencies の両方を辿る。
const seen = new Map();
const queue = [];
for (const w of WORKSPACES) {
  const base = path.join(root, w);
  const p = JSON.parse(read(path.join(base, "package.json")));
  for (const n of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) queue.push([base, n]);
}
while (queue.length) {
  const [from, name] = queue.shift();
  const dir = resolveFrom(from, name);
  if (!dir || seen.has(dir)) continue; // 解決されない optional / peer は成果物にも入らない
  const m = manifestAt(dir);
  if (!m) continue;
  seen.set(dir, name);
  for (const n of Object.keys({ ...m.dependencies, ...m.optionalDependencies })) queue.push([dir, n]);
}

/**
 * その package が配っているライセンス文。
 * **README も見る。**本文を README にだけ置く package があり、
 * LICENSE ファイルだけを探すと本文を落として出典 URL しか出せない。
 */
// **名前を固定で並べない。**`LICENSE-MIT.txt` `LICENSE.BSD` `LICENCE` のように綴りが割れていて、
// 並べ挙げると取りこぼす（実測: 6 package をこれで落としていた）。頭が licen/copying なら拾う。
const LICENSE_NAME = /^(licen[cs]e|copying)([-._].*)?$/i;
const README_FILES = ["README.md", "Readme.md", "readme.md", "README"];

/** README からライセンスの節だけを切り出す。見出しから次の同位の見出しまで。 */
function fromReadme(dir) {
  for (const f of README_FILES) {
    const text = read(path.join(dir, f));
    if (!text) continue;
    const m = text.match(/^(#{1,6})\s*(?:The\s+)?(?:MIT\s+)?Licen[cs]e.*$/im);
    if (!m) continue;
    const start = m.index + m[0].length;
    const rest = text.slice(start);
    const next = rest.search(new RegExp(`^#{1,${m[1].length}}\\s`, "m"));
    const body = (next === -1 ? rest : rest.slice(0, next)).trim();
    // 「MIT」の 1 語だけを本文と数えない。許諾文の実体があること。
    if (body.length > 200 && /permission is hereby granted|copyright/i.test(body)) return body;
  }
  return null;
}

const licenseText = (dir) => {
  if (!dir) return null;
  let names = [];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return null;
  }
  // 複数あるとき（LICENSE-MIT と LICENSE-APACHE の二重ライセンス等）は全部載せる。
  const found = names.filter((f) => LICENSE_NAME.test(f)).sort();
  const texts = found.map((f) => ({ f, t: read(path.join(dir, f))?.trim() })).filter((x) => x.t);
  if (texts.length) {
    return {
      text: texts.map((x) => (texts.length > 1 ? `--- ${x.f} ---\n${x.t}` : x.t)).join("\n\n"),
      from: texts.map((x) => x.f).join(" / "),
    };
  }
  const readme = fromReadme(dir);
  return readme ? { text: readme, from: "README" } : null;
};

/** Apache-2.0 の 4(d) が要求する NOTICE の内容。 */
const noticeText = (dir) => read(path.join(dir, "NOTICE"))?.trim() ?? null;

/**
 * ライセンス文を同梱しない package のための写し。
 * **Apache-2.0 は License の写しを渡すことを 4(a) で求める**ので、package が入れていなくても
 * 再配布する側が用意する。置くのは ASF の定型そのもの（Appendix の著作権欄がテンプレートのまま）で、
 * **誰かの package が自分の名前を埋めた写しを使わない** — 別の権利者の節にその名前が出る。
 */
const SPARE = path.join(path.dirname(fileURLToPath(import.meta.url)), "licenses");
const spareText = (spdx) => read(path.join(SPARE, `${spdx}.txt`))?.trim() ?? null;

/**
 * その package の上流から取ってきた写し（`scripts/licenses/packages/<名前>.txt`）。
 * **定型より先に使う。**package が tarball に入れ忘れているだけで、上流には実物があることがある
 * （実測: react-remove-scroll-bar は GitHub に LICENSE があり、npm の tarball に入っていない）。
 * `/` は `__` に置き換えて 1 ファイルにする（@scope/name のため）。
 */
const upstreamText = (name) =>
  read(path.join(SPARE, "packages", `${name.replace(/\//g, "__")}.txt`))?.trim() ?? null;

const source = (m) => {
  const r = typeof m?.repository === "string" ? m.repository : m?.repository?.url;
  return (
    r
      ?.replace(/^git\+/, "")
      .replace(/^git:\/\//, "https://")
      .replace(/\.git$/, "") ?? null
  );
};

const entries = [...seen]
  .map(([dir, name]) => ({ dir, name }))
  .sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir))
  .map(({ dir, name }) => {
    const m = manifestAt(dir);
    const spdx = typeof m?.license === "string" ? m.license : (m?.license?.type ?? "不明");
    const up = upstreamText(name);
    const own = licenseText(dir) ?? (up ? { text: up, from: "上流" } : null);
    const spare = own ? null : spareText(spdx);
    return {
      name,
      version: m?.version ?? "不明",
      spdx,
      text: own?.text ?? spare,
      from: own?.from ?? (spare ? `${spdx} の定型` : null),
      notice: noticeText(dir),
      source: source(m),
    };
  });

const missing = entries.filter((e) => !e.text);
const out = [
  "# 同梱した第三者のソフトウェア",
  "",
  "配る物には次の package のコードとフォントが入っている。著作権は各権利者にあり、",
  "ライセンスは以下のとおり。gleanery 自身のライセンスは `LICENSE`（MIT）にある。",
  "",
  "この文書は `node scripts/third-party-notices.mjs` が生成する。手で書き足さない。",
  "",
  "| package | バージョン | ライセンス |",
  "|---|---|---|",
  ...entries.map((e) => `| ${e.name} | ${e.version} | ${e.spdx} |`),
  "",
];
for (const e of entries) {
  out.push(`## ${e.name} ${e.version}`, "", `SPDX: ${e.spdx}`);
  if (e.source) out.push(`出典: ${e.source}`);
  out.push("");
  if (e.notice) out.push("NOTICE:", "", "```", e.notice, "```", "");
  if (e.from === "上流") {
    out.push("_この package は配布物にライセンス文を入れていない。上流のリポジトリの写しを載せる。_", "");
  }
  if (e.from === `${e.spdx} の定型`) {
    out.push(
      `_この package も上流も、著作権表示を含むライセンス文を配っていない（宣言は ${e.spdx}）。` +
        `${e.spdx} の定型を載せる。著作権は上の出典の権利者にある。_`,
      "",
    );
  }
  if (e.text) out.push("```", e.text, "```");
  out.push("");
}

const dest = path.join(root, "plugin", "THIRD_PARTY_NOTICES.md");
fs.writeFileSync(dest, `${out.join("\n").trimEnd()}\n`);
console.log(`同梱の告知: ${entries.length} package`);

// **本文を 1 件でも出せないなら失敗にする。**出典 URL の提示は同梱の代わりにならない。
if (missing.length) {
  console.error(
    [
      `ライセンス文を出せない package が ${missing.length} 件ある。`,
      "",
      ...missing.map((e) => `  ${e.name}@${e.version}  ${e.spdx}  ${e.source ?? ""}`),
      "",
      "  package 自身の LICENSE / README から取れないなら、scripts/licenses/<SPDX>.txt に",
      "  その SPDX の定型を置く（著作権者を埋めていないものにする）。",
    ].join("\n"),
  );
  process.exit(1);
}
const unknown = entries.filter((e) => e.spdx === "不明");
if (unknown.length) {
  console.error(`ライセンスが読めない package がある: ${unknown.map((e) => e.name).join(", ")}`);
  process.exit(1);
}
