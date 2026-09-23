#!/usr/bin/env node
// plugin の配布物が変わったのに版が上がっていないものを落とす。pre-commit はこれから作る commit を、
// CI は `--base` で渡した commit から HEAD までをまとめて見る。
//
// 配布経路と壊れ方は .agents/skills/plugin-release/SKILL.md が正本。
// 見るのはソースではなくバンドルそのもの — `mcp.js` には search.ts も db.ts も
// 畳み込まれるので、`mcp.ts` を触ったかだけで判定すると穴が開く（実際に開いた）。

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { isPackageInput, releaseKind, withoutReleaseVersion } from "./lib/release-scope.mjs";

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

// plugin channel の版は 3 箇所にある。片方だけ上げても届かないので、全部を見る。
// 実測（2026-09-09）: Claude 側が 13 回上がるあいだ、**Codex 側は作られたときの 0.1.0 のまま
// 一度も上がっていなかった。**このゲート自身が Claude 側しか見ていなかったため、
// 「版を上げ忘れたら止まる」という約束が片側にしか効いていなかった。
// npm package はdashboard/Honoだけのreleaseでも進む。plugin channelの3つは互いに揃えるが、
// npm packageより古い状態を許す。
const PACKAGE = "plugin/package.json";
const PLUGIN_MANIFESTS = {
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
const packageVersion = read(PACKAGE).version;
const versions = Object.entries(PLUGIN_MANIFESTS).map(([f, pick]) => [f, pick(read(f))]);
const distinct = [...new Set(versions.map(([, v]) => v))];
if (distinct.length !== 1) {
  console.error(
    [
      "plugin channel のバージョンが揃っていない。",
      "",
      ...versions.map(([f, v]) => `  ${v}  ${f}`),
      "",
      "  配る先ごとにmanifestがある。片方だけ上げると、もう片方の利用者には",
      "  古い中身が届き続ける。plugin channelの3つを同じバージョンにする。",
    ].join("\n"),
  );
  process.exit(1);
}
const pluginVersion = distinct[0];
if (pluginVersion.localeCompare(packageVersion, undefined, { numeric: true }) > 0) {
  console.error(`plugin channel（${pluginVersion}）をnpm package（${packageVersion}）より先へ進められない。`);
  process.exit(1);
}

// **変わったファイルも index（commit に入る内容）で見る。**作業ツリーを読むと、bundle が
// 書き終える前に読んで素通りする。CI は checkout 直後で index が HEAD と同じなので、基準を
// `--base` へ変えるだけで同じ比べ方になる。
//
/**
 * manifest から版を落とした姿。**版だけを上げた commit を「中身が変わった」に数えない**ため。
 * ただし落とすのは版だけで、`files` と `bin` と MCP の起動引数は配る物を変えるので残す
 * （これを丸ごと除外していたため、公開する一覧を変えて版を据え置く commit が素通りしていた）。
 */
const ref = base ?? "HEAD";
const changed = git("diff", "--cached", "--name-only", ref)
  .split("\n")
  .filter(Boolean)
  .filter(isPackageInput)
  .filter(
    (f) =>
      (f !== PACKAGE && !(f in PLUGIN_MANIFESTS)) ||
      withoutReleaseVersion(at(ref, f)) !== withoutReleaseVersion(staged(f)),
  );
if (changed.length === 0) process.exit(0);

const kind = releaseKind(changed);
const oldPackageVersion = JSON.parse(at(ref, PACKAGE) ?? "{}").version;
const oldPluginVersion = JSON.parse(at(ref, "plugin/.claude-plugin/plugin.json") ?? "{}").version;

if (kind === "npm") {
  if (oldPluginVersion !== pluginVersion) {
    console.error(
      `dashboard/Honoだけの変更ではplugin channelを更新しない（${oldPluginVersion} → ${pluginVersion}）。`,
    );
    process.exit(1);
  }
  if (oldPackageVersion !== packageVersion) process.exit(0);
  console.error(
    `npm packageの${changed.length}個が変わったのにバージョンが${packageVersion}のままになっている（${changed[0]}など）。\n\n` +
      "  plugin manifestとmarketplaceは動かさず、plugin/package.jsonのversionだけを上げる。",
  );
  process.exit(1);
}

if (
  oldPackageVersion !== packageVersion &&
  oldPluginVersion !== pluginVersion &&
  packageVersion === pluginVersion
) {
  process.exit(0);
}

console.error(
  [
    `plugin channelの${changed.length}個が変わったが、npm packageとpluginのバージョンが揃って上がっていない（${changed[0]}など）。`,
    "",
    "  marketplace（GitHub）から入れた plugin は、Claude Code も Codex も <cache>/gleanery/gleanery/<バージョン>/ の複製から動く。",
    "  複製はバージョンが変わったときだけ起きるので、このままではsessionへ届かない。",
    "",
    "  npm packageとplugin channelの3 manifestを同じ新しいversionへ上げる。",
    "  marketplace の取得元へ入れた後、`gleanery doctor` の「plugin channel のバージョン」が出す更新手順を叩き、セッションを張り直す。",
  ].join("\n"),
);
process.exit(1);
