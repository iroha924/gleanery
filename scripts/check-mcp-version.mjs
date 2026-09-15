#!/usr/bin/env node
// plugin の配布物が変わったのに版が上がっていないものを落とす。pre-commit はこれから作る commit を、
// CI は `--base` で渡した commit から HEAD までをまとめて見る。
//
// 配布経路と壊れ方は .agents/skills/plugin-release/SKILL.md が正本。
// 見るのはソースではなくバンドルそのもの — `mcp.js` には search.ts も db.ts も
// 畳み込まれるので、`mcp.ts` を触ったかだけで判定すると穴が開く（実際に開いた）。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { parseArgs } from "node:util";

const { base } = parseArgs({ options: { base: { type: "string" } } }).values;

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const at = (ref, file) => {
  try {
    return git("show", `${ref}:${file}`);
  } catch {
    return null;
  }
};

try {
  git("rev-parse", "HEAD");
} catch {
  // 最初のコミット。比べる先が無い。
  process.exit(0);
}

// **版は 3 箇所にある。**片方だけ上げても届かないので、全部を見る。
// 実測（2026-09-09）: Claude 側が 13 回上がるあいだ、**Codex 側は作られたときの 0.1.0 のまま
// 一度も上がっていなかった。**このゲート自身が Claude 側しか見ていなかったため、
// 「版を上げ忘れたら止まる」という約束が片側にしか効いていなかった。
const MANIFESTS = {
  ".claude-plugin/marketplace.json": (j) => j.plugins?.find((x) => x.name === "mitos")?.version,
  "plugin/.claude-plugin/plugin.json": (j) => j.version,
  "plugin/.codex-plugin/plugin.json": (j) => j.version,
};

const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const versions = Object.entries(MANIFESTS).map(([f, pick]) => [f, pick(read(f))]);
const distinct = [...new Set(versions.map(([, v]) => v))];
if (distinct.length !== 1) {
  console.error(
    [
      "プラグインの版が揃っていない。",
      "",
      ...versions.map(([f, v]) => `  ${v}  ${f}`),
      "",
      "  **配る先ごとにマニフェストがある。**片方だけ上げると、もう片方の利用者には",
      "  古い中身が届き続ける。3 つとも同じ版にする。",
    ].join("\n"),
  );
  process.exit(1);
}

// **変わったファイルは index（commit に入る内容）で見る。**作業ツリーを読むと、bundle が
// 書き終える前に読んで素通りする。CI は checkout 直後で index が HEAD と同じなので、基準を
// `--base` へ変えるだけで同じ比べ方になる。**対象は plugin/ 配下すべて** — キャッシュへ複製されるのは
// mcp.js だけではなく、自動記録（dist/capture.js）もフックの定義もスキル（skills/**）も入る。
const ref = base ?? "HEAD";
const changed = git("diff", "--cached", "--name-only", ref, "--", "plugin/", ".claude-plugin/")
  .split("\n")
  .filter(Boolean)
  .filter((f) => !(f in MANIFESTS));
if (changed.length === 0) process.exit(0);

const MANIFEST = "plugin/.claude-plugin/plugin.json";
const was = JSON.parse(at(ref, MANIFEST) ?? "{}").version;
const now = distinct[0];
if (was !== now) process.exit(0);

console.error(
  [
    `plugin/ の ${changed.length} 個が変わったのに版が ${now} のままになっている（${changed[0]} など）。`,
    "",
    "  marketplace（GitHub）から入れた plugin は、Claude Code も Codex も <cache>/mitos/mitos/<版>/ の複製から動く。",
    "  複製は版が変わったときだけ起きるので、このままでは**どのセッションにも届かない**。",
    "",
    "  3つのmanifest（Claude、Codex、marketplace）のversionを同じ値へ上げる。",
    "  marketplace の取得元へ入れた後、`mitos doctor` の「plugin の版」が出す更新手順を叩き、セッションを張り直す。",
  ].join("\n"),
);
process.exit(1);
