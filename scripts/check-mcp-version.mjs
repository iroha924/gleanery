#!/usr/bin/env node
// plugin の配布物が変わったのに版が上がっていないものを落とす。pre-commit はこれから作る commit を、
// CI は `--base` で渡した commit から HEAD までをまとめて見る。
//
// 配布経路と壊れ方は .agents/skills/plugin-release/SKILL.md が正本。
// 見るのはソースではなくバンドルそのもの — `mcp.js` には search.ts も db.ts も
// 畳み込まれるので、`mcp.ts` を触ったかだけで判定すると穴が開く（実際に開いた）。

import { execFileSync } from "node:child_process";
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
// 配る正本は npm の package で、plugin の manifest はそれと同じ版を指す。1 つでもずれると届かない。
const MANIFESTS = {
  "plugin/package.json": (j) => j.version,
  // **版は source の中にある。**entry 直下にも置くと、Claude Code は警告なく plugin.json を使い、
  // marketplace の値が黙って無視される（公式の plugin-marketplaces）。置き場所は 1 つに保つ。
  ".claude-plugin/marketplace.json": (j) => j.plugins?.find((x) => x.name === "gleanery")?.source?.version,
  "plugin/.claude-plugin/plugin.json": (j) => j.version,
  "plugin/.codex-plugin/plugin.json": (j) => j.version,
};

// 版も index から読む。作業ツリーで上げただけの版は commit に入らない。
const read = (f) => JSON.parse(git("show", `:${f}`));
/** index（commit に入る内容）での姿。ref を空にすると `git show :path` になる。 */
const staged = (f) => at("", f);
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

// **変わったファイルも index（commit に入る内容）で見る。**作業ツリーを読むと、bundle が
// 書き終える前に読んで素通りする。CI は checkout 直後で index が HEAD と同じなので、基準を
// `--base` へ変えるだけで同じ比べ方になる。
//
// **配る中身を変えうる入力を全部挙げる。**キャッシュへ複製されるのは mcp.js だけではなく、
// 自動記録（dist/capture.js）もフックの定義もスキル（skills/**）も画面も DB の同梱物も入る。
// dist と db は追跡しないので、ここから漏れた入力を変えると、中身が変わったのに版が据え置かれる。
// src だけでなく、依存の版（lockfile）、build と型の設定、公開する物の一覧も中身を変える。
const INPUTS = [
  "plugin/",
  // .claude-plugin/marketplace.json は入れない。**リポジトリ直下にあり npm の files に入らない**ので、
  // これを変えても配る tarball の中身は 1 バイトも変わらない。版の一致は MANIFESTS が、
  // 取得元は scripts/check-ai-config.mjs が見る。

  "server/src/",
  "server/package.json",
  "server/bun.lock",
  "server/tsconfig.json",
  "dashboard/src/",
  "dashboard/public/",
  "dashboard/index.html",
  "dashboard/package.json",
  "dashboard/bun.lock",
  "dashboard/tsconfig.json",
  "dashboard/vite.config.ts",
  "db/",
  "scripts/bundle.mjs",
  "scripts/third-party-notices.mjs",
  "scripts/licenses/",
];
/**
 * manifest から版を落とした姿。**版だけを上げた commit を「中身が変わった」に数えない**ため。
 * ただし落とすのは版だけで、`files` と `bin` と MCP の起動引数は配る物を変えるので残す
 * （これを丸ごと除外していたため、公開する一覧を変えて版を据え置く commit が素通りしていた）。
 */
const withoutVersion = (text) => {
  if (text === null) return null;
  try {
    const o = JSON.parse(text);
    delete o.version;
    // 版の数字だけを落とす。取得元（source の種類と package 名）が変わったかは
    // ここでは見ない — scripts/check-ai-config.mjs が版に関わらず無条件で落とす。
    for (const p of Array.isArray(o.plugins) ? o.plugins : []) {
      delete p.version;
      if (p.source && typeof p.source === "object") delete p.source.version;
    }
    return JSON.stringify(o);
  } catch {
    return text;
  }
};

const ref = base ?? "HEAD";
const changed = git("diff", "--cached", "--name-only", ref, "--", ...INPUTS)
  .split("\n")
  .filter(Boolean)
  .filter((f) => !(f in MANIFESTS) || withoutVersion(at(ref, f)) !== withoutVersion(staged(f)));
if (changed.length === 0) process.exit(0);

const MANIFEST = "plugin/.claude-plugin/plugin.json";
const was = JSON.parse(at(ref, MANIFEST) ?? "{}").version;
const now = distinct[0];
if (was !== now) process.exit(0);

console.error(
  [
    `plugin/ の ${changed.length} 個が変わったのに版が ${now} のままになっている（${changed[0]} など）。`,
    "",
    "  marketplace（GitHub）から入れた plugin は、Claude Code も Codex も <cache>/gleanery/gleanery/<版>/ の複製から動く。",
    "  複製は版が変わったときだけ起きるので、このままでは**どのセッションにも届かない**。",
    "",
    "  4つ（npm の package.json、Claude、Codex、marketplace）のversionを同じ値へ上げる。",
    "  marketplace の取得元へ入れた後、`gleanery doctor` の「plugin の版」が出す更新手順を叩き、セッションを張り直す。",
  ].join("\n"),
);
process.exit(1);
