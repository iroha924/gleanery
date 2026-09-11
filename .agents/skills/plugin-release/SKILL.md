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

Claude CodeとCodexは、GitHubの`main`からpluginを取り、版ごとのcacheへ複製して動かす。cacheは版が
変わったときだけ更新されるので、`bun run bundle`やcommitだけでは届かず、mergeまで届かない。
directory型marketplaceのClaude Codeはcacheを使わず作業ツリーを直接読むので、配布物の確認にならない。
CLIは実行した場所の`dist/cli.js`を読むため、CLIで動くことはMCPで動く証拠にならない。

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
7. 反映後のsessionから`current_work`を呼び、末尾の`mitos MCP <版>`が新しい版であることと、変更した
   MCP tool、Skill、Agentの中身を確かめる

`plugin/agents/`もcache経由なので、保存やsession再起動だけでは新しい定義にならない。Agentを変更する
場合は先に`plugin-agent-authoring`も読む。

人向けのCLI出力とAI向けのMCP応答は別々に確認する。
