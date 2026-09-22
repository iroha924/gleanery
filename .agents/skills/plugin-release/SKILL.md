---
name: plugin-release
description: gleaneryのMCP、CLI、自動記録のhook、画面の配布物、plugin SkillまたはAgentを変更してnpmへ届ける。bundle入口とその依存module、versionの一致、Claude/Codex両方への到達確認が対象。HTTP APIやdashboardの実装だけの変更には使わない。
---

# 配布物を届ける

## Triggers

- `server/src/mcp.ts`、`server/src/cli.ts`、`server/src/capture.ts`、またはそれらがimportするmoduleを変更する
- `plugin/hooks/hooks.json`を変更する
- `plugin/skills/`を変更する
- 配布するversionを上げる、npmへpublishする
- ローカル変更がClaude CodeやCodexに届かない原因を調べる

## Does not trigger

- HTTP APIや画面の実装だけを変更する
- DB schemaやroleを変更する。その場合は`knowledge-schema`を使う

## 配布経路

**正本はnpmのpackage 1つ**で、Claude CodeとCodexのpluginはmarketplaceの`npm` sourceでそれを指す。
Claude Codeはpackageをnpm clientで解決し、tarballをplugin cacheへ展開する。

- **install scriptは走らず、依存もinstallされない。**tarballは自己完結している必要がある
  （`bun build`で束ねた1 fileずつと、画面のbuild成果物を同梱する）
- cacheは版が変わったときだけ更新される。`bun run bundle`やcommitだけでは届かず、publishまで届かない
- CLIは実行した場所の`dist/cli.js`を読むため、CLIで動くことはMCPで動く証拠にならない
- 自動記録のhookは`${CLAUDE_PLUGIN_ROOT}/dist/capture.js`を叩くので、これもcacheの版で動く
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

`dist/`は依存のcodeをそのまま含むので、**束ねてnpmのdependenciesを0にしても同梱の義務は消えない**。
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
| `npm-only` | dashboard、dashboard用Hono APIだけ | `plugin/package.json`だけ |
| `plugin` | MCP、CLI、自動記録、hook、plugin Skill/Agent、共有module | npm packageとplugin channelの3箇所 |

dashboard/Honoだけのreleaseでは、Claude/Codexのmanifestとmarketplaceを動かさず、plugin cacheも更新しない。
両方の変更が混じったら`plugin`として扱う。判定の正本は`scripts/lib/release-scope.mjs`で、version gateと
release commandが同じものを読む。

1. release versionを決める。`npm-only`は`plugin/package.json`だけを上げる。`plugin`は次を全部そこへ揃える
   - npmの`package.json`
   - `plugin/.claude-plugin/plugin.json`
   - `plugin/.codex-plugin/plugin.json`
   - marketplaceの`npm` sourceの**exact version**（範囲や`latest`を書かない。同じcommitが時期によって
     別のtarballを解決する）
   - gitのtag
2. marketplace entry直下に`version`を置かない。`plugin.json`が無警告で優先され、古い値がupdateを隠す
3. CIとレビューが通ったcommitを`<reviewed commit>`として固定する。そのcommitのcleanな状態で
   `bun run release:prepare -- --base <前回のrelease commit>`を実行する。これは`verify`とbundleを行い、
   staging directoryへtarballを1回だけ作って展開し、次を検査する
   - `npm pack --json`のfile一覧に、必要なものが全部あるか（`dist/`、`db/`、`skills/`、
     `hooks/`、MCP manifest、plugin manifest）
   - source、env、secret、lockfile、`node_modules`が混ざっていないか
   - 展開した先で`node dist/cli.js --version`が動くか
4. 検査したそのtarballをcandidateとしてpublishする（`npm publish <file>.tgz --tag next`）。
   publishのときに作り直さない。`prepublishOnly`は`npm pack`では走らないので、lifecycleに任せきらない。
   `latest`はここでは動かさない
5. cleanな一時directoryで`npm pack gleanery@<version> --silent`を実行し、registryから取り直した
   exact versionを展開して、4と同じsmoke testを行う。失敗したらmergeせず、内容を直した
   新しいversionでtarballの作成からやり直す。公開済みのversionは上書きできない
6. exact versionのsmoke testが通った後だけ、レビュー済みの内容を変えずmainへmergeする。
   merge後のcommitを`<merge commit>`とし、`git diff --exit-code <reviewed commit> <merge commit>`でtreeが
   変わっていないことを確かめる。差分があればtagと`latest`への昇格を止める
7. `git tag v<version> <merge commit>`でmerge commitへtagを付け、remoteへpushする。tagのpushが
   失敗したら`latest`を動かさず再試行する
8. `npm dist-tag add gleanery@<version> latest`で検査済みのversionを昇格する。merge前は旧安定版が
   `latest`のままで、この操作が失敗してもmarketplaceは公開済みのexact versionを指す
9. cleanな一時directoryで`npm pack gleanery@latest --silent`を実行し、展開して同じsmoke testを行う。
    `npm view gleanery dist-tags --json`で`next`と`latest`がどちらも`<version>`を指すことも確かめる
10. `bun run release:status`でnpmのdist-tag、remote tag、global CLI、marketplace、Claude/Codex cacheを
    一覧し、残った工程が無いことを確かめる。観測に失敗した項目は「無い」ではなく「不明」と出る

同じname/versionは再publishできない。壊れたtarballを同じversionで直せないので、4と6の検査を飛ばさない。

## 届いたことを確かめる

`gleanery doctor`は「npm packageの版」と「plugin channelの版」を分けて出す。

1. Claude Code: marketplaceを更新してinstallし直し、開いているsessionで`/reload-plugins`。
   対話端末の無いsessionはMCPが次のsessionまで旧版のまま
2. Codex: 同じくmarketplaceを更新してから開き直す
3. **`npm i -g gleanery@<版>`も叩く。**`npm i -g`で入れたCLIはplugin のcacheと別経路で、
   ホストの更新では上がらない。**DBのrevisionを上げた回は、これを忘れると古いCLIだけが
   「revision N を期待している」で落ちる**（実測: revision 5へ上げた後、globalのCLIが0.32.0のまま残った）
4. `gleanery doctor`で、npm packageはrepositoryとglobal CLI、plugin channelはrepositoryと両ホストのcacheが
   それぞれ揃い、実行中のMCPに張り直しの指示が残っていないことを見る。dashboard/Honoだけのreleaseでは、
   npm packageの版がplugin channelより新しいのが正常
5. 反映後のsessionから`recall`を呼び、変更したMCP tool、Skill、Agentの中身を確かめる。自動記録を変えたなら、
   そのsessionの発言がダッシュボードの`/sessions`に出ることと、`gleanery doctor`の「自動記録」行に待ちが
   残っていないことも見る

`plugin/skills/review/reviewers/`もcache経由なので、保存やsession再起動だけでは新しい本文にならない。
観点を変更する場合は先に`plugin-agent-authoring`も読む。

## plugin Skill

- 明示起動だけにするSkillは、SKILL.mdの`disable-model-invocation: true`（Claude Code）と、Skillディレクトリの
  `agents/openai.yaml`の`policy.allow_implicit_invocation: false`（Codex）を対で置く。Codexは前者を解釈しない。
  対は`verify:ai`が検査する
- `allowed-tools`に`${CLAUDE_PLUGIN_ROOT}`を書いた事前承認は効く。2026-09-12に、一時リポジトリで
  `claude -p "/gleanery:init" --plugin-dir <plugin> --permission-mode default --output-format json`を実行し、
  `.gleanery`が作られて`permission_denials`が空だった（利用者の設定にgleaneryを許すBashのルールは無い）。
  requirementsとdesignは書き込みを事前承認に入れない。承認済みの本文を確認なしで書き換えられると、
  次の同期でそのままapprovedとして入る
- 届いた後の確認では、Codexで`$gleanery:<skill>`の明示起動でも本文が読まれることを確かめる

人向けのCLI出力とAI向けのMCP応答は別々に確認する。
