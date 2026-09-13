---
name: plugin-release
description: mitosのMCP、CLI、自動記録のhook、plugin SkillまたはAgentを変更して配布物を更新する。bundle入口とその依存module、3 manifest、Claude/Codex両方への到達確認が対象。HTTP APIやdashboardだけの変更には使わない。
---

# プラグイン変更を届ける

## Triggers

- `server/src/mcp.ts`、`server/src/cli.ts`、`server/src/capture.ts`、またはそれらがimportするmoduleを変更する
- `plugin/hooks/hooks.json`を変更する
- `plugin/skills/`、`plugin/agents/`を変更する
- `plugin/dist/`またはplugin manifestの版を更新する
- ローカル変更がClaude CodeやCodexに届かない原因を調べる

## Does not trigger

- HTTP APIやdashboardだけを変更する
- Vercelへdashboardをデプロイする。その場合は`deploy`を使う

## 配布経路

Claude CodeとCodexは、GitHubの`main`からpluginを取り、版ごとのcacheへ複製して動かす。cacheは版が
変わったときだけ更新されるので、`bun run bundle`やcommitだけでは届かず、mergeまで届かない。
directory型marketplaceのClaude Codeはcacheを使わず作業ツリーを直接読むので、配布物の確認にならない。
CLIは実行した場所の`dist/cli.js`を読むため、CLIで動くことはMCPで動く証拠にならない。自動記録のhookは
`${CLAUDE_PLUGIN_ROOT}/dist/capture.js`を叩くので、これもcacheの版で動く。

変更時は次を同じcommitに含める。

1. `bun run bundle`で`plugin/dist/`を更新する
2. 次の3箇所を同じversionへ上げる
   - `.claude-plugin/marketplace.json`
   - `plugin/.claude-plugin/plugin.json`
   - `plugin/.codex-plugin/plugin.json`
3. 変更をstageし、`bun run scripts/check-mcp-version.mjs`と`bun run verify:ai`を通す

merge後に届いたことを確かめる。`mitos doctor`の「plugin の版」が、足りない手順を同じ形で出す。

4. Claude Code: `claude plugin marketplace update mitos && claude plugin update mitos@mitos`の後、開いている
   sessionで`/reload-plugins`。marketplaceのauto-updateが有効なら起動後に自動で入り、通知が出たら
   `/reload-plugins`するだけになる。対話端末の無いsessionはMCPが次のsessionまで旧版のまま
5. Codex: `codex plugin marketplace upgrade mitos && codex plugin add mitos@mitos`の後、Codexを開き直す
6. `mitos doctor`で、両ホストの導入済みcacheがrepositoryと同じ版・同じ中身になり、実行中のMCPに
   張り直しの指示が残っていないことを見る
7. 反映後のsessionから`recall`を呼び、変更したMCP tool、Skill、Agentの中身を確かめる。自動記録を変えたなら、
   その session の発言がダッシュボードの`/sessions`に出ることと、`mitos doctor`の「自動記録」行に待ちが
   残っていないことも見る

`plugin/agents/`もcache経由なので、保存やsession再起動だけでは新しい定義にならない。Agentを変更する
場合は先に`plugin-agent-authoring`も読む。

## plugin Skill

- 明示起動だけにするSkillは、SKILL.mdの`disable-model-invocation: true`（Claude Code）と、Skillディレクトリの
  `agents/openai.yaml`の`policy.allow_implicit_invocation: false`（Codex）を対で置く。Codexは前者を解釈しない。
  対は`verify:ai`が検査する
- CLIを呼ぶSkillは、ホスト別に解決する。Claude Codeは`${CLAUDE_PLUGIN_ROOT}/bin/mitos`、Codexは
  Skillディレクトリからの`../../bin/mitos`。素の`mitos`はCodexのPATHに無く（exit 127）、Claude Codeでは
  PATHの古いCLIが新しいコマンドを知らない。`verify:ai`はCodex側の行があるかを見る
- `allowed-tools`に`${CLAUDE_PLUGIN_ROOT}`を書いた事前承認は効く。2026-09-12に、一時リポジトリで
  `claude -p "/mitos:init" --plugin-dir <plugin> --permission-mode default --output-format json`を実行し、
  `.mitos`が作られて`permission_denials`が空だった（利用者の設定にmitosを許すBashのルールは無い）。requirementsとdesignは書き込みを事前承認に入れない。承認済みの
  本文を確認なしで書き換えられると、次の同期でそのままapprovedとして入る
- merge後の7では、Codexで`$mitos:<skill>`の明示起動で本文が読まれることも確かめる

人向けのCLI出力とAI向けのMCP応答は別々に確認する。
