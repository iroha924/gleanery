---
name: init
description: このリポジトリに、要件定義と設計書の置き場所（.gleanery/）を gleanery init で作る。作った場所が想定したリポジトリの根かを利用者に確かめさせる。要件の整理は始めない。
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" init*)
---

# init — 要件定義と設計書の置き場所を作る

## このスキルが防ぐ失敗

| 失敗 | 起きること |
|---|---|
| ディレクトリを手で作る | symlink を辿ってリポジトリの外へ書く。形式の違う `project.json` ができ、後の検査が落ちる |
| サブディレクトリに作る | 同期も `gleanery check` もリポジトリの根しか見ないので、成果物がどこからも引けない |
| 続けて要求整理を始める | 利用者が作成先を確かめる前に、誤った場所へ成果物が溜まる |

## CLI の呼び方はホストで違う

```bash
# Claude Code
M='node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"'
# Codex（このスキルのディレクトリからの相対パス。絶対パスへ解決して使う）
M='node "../../dist/cli.js"'
```

素の `gleanery` は使わない。Codex では PATH に無く、Claude Code では PATH の CLI が古い版のことがあり
`init` を知らない。**`$M` は表記である。**コマンドには自分のホストの側の絶対パスをそのまま先頭に書く。
変数に代入してから呼ぶと、Claude Code では事前承認が効かない。

## 手順

1. `$M init` を実行する。Git リポジトリの中なら、どこから呼んでも根に作られる
2. 出力の最後の行（行頭から始まる締めの行）にある作成先を、そのまま利用者へ示す。「作った」と「既に初期化済み」を区別して伝える
3. 作成先が想定したリポジトリの根かを利用者に確かめさせる。違っていても自分で消したり作り直したりしない
4. 出力に同期経路の更新の注意があれば、そのまま伝える
5. ここで止まる。要件定義は利用者が `/gleanery:requirements`（Codex は `$gleanery:requirements`）で始める

**exit が 0 でなければ直さない。**既存のファイルとの衝突、壊れた `project.json`、symlink は、
どれも利用者が意図を持って置いた可能性がある。メッセージをそのまま示して止まる。
