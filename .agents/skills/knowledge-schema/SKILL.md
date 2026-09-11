---
name: knowledge-schema
description: mitosのPostgreSQL migration、RLS・role、record/node schema、取り込み元、検索kindを変更する。DB構造や権限、新しいimport経路を触るときに使う。HTTP APIや画面だけの変更には使わない。
---

# ナレッジschemaを変更する

## Triggers

- `db/migrations/`、DB role、RLS、table、index、extensionを変更する
- `record`や`node`の形、kind、polarityを変更する
- 新しい取り込み元を追加する

## Does not trigger

- 既存schemaだけを読むHTTP APIや画面を変更する
- Vercel環境変数を設定する

## 権限の検証

`search_log`だけは`knowledge_ro`から追記を許すが、読み戻しと削除は許さない。

権限はmigrationを読むだけで判定しない。roleの接続文字列で禁止操作を実行し、`permission denied`に
なることを確認する。

## nodeと検索の出口

知識は`node`一表に置き、用途ごとにtableを分けない。kindを追加したら次の全出口を同じ変更で扱う。

- `server/src/search.ts`のlabelと既定除外
- `server/src/mcp.ts`の入力schemaと説明
- dashboard検索画面のfilter
- `scripts/check-pairs.mjs`で機械的に揃えられる一覧

量の多いkindを既定検索へ入れる前後ではretrieval evalを測る。polarityは埋め込みへ推測させず、列で
`do`、`dont`、`na`を持つ。

## 取り込み

1つの取り込み元を1つの`record`とし、その中の単位を`node`にする。`content_hash`が一致する本文は
埋め込みを取り直さず、埋め込みAPIはtransactionの外で呼ぶ。文脈は題や見出しから決定的に前置し、
LLMで作らない。上書き型のsourceで消えた項目は`deleted_at`へ反映する。

## migration

`knowledge_ro`と`mitos_cfg`には後から作るtableへのdefault privilegesがある。table追加時は両roleの
read/writeを明示的に決め、読ませないtableには`revoke`を書く。`mitos_cfg`へ`record`と`node`のwriteを
与えない。

変更後は対象migrationを実DBへ適用した経路と、`bun run verify`を確認する。kindや取り込み口の変更で
`server/src/mcp.ts`、CLI、またはその依存moduleを触った場合は`plugin-release`も続けて使う。
