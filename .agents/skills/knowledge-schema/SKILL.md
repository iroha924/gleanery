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

外部sourceのworkerへ管理鍵を渡さない。sourceごとの専用roleを作り、必要なtable・列・sequenceだけをgrantし、
`server/src/db.ts`で専用の接続変数が無いときは起動を止める。管理鍵へのfallbackは作らない。

権限はmigrationを読むだけで判定しない。roleの接続文字列で禁止操作を実行し、`permission denied`に
なることを確認する。

## nodeと検索の出口

知識は`node`一表に置き、用途ごとにtableを分けない。kindを追加したら次の全出口を同じ変更で扱う。

- `server/src/search.ts`のlabelと既定除外
- `server/src/mcp.ts`の入力schemaと説明
- dashboardの`/sessions`検索filter
- `scripts/check-pairs.mjs`で機械的に揃えられる一覧

量の多いkindを既定検索へ入れる前後ではretrieval evalを測る。polarityは埋め込みへ推測させず、列で
`do`、`dont`、`na`を持つ。

## 取り込み

1つの取り込み元を1つの`record`とし、その中の単位を`node`にする。`content_hash`が一致する本文は
埋め込みを取り直さず、埋め込みAPIはtransactionの外で呼ぶ。文脈は題や見出しから決定的に前置し、
LLMで作らない。上書き型のsourceで消えた項目は`deleted_at`へ反映する。

### 要件定義・設計書（`.mitos/changes/`）

文書の同期（`server/src/docs.ts`）は、`.mitos/`配下からは`change.json`でapprovedの`requirements.md`と
`design.md`だけを取り込む。承認の判定と検証は`server/src/artifacts.ts`にだけ置き、`mitos check`と同期が
同じ関数を通る。範囲は違う — 同期は追跡済みの成果物を持つchangeだけを検査し、`mitos check`は
`project.json`と未追跡のchangeも見る。

- 本文を読んでからmanifestを読み、選別と検証を埋め込みと文書のDB書き込みより前に済ませる。逆にすると、
  編集中の本文がapprovedとして入り、draftの節が埋め込みAPIへ送られる
- 追跡済みの成果物を持つchangeのmanifestが不正なら、そのrepositoryの文書同期を丸ごと止める。エラーには
  pathと理由だけを出し、ファイルの内容と未知のキー名は出さない
- approvedの成果物は、検索用の節（`searchable = true`）と原文node（`subkind = 'artifact-source'`、
  `searchable = false`、埋め込み無し、keyはpathそのもの）へ同じtransactionで投影する。原文のkeyを
  墓標の対象外リストから落とすと、挿入した直後にsoft deleteされる
- docs recordの`ingested_at`はtransactionの中で更新する。セッション詳細の同期時点がこれを返す
- セッションとの関連は新しいtableを作らず、traceの`links.files`から作る`file` refと`touched`の
  `ref_link`を使う。`ref_link`は追記しかされないので、誤って結んだ関連は取り込み直しても消えない

## migration

`knowledge_ro`と`mitos_cfg`には後から作るtableへのdefault privilegesがある。table追加時は全roleの
read/writeを明示的に決め、読ませないtableには`revoke`を書く。`mitos_cfg`へ`record`と`node`のwriteを
与えない。GitHub Appの接続tableは`mitos_cfg`、GitHub由来のknowledgeと同期状態は`mitos_github`だけが書く。

変更後は対象migrationを実DBへ適用した経路と、`bun run verify`を確認する。kindや取り込み口の変更で
`server/src/mcp.ts`、CLI、またはその依存moduleを触った場合は`plugin-release`も続けて使う。
