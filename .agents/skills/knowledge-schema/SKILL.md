---
name: knowledge-schema
description: mitosのDB schema（db/schema.sql）、role・grant、知識の種類と状態、取り込み元の書き方を変更する。table、列、CHECK、権限、新しいimport経路を触るときに使う。HTTP APIや画面だけの変更には使わない。
---

# ナレッジschemaを変更する

## Triggers

- `db/schema.sql`のtable、列、CHECK、index、extension、role、grantを変更する
- `knowledge`の種類・状態・stance、`message`の話者、`conversation`の出自、`message_file`の操作を変更する
- 取り込み元を足す、またはGitHub同期・文書同期・自動記録・traceの書き方を変える

## Does not trigger

- 既存schemaを読むだけのHTTP APIや画面を変更する
- Vercelの環境変数を設定する

## 正本と版

DBの正本は`db/schema.sql`の1本で、今の形だけを表す。migrationを積まない。Prisma・Drizzleのschemaを
別の正本として足さない。

schemaを変えたら、`comment on schema mitos is 'mitos schema revision N'`と`server/src/db.ts`の
`SCHEMA_REVISION`を同じ数へ上げる（`server/test/db.test.ts`が突き合わせる）。上げ忘れると、古いDBへ
新しいコードが繋がって列の不一致で落ちる。上げれば、MCP・CLI・画面のAPIが最初の接続で止まって
`db:reset`を案内する。

`bun run db:reset`はschema `mitos`を消して作り直す。GitHubと文書は`mitos sync`で戻るが、自動記録した
会話とtraceの記録は戻らない。本番へ当てる前に持ち主へ確かめる。確認はNeonの本番から切ったbranchで行い、
`KNOWLEDGE_ENV_DIR`で全部の鍵がbranchを向いていることを先に確かめる。

## 表の境界

| 境界 | 表 | 書く口 |
|---|---|---|
| 作業場所と人 | `project`、`person`、`person_identity` | CLI（project、who）、GitHub同期 |
| 取り込み元の今の状態 | `connector`、`source_item` | GitHub同期、文書同期 |
| 逐語の会話 | `conversation`、`message`、`message_file`、`message_embedding` | 自動記録、GitHub同期 |
| 検索する知識 | `knowledge`、`knowledge_file`、`knowledge_embedding` | trace、文書同期 |
| 作業の現在地 | `work_item` | trace |

用途ごとに表を増やさない。知識は`knowledge`一表で、種類は`kind`、「通ってはいけない道」かは
生成列の`stance`（`do` / `dont` / `neutral`）で持つ。stanceを埋め込みやLLMに推測させない。
会話は判断の検索（knowledge / avoid）に混ぜない。混ぜると作業ログが判断を押し出す。

消えたと完全な一覧で確かめられた取り込み元の項目は行ごと消す。`deleted_at`や墓標を置かない。
覆した決定は消さず、`status = 'superseded'`にして`superseded_by_id`で後継を指す（消すと再提案される）。

## 値の域を変えるとき

正本はschemaのCHECKで、写しは`server/src/knowledge.ts`の`KINDS`・`STATUSES`・`SPEAKERS`・`ORIGINS`・
`FILE_ACTIONS`にある。片方だけに足すと、DBだけなら検索の札が空になり、コードだけなら取り込みや
自動記録がCHECKで落ちる。`scripts/check-pairs.mjs`が両者を突き合わせる。

種類や状態を足したら、同じ変更で次の出口も扱う。

- `server/src/search.ts`の札と、`stance`の式が新しい値をどちらへ振るか
- `server/src/mcp.ts`の入力schemaと説明（`recall`の`kinds`）
- `plugin/skills/trace/SKILL.md`の記録の契約と、`server/src/trace.ts`の検査
- dashboardの`/sessions`の表示と検索mode
- 列挙できる対なら`scripts/check-pairs.mjs`へ足す

量の多い種類を既定の検索へ入れる前後は、検索の結果を実データで比べる。

## roleとgrant

鍵は操作ごとに分け、どの鍵も別の鍵へ落とさない。`server/src/db.ts`は専用の接続変数が無ければ止まる。

| role | 変数 | できること |
|---|---|---|
| owner | `KNOWLEDGE_DB_URL` | `server/src/admin.ts`（`bun run db:*`）だけ。schemaの適用と作り直し、roleのパスワード |
| `mitos_reader` | `KNOWLEDGE_DB_URL_RO` | 全表の読み取り。MCPと画面のAPI |
| `mitos_ingest` | `KNOWLEDGE_DB_URL_INGEST` | 全表の読み書き。CLIのsync・trace・who・project |
| `mitos_capture` | `KNOWLEDGE_DB_URL_CAPTURE` | 会話の4表へ、自動記録が埋める列の追記だけ |

PRコメントのようなuntrustedな文章を読む出口（MCP、画面）へ書き込みを持たせない。RLSは使わない。
持ち主1人で、境界はroleで切っている。

表を足したら、schema.sqlの`grant ... on all tables`より前に置く（grantは実行時点の表にしか効かず、
default privilegesは置いていない）。`mitos_capture`へは表単位ではなく列単位でgrantする。

- `mitos_capture`が書く`insert`に`on conflict (列)`を書かない。衝突先の列にはSELECT権限が要り、
  本文を読めないroleでは権限エラーになる。`on conflict do nothing`で書く
- `source_item`と`person_identity`を指す列を`mitos_capture`へ開けない。開けると、GitHubの会話を
  作ることや他人の身元を名乗ることができる

権限はschemaを読むだけで判定しない。Neonのbranchで各roleの接続文字列から禁止操作を実行し、
`permission denied`になることを確かめる。

## 書き込み

Neonは往復が80ms前後あるので、書き込みは表ごとに1往復でまとめる（`jsonb_to_recordset`か`unnest`）。
行ごとにqueryを投げない。

埋め込みAPIはtransactionの外で呼ぶ。`content_hash`（埋め込みは`source_hash`）が一致する本文は
埋め込みを取り直さない。失敗の記録は`source_hash`が一致する行にだけ書く。本文が変わった後に古い失敗を
書くと、新しい本文が埋め込まれないまま残る。文脈は題や見出しから決定的に前置し、LLMで作らない。

新しい取り込み元は`mitos sync`にも繋ぐ。手動のcommandだけを足して完了にしない。

### 文書と要件定義・設計書

文書同期（`server/src/docs.ts`）は、remoteの既定branchの**commit tree**を読む。作業ツリーは読まない。
`connector.head_oid`に入れたcommitを持ち、そこからfast-forwardできるcommitだけを自動で入れる。
巻き戻しとforce-pushは書かずに止め、`mitos sync --cwd <dir> --reset-docs`を案内する。
投影の規則（節の割り方、前置する文脈）を変えたら`PROJECTION`の定数を上げる。次の同期で全文書が書き直される。

`.mitos/`配下からは、`change.json`がapprovedの`requirements.md`と`design.md`だけを入れる。承認の判定と
検査は`server/src/artifacts.ts`にだけ置き、`mitos check`（作業ツリー）と同期（commit tree）が同じ関数を通る。

- 選別と検査を、埋め込みと文書のDB書き込みより前に済ませる。逆にすると、draftの節が埋め込みAPIへ送られる
- 追跡済みの成果物を持つchangeのmanifestが不正なら、そのrepositoryの文書同期を丸ごと止める。エラーには
  pathと理由だけを出し、ファイルの内容と未知のキー名は出さない
- 原文は`source_item`（`kind`が`requirements` / `design`、`body`に原文）、検索するのは`knowledge`の
  `document`の節である。節の連結から原文は戻らない
- セッションとの関連は新しい表を作らず、自動記録の`message_file`（Edit・Writeは`edit`、承認済みの成果物を
  Readしたものは`read`）と、同じ作業場所で同期された`source_item.path`の一致で作る。任意のpathや
  別の作業場所の本文を取れる入口にしない

### GitHub

GitHub同期（`server/src/github.ts`）は`gh api`で毎回全件を取る。取得を始めたDBの時刻を
`connector.snapshot_at`に持ち、それより前に始めた取得は遅れてcommitしても書かない。
`source_item.closed_at`はPRならmergeした時刻（mergeせず閉じたなら閉じた時刻）、issueなら閉じた時刻で、
`state = 'open'`と`closed_at is null`が一致することをCHECKが強制する。

## 検証

schemaをNeonのbranchへ当て（`db:reset`）、`bun run db:roles`で鍵を作り直してから、変更した取り込み口を
実DBで通す。`bun run verify`も通す。MCP、CLI、自動記録、またはその依存moduleを触った場合は
`plugin-release`も続けて使う。
