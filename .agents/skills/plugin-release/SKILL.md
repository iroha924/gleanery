---
name: plugin-release
description: gleaneryのMCP、CLI（端末の画面を含む）、自動記録のhook、plugin SkillまたはAgentを変更してnpmへ届ける。bundleのエントリポイントとその依存module、versionの一致、Claude/Codex両方への到達確認が対象。DB schemaやroleだけの変更には使わない。
---

# 配布物を届ける

## Triggers

- `server/src/mcp.ts`、`server/src/cli.ts`、`server/src/capture.ts`、またはそれらがimportするmoduleを変更する
- `plugin/hooks/hooks.json`を変更する
- `plugin/skills/`を変更する
- 配布するversionを上げる、npmへpublishする
- ローカル変更がClaude CodeやCodexに届かない原因を調べる

## Does not trigger

- DB schemaやroleを変更する。その場合は`knowledge-schema`を使う

## 配布経路

**正本はnpmのpackage 1つ**で、Claude CodeとCodexのpluginはmarketplaceの`npm` sourceでそれを指す。
Claude Codeはpackageをnpm clientで解決し、tarballをplugin cacheへ展開する。

- **install scriptは走らず、依存もinstallされない。**tarballは自己完結している必要がある
  （`bun build`でバンドルした1 fileずつを同梱する）。DBは`node:sqlite`（Nodeの組み込み）なので、ネイティブ依存を持たない
- CLIはInkを含むので`scripts/bundle-cli.ts`（`Bun.build`）でバンドルする。Inkは`DEV=true`のときだけ`react-devtools-core`を
  読みにいくので、`ink/build/devtools.js`を空のmoduleへ差し替える（差し替えないと、上の階層に`react-devtools-core`が
  ある環境で起動ごと落ちる）
- 同梱の`db/schema.sql`（と、あれば`db/migrations`）を`gleanery init` / `gleanery db migrate`が読む。CIは展開した
  tarballの CLI で一時HOMEに`init`を打って確かめる
- cacheはバージョンが変わったときだけ更新される。`bun run bundle`やcommitだけでは届かず、publishまで届かない
- CLIは実行した場所の`dist/cli.js`を読むため、CLIで動くことはMCPで動く証拠にならない
- 自動記録のhookは`${CLAUDE_PLUGIN_ROOT}/dist/capture.js`を叩くので、これもcacheのバージョンで動く
- **`plugin/dist`はgitで追跡しない。**buildはpublishのときに作る

### Skillからの起動経路

Skillが CLI を呼ぶときは、**package内のJSを直接起動する**。

```text
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <サブコマンド>
```

npmの`bin`は、利用者が`npm i -g`したときの`gleanery`コマンド用であって、**plugin内のPATHへ公開される契約は
無い**。`${CLAUDE_PLUGIN_ROOT}/bin/gleanery`のようなshell scriptに依存すると、Windowsで動かないうえ、
npm sourceでは置かれる保証も無い。

## 依存を足すとき

`dist/`は依存のcodeをそのまま含むので、**バンドルしてnpmのdependenciesを0にしても同梱の義務は消えない**。
MITは著作権表示とライセンス文、Apache-2.0は4条でLicenseの写しと（あれば）NOTICEの内容を求める。

- `server/`へ依存を足したら`bun run notices`を通す。SPDXが読めない package があれば落ちる
- `plugin/THIRD_PARTY_NOTICES.md`は`bun run bundle`が`node_modules`から作り直す。追跡せず、publishする物に入る
- ライセンス文を同梱しない package は`scripts/licenses/<SPDX>.txt`の写しで補う。写しが無いものは出典を載せる
- **GPL / AGPL / SSPLの依存を足さない。**MITで配れなくなる

## 届けるまで

最初に`bun run release:plan -- --base <前回のrelease commit>`で変更を分類する。

| 種別 | 変更 | 動かすversion |
|---|---|---|
| `none` | 文書、repository開発用Skill、testだけ | 無し |
| `plugin` | MCP、CLI（端末の画面を含む）、自動記録、hook、plugin Skill/Agent、共有module | npm packageとplugin channelの3箇所 |

判定の正本は`scripts/lib/release-scope.mjs`で、version gateと
release commandが同じものを読む。

1. release versionを決める。`plugin`は次を全部そこへ揃える
   - npmの`package.json`
   - `plugin/.claude-plugin/plugin.json`
   - `plugin/.codex-plugin/plugin.json`
   - marketplaceの`npm` sourceの**exact version**（範囲や`latest`を書かない。同じcommitが時期によって
     別のtarballを解決する）
   - gitのtag
2. marketplace entry直下に`version`を置かない。`plugin.json`が無警告で優先され、古い値がupdateを隠す
最初のreleaseの前に一度だけ、持ち主が画面で設定する（無いとreleaseが止まる、または保護なしで進む）。

- GitHub: environment `npm-release`（reviewerは持ち主、自己承認の禁止はoff、deploymentはtag `v*`を許す）。
  `release.yml`の`prepare`は承認者のいないenvironmentを拒む
- GitHub: tag `v*`の作成・更新・削除を持ち主だけに限るruleset
- npm: trusted publisher（repository `iroha924/gleanery`、workflow `release.yml`、environment `npm-release`、
  直接のpublishは許さずstageだけ）、2FA必須、tokenでのpublishを禁止

3. PRを作り、CI（`check`・`pr-body`）とCodexのレビューを通す。PRのbranchにmainを取り込んだ状態にする
   （mainが先へ進んでいると、CIが検査したtreeとtagのtreeが一致しない）
4. **PRのhead**に`git tag v<version> <head>`を打ってpushする。mainではなくheadに打つので、merge前に候補を検査できる。
   tagは持ち主だけが作れる（rulesetで限る）
5. `.github/workflows/release.yml`が動く。`prepare`がtagと全versionの一致、tagのcommitがmainへ向かうopenなPRのhead
   であること、そのheadで`check`と`pr-body`が成功していることを確かめ（`scripts/release-gate.mjs`）、`verify`の後に
   `npm pack`して`scripts/check-tarball.mjs`で検査する（一覧、リポジトリの外での起動、一時HOMEでの`init`）。
   SHA-512とintegrityがjob summaryに出る
6. environment `npm-release`を承認すると、`stage`が同じ判定をもう一度通し、同じtarballのSHA-512を照合してから
   `npm stage publish <tgz> --tag next --provenance`を打つ。stage IDがjob summaryに出る
7. 手元で`npm stage download <stage-id>`を打ち、`shasum -a 512`の値が5のSHA-512と一致することを確かめる。
   npmjs.comのStaged Packagesでprovenanceを確かめ、2FAで承認する（`npm stage approve <stage-id>`でもよい）。
   一致しない・provenanceが無いなら承認せず`npm stage reject <stage-id>`
8. mergeの直前にPRのheadとbaseが動いていないことを見て、`gh pr merge <PR> --merge --match-head-commit <head>`で
   mergeする。`git diff --exit-code <head> <merge commit>`でtreeが変わっていないことを確かめる。差分があれば
   `latest`へ上げない
9. cleanな一時directoryで`npm pack gleanery@<version> --silent`を実行し、SHA-512が5と一致すること、リポジトリの
   `node <repository>/scripts/check-tarball.mjs <tgz>`が通ることを確かめる
10. `npm dist-tag add gleanery@<version> latest`で昇格する（OIDCはdist-tagに使えないので手元の認証で打つ）。
    `npm view gleanery dist-tags --json`で`next`と`latest`がどちらも`<version>`を指すことを見る
11. `bun run release:status`でnpmのdist-tag、remote tag、global CLI、marketplace、Claude/Codex cacheを
    一覧し、残った工程が無いことを確かめる。観測に失敗した項目は「無い」ではなく「不明」と出る

**同じ`v<version>`のtagを打ち直さない。**同じversionは二度stageもpublishもできず、provenanceの参照先も追えなくなる。

- stageの前後で失敗した: stageを`npm stage reject`し、直してversionを上げ、新しいtagで出し直す
- 承認した後にmergeできなかった: `latest`へ上げず、`npm dist-tag add gleanery@<直前の正常版> next`で`next`を戻し、
  新しいversionで出し直す
- `stage`の成功後にrunを再実行しない（同じversionのstageが衝突する）

mergeからnpmの承認までの間は、marketplaceが未公開のversionを指さないよう、承認をmergeより先に済ませる（7→8の順）。

## 届いたことを確かめる

`gleanery doctor`は「npm packageのバージョン」と「plugin channelのバージョン」を分けて出す。

1. Claude Code: marketplaceを更新してinstallし直し、開いているsessionで`/reload-plugins`。
   対話端末の無いsessionはMCPが次のsessionまで旧バージョンのまま
2. Codex: 同じくmarketplaceを更新してから開き直す
3. **`npm i -g gleanery@<バージョン>`も叩く。**`npm i -g`で入れたCLIはplugin のcacheと別経路で、
   ホストの更新では上がらない。**DBのrevisionを上げた回は、これを忘れると古いCLIだけが
   「revision N を期待している」で落ちる**（実測: revision 5へ上げた後、globalのCLIが0.32.0のまま残った）
4. `gleanery doctor`で、npm packageはrepositoryとglobal CLI、plugin channelはrepositoryと両ホストのcacheが
   それぞれ揃い、実行中のMCPに張り直しの指示が残っていないことを見る
5. 反映後のsessionから`recall`を呼び、変更したMCP tool、Skill、Agentの中身を確かめる。自動記録を変えたなら、
   そのsessionの発言が`gleanery dashboard`のセッションに出ることと、`gleanery doctor`の「自動記録」行に待ちが
   残っていないことも見る

`plugin/skills/review/reviewers/`もcache経由なので、保存やsession再起動だけでは新しい本文にならない。
観点を変更する場合は先に`plugin-agent-authoring`も読む。

## plugin Skill

- 明示起動だけにするSkillは、SKILL.mdの`disable-model-invocation: true`（Claude Code）と、Skillディレクトリの
  `agents/openai.yaml`の`policy.allow_implicit_invocation: false`（Codex）を対で置く。Codexは前者を解釈しない。
  対は`verify:ai`が検査する
- `allowed-tools`に`${CLAUDE_PLUGIN_ROOT}`を書いた事前承認は効く（2026-09-12に、`claude -p "/gleanery:<skill>" --plugin-dir <plugin>
  --permission-mode default --output-format json`で`permission_denials`が空だった。利用者の設定にgleaneryを許すBashのルールは無い）
- 届いた後の確認では、Codexで`$gleanery:<skill>`の明示起動でも本文が読まれることを確かめる

人向けのCLI出力とAI向けのMCP応答は別々に確認する。
