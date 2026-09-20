---
name: plugin-release
description: gleaneryのMCP、CLI、自動記録のhook、画面の配布物、plugin SkillまたはAgentを変更してnpmへ届ける。bundle入口とその依存module、versionの一致、Claude/Codex両方への到達確認が対象。HTTP APIやdashboardの実装だけの変更には使わない。
---

# 配布物を届ける

## Triggers

- `server/src/mcp.ts`、`server/src/cli.ts`、`server/src/capture.ts`、またはそれらがimportするmoduleを変更する
- `plugin/hooks/hooks.json`を変更する
- `plugin/skills/`、`plugin/agents/`を変更する
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

1. `bun run bundle`で配布物（MCP、CLI、自動記録、画面のbuild成果物、同梱の告知）を作る
2. release versionを1つ決め、次を全部そこへ揃える
   - npmの`package.json`
   - `plugin/.claude-plugin/plugin.json`
   - `plugin/.codex-plugin/plugin.json`
   - marketplaceの`npm` sourceの**exact version**（範囲や`latest`を書かない。同じcommitが時期によって
     別のtarballを解決する）
   - gitのtag
3. marketplace entry直下に`version`を置かない。`plugin.json`が無警告で優先され、古い値がupdateを隠す
4. clean な staging directoryからtarballを1回だけ作り、**その中身を展開して検査する**
   - `npm pack --json`のfile一覧に、必要なものが全部あるか（`dist/`、`db/`、`skills/`、`agents/`、
     `hooks/`、MCP manifest、plugin manifest）
   - source、env、secret、lockfile、`node_modules`が混ざっていないか
   - 展開した先で`node dist/cli.js --version`が動くか
5. **検査したそのtarballをpublishする**（`npm publish <file>.tgz`）。publishのときに作り直さない。
   `prepublishOnly`は`npm pack`では走らないので、lifecycleに任せきらない
6. publishの**後で**、marketplaceのnpm source versionを切り替えるcommitを入れる。同じmergeに入れると、
   未公開のversionを指す時間ができて新規installが失敗する
7. npmから exact version を取り直してもう一度smoke testする

同じname/versionは再publishできない。壊れたtarballを同じversionで直せないので、4の検査を飛ばさない。

## 届いたことを確かめる

`gleanery doctor`の「plugin の版」が、足りない手順を同じ形で出す。

1. Claude Code: marketplaceを更新してinstallし直し、開いているsessionで`/reload-plugins`。
   対話端末の無いsessionはMCPが次のsessionまで旧版のまま
2. Codex: 同じくmarketplaceを更新してから開き直す
3. **`npm i -g gleanery@<版>`も叩く。**`npm i -g`で入れたCLIはplugin のcacheと別経路で、
   ホストの更新では上がらない。**DBのrevisionを上げた回は、これを忘れると古いCLIだけが
   「revision N を期待している」で落ちる**（実測: revision 5へ上げた後、globalのCLIが0.32.0のまま残った）
4. `gleanery doctor`で、両ホストの導入済みcacheとnpmのCLIが同じ版・同じ中身になり、実行中のMCPに
   張り直しの指示が残っていないことを見る
5. 反映後のsessionから`recall`を呼び、変更したMCP tool、Skill、Agentの中身を確かめる。自動記録を変えたなら、
   そのsessionの発言がダッシュボードの`/sessions`に出ることと、`gleanery doctor`の「自動記録」行に待ちが
   残っていないことも見る

`plugin/agents/`もcache経由なので、保存やsession再起動だけでは新しい定義にならない。Agentを変更する
場合は先に`plugin-agent-authoring`も読む。

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
