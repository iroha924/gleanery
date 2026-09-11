---
name: plugin-agent-authoring
description: mitos pluginが配るreview Agentの定義、model、effort、tools、起動方法を変更する。plugin/agentsまたはreview Skillを触るときに使う。通常の実装や組み込みsubagentの利用には使わない。
---

# plugin Agentを変更する

このSkill自体はmitos repositoryの開発用であり、plugin利用者へは配布しない。変更対象の
`plugin/agents/`と`plugin/skills/review/`は配布物である。

## Triggers

- `plugin/agents/`のAgent定義を追加・変更する
- `plugin/skills/review/`のAgent起動方法を変更する
- Agentが別の定義へ解決される、または古い定義で動く問題を調べる

## Does not trigger

- 組み込みのexplorerやworkerへ通常の作業を委任する
- Agent定義を変えずに既存reviewを実行する

## 識別と配布

Claude Codeからplugin Agentを呼ぶときは`mitos:review-adversarial`のように`mitos:`を付ける。素の名前は
同名のuser/project Agentへ解決されうる。reviewer定義と同名のfileを`~/.claude/agents/`へ置かない。

plugin Agentはversioned cacheから読むため、変更時は`plugin-release`のbundle、3 manifestのversion更新、
session再起動まで行う。定義fileを書き換えたことを、届いた証拠にしない。

Codexは`plugin/agents/*.md`をAgentとして登録しないが、review Skillが本文とfrontmatterを読み、対応する
独立review agentへ渡す。したがってmodel、effort、本文は両方の正本である。

## frontmatter

各Agentは`name`、判別可能な`description`、必要最小限の`tools`、固定した`model`と`effort`、有限の
`maxTurns`を持つ。`model: inherit`や省略でsession設定へ依存させない。値を変えるときは、その観点に
必要な探索幅に基づく理由も本文で更新する。

Agent本文は自己完結させる。plugin cacheにはmitos rootの`AGENTS.md`や`.claude/rules`が入らないため、
それらや別Skillの相対pathを実行時の前提にしない。Codexへはfrontmatterを除いた本文も渡るので、
本文だけで意味が通る形にする。

## Agentを増やす基準

組み込みexplorer/workerと重なるAgentを作らない。新設するのは、変更を生んだ会話を渡さない独立context
や、固定model・toolsが結果を変える専門検査に限る。既存のreview観点へ責務を追加できるなら新設しない。

## 検証

`bun run verify:ai`と`plugin-release`の配布確認を行い、変更したAgentを1体だけ実際に起動する。出力の
有無ではなく、期待したname、model、effort、本文が使われたことを確認する。
