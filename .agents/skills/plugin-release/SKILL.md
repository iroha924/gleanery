---
name: plugin-release
description: mitosのMCP、CLI、hook、plugin SkillまたはAgentを変更して配布物を更新する。bundle入口とその依存module、3 manifest、Claude/Codex両方への到達確認が対象。HTTP APIやdashboardだけの変更には使わない。
---

# プラグイン変更を届ける

## Triggers

- `server/src/mcp.ts`、`server/src/cli.ts`、`server/src/hook-check-path.ts`、またはそれらがimportするmoduleを変更する
- `plugin/skills/`、`plugin/agents/`を変更する
- `plugin/dist/`またはplugin manifestの版を更新する
- ローカル変更がClaude CodeやCodexに届かない原因を調べる

## Does not trigger

- HTTP APIやdashboardだけを変更する
- Vercelへdashboardをデプロイする。その場合は`deploy`を使う

## 配布経路

MCPは`bun run bundle`だけでは利用中のClaude Codeへ届かない。pluginは版ごとのcacheへ複製され、版が
変わったときだけ更新される。CLIは`plugin/dist/cli.js`を直接読むため、CLIで動くことはMCPで動く
証拠にならない。

変更時は次を同じcommitに含める。

1. `bun run bundle`で`plugin/dist/`を更新する
2. 次の3箇所を同じversionへ上げる
   - `.claude-plugin/marketplace.json`
   - `plugin/.claude-plugin/plugin.json`
   - `plugin/.codex-plugin/plugin.json`
3. 変更をstageし、`bun run scripts/check-mcp-version.mjs`と`bun run verify:ai`を通す
4. Claude Codeでは`claude plugin update mitos`後にsessionを張り直す
5. Codexをrefreshし、local marketplaceからpluginをinstallし直す。`codex plugin list --json`で版を確認する
6. 変更したMCP tool、Skill、Agentを新しいsessionから1つ呼び、届いた内容を確認する

`plugin/agents/`もcache経由なので、保存やsession再起動だけでは新しい定義にならない。Agentを変更する
場合は先に`plugin-agent-authoring`も読む。

人向けのCLI出力とAI向けのMCP応答は別々に確認する。
