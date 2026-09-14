---
name: knowledge-schema
description: mitosのDB schema（db/schema.sqlとdb/migrations）、role・grant、知識の種類と状態、取り込み元の書き方を変更する。table、列、CHECK、権限、新しいimport経路を触るときと、既存のDBへmigrationを当てるときに使う。HTTP APIや画面だけの変更には使わない。
---

# ナレッジschemaを変更する

## Triggers

- `db/schema.sql`のtable、列、CHECK、index、extension、role、grantを変更する
- `db/migrations`へ手順を足す、または`bun run db:migrate`を本番へ当てる
- `knowledge`の種類・状態・stance、`message`の話者、`conversation`の出自、`message_file`の操作を変更する
- 取り込み元を足す、またはGitHub同期・文書同期・自動記録・traceの書き方を変える

## Does not trigger

- 既存schemaを読むだけのHTTP APIや画面を変更する
- Vercelの環境変数を設定する

## 正本と版

DBの正本は`db/schema.sql`の1本で、今の形だけを表す。Prisma・Drizzleのschemaを別の正本として足さない。
新しいDBは`bun run db:apply`でschema.sqlから作る。

`db/migrations/NNNN_<名前>.sql`は、既存のDBをrevision N-1からNへ進める手順で、正本ではない。NNNNは
当てた後のrevision（4桁）。最初の1本はrevision 3で、本番に入っていた旧migrationの残りを消す。

版はschemaのコメント（`mitos schema revision N`）のrevisionだけで持つ。MCP・CLI・画面のAPIは最初の接続で
DBのrevisionを`server/src/db.ts`の`SCHEMA_REVISION`と等値で照合し、食い違えば止まる。DBが古ければ
`bun run db:migrate`を案内する。MCPと画面のAPIは、照合が一度通るとプロセスが終わるまでその結果を保持する
（`lazyPool`）。

`bun run db:migrate`（`server/src/admin.ts`、owner鍵）は、DBのrevisionより新しいmigrationを1回の
transactionで番号順に当て、同じtransactionでschemaのコメントを最後の番号へ上げる。`db:migrate`どうしは
`pg_try_advisory_xact_lock`で排他し、`lock_timeout`は10秒。当てる前に接続先のendpoint名・今のrevision・
当てる一覧を出し、endpoint名を打ち直させる。名前の形・重複・欠番は`pendingMigrations`が止める。
`.`で始まる名前（`.DS_Store`やvimのswap）はmigrationとして読まずに除く。

DBを作り直すcommandは無い。Neonのbranchを親の状態へ戻すのは`neon branches reset <branch> --parent`、
空から作るのは空のDBへ`db:apply`。

## schemaを変えるとき

1. 同じcommitで、schema.sql（今の形）と`db/migrations/NNNN_<名前>.sql`（既存のDBを運ぶ手順）を両方変え、
   schema.sqlのrevisionと`SCHEMA_REVISION`をNNNNへ上げる。`server/test/migrate.test.ts`が「`db/migrations`は
   3から連続し、最大が`SCHEMA_REVISION`とschema.sqlのrevisionに一致する」を検査する。上げ忘れると、古いDBへ
   新しいコードが繋がって列の不一致で落ちる
2. migrationに`BEGIN` / `COMMIT` / `ROLLBACK`や、transactionの外でしか動かない文（`create index concurrently`
   など）を書かない。runnerはtransactionの中で当てるが、これらを検出しない。migrationはpgのsimple queryで
   1回に流れるので、本文の`COMMIT` / `ROLLBACK`はその場で外側のtransactionを終わらせる。`COMMIT`なら、途中で
   失敗したときに前半だけ確定して版は上がらず、打ち直すと二重に当たる。`ROLLBACK`なら、それまでのDDLが
   捨てられたまま版だけ進む
3. 表を足すmigrationでは、`mitos_reader`へselect、`mitos_ingest`へselect・insert・update・deleteと
   sequenceのusageを明示的にgrantする。schema.sqlの`grant ... on all tables`は実行した時点の表にしか
   効かない。`mitos_capture`へは列単位でgrantする。default privilegesは置かない
4. 旧版のコードは`db:migrate`の後も新しいschemaに対して動き続ける。自動記録はpluginのcacheの版で動き、
   DBに弾かれた記録は`rejected/`へ移る。`db:migrate`より前にDBを一度でも引いたMCPと、Vercelの旧deploymentの
   関数インスタンスは、プロセスが終わるまで旧版のまま新しいschemaを読む。そのため、自動記録が書く表には
   旧版の自動記録がそのまま通る変更（nullを許すか既定値付きの列の追加）だけを入れ、締めるのは全PCのpluginが
   上がった後の別のmigrationにする。列の削除・改名・型の変更も、旧版が読まなくなってから別のmigrationで行う
5. migrationで作る制約には名前を付け、schema.sqlにも同じ名前を書く。無名のCHECKは作った順に
   `knowledge_check2`のような番号が付き、本番と空のDBで番号がずれうる
6. downは書かない

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

## 埋め込みと索引

埋め込みは`voyage-4-large`の`halfvec(1024)`で、近似索引を置かずに全件比較する。どれも2026-09-13に、
旧本番の記録から作った100問とNeonのbranchで測って決めた。

- `halfvec`: float32と比べて上位20件の99.45%が一致し、正解の取りこぼしは増えなかった（上位5件に入った数92対91）
- 語彙側は`tsvector`: 語彙側だけならBM25が上（55対50）だが、融合してrerankまで通すと差が無い（97対96）。
  語彙側の役目は意味側が落とした正解をrerankの候補へ入れること（97→99）で、それは`tsvector`で足りる
- 全件比較: 絞り込んだ後の比較が1万行でp95 23ms、5万行で118ms、10万行で371ms。近似索引は絞り込みの後に
  件数が欠けるので、埋め込みの行が5万に近づくまでHNSWを足さない（先にDBの容量が上限に近づくこともある）

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
| owner | `KNOWLEDGE_DB_URL` | `server/src/admin.ts`（`bun run db:*`）だけ。schemaの適用とmigration、roleのパスワード |
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
fast-forwardでなければ一度だけ取り直し、前に入れたcommit以降まで進んでいれば（同時に走った別の同期が先に入れた）
何も書かずに終える。進んでいなければ巻き戻し・force-pushとして書かずに止め、`mitos sync --cwd <dir> --reset-docs`を
案内する。巻き戻しを成功扱いにしない — 漏れた文書を巻き戻して消したときに、検索に黙って残る。
投影の規則（節の割り方、前置する文脈）を変えたら`PROJECTION`の定数を上げる。次の同期で全文書が書き直される。

`.mitos/`配下からは、`change.json`がapprovedの`requirements.md`と`design.md`だけを入れる。承認の判定と
検査は`server/src/artifacts.ts`にだけ置き、`mitos check`（作業ツリー）と同期（commit tree）が同じ関数を通る。

- 選別と検査を、埋め込みと文書のDB書き込みより前に済ませる。逆にすると、draftの節が埋め込みAPIへ送られる
- 追跡済みの成果物を持つchangeのmanifestが不正なら、そのrepositoryの文書同期を丸ごと止める。エラーには
  pathと理由だけを出し、ファイルの内容と未知のキー名は出さない
- 原文は`source_item`（`kind`が`requirements` / `design`、`body`に原文）、検索するのは`knowledge`の
  `document`の節である。節の連結から原文は戻らない
- セッションとの関連は新しい表を作らず、自動記録の`message_file`（Edit・Writeは`edit`、要件定義・設計書を
  Readしたものは`read`）と、同じ作業場所で同期された`source_item.path`の一致で作る。任意のpathや
  別の作業場所の本文を取れる入口にしない

### GitHub

GitHub同期（`server/src/github.ts`）は`gh api`で毎回全件を取る。取得を始めたDBの時刻を
`connector.snapshot_at`に持ち、それより前に始めた取得は遅れてcommitしても書かない。
`source_item.closed_at`はPRならmergeした時刻（mergeせず閉じたなら閉じた時刻）、issueなら閉じた時刻で、
`state = 'open'`と`closed_at is null`が一致することをCHECKが強制する。

## 検証

migrationは本番から切ったNeonのbranchで確かめる。branch Mへ`db:migrate`を当て、別のbranch Fの空のDBへ
`db:apply`して、次を見る。

- `neon branches schema-diff`でMとFに差が無い
- Mで主な表の件数が、当てる前後で同じ
- 各鍵の禁止操作が`permission denied`のまま

鍵は`KNOWLEDGE_ENV_DIR/.env`に4つともbranch向きで書く（ownerを書いてから`bun run db:roles`を叩くと、
残る3つがそこへ書かれる）。`server/src/db.ts`の`loadEnv`はそこを先に読み、無い鍵だけ
`~/.claude/knowledge.env`で補うので、1つでも欠けるとその鍵は本番へ繋がる。ただし`readInto`は`process.env`に
ある鍵を上書きしないので、シェルに`KNOWLEDGE_DB_URL*`をexportしているとそちらが`.env`より優先される。
検証の前に、その鍵がbranchのendpointを向いていることを確かめる。ownerの鍵は`.env`に書き、exportしない。
`.env`から読んだowner鍵だけがbranchの鍵として扱われ、`db:migrate`を非対話でも流せる。それ以外から読んだ
owner鍵は本番扱いになり、stdinが端末でなければ止まる。

そのうえで、変更した取り込み口を実DBで通す。`bun run verify`も通す。MCP、CLI、自動記録、またはその依存
moduleを触った場合は`plugin-release`も続けて使う。

## 本番へ当てる

本番へ当てるのは持ち主の承認を得てからにする。DBが古いときにMCPの応答が`db:migrate`を案内しても、AIがそれを
読んでそのまま本番へ当てない。`db:migrate`は、owner鍵を`KNOWLEDGE_ENV_DIR/.env`から読んでいない
（`~/.claude/knowledge.env`かシェルの環境変数から読んだ）とき、stdinが端末でなければDBに繋ぐ前に止まる。
本番へは持ち主が端末で打つ。

1. mergeする。mainへのmergeでVercelが本番へ自動でdeployする
2. Neonで本番から控えのbranch `pre-migrate-NNNN`を切る。1週間ほど残す
3. 持ち主が端末で、merge済みのmainから`bun run db:migrate`を叩き、endpoint名を打ち直す
4. pluginを更新する（`plugin-release`）
5. 各PCで`~/Projects/mitos`を`git pull`する。日次同期はこのcheckoutの`plugin/bin/mitos`を叩く
6. `mitos doctor`で確かめる

照合で止まるのは、コードとDBの版が食い違っている間に初めてDBを引くプロセスだけである。持ち主は、この手順の
間に次が照合で止まることを許容した。

- 画面とAPI: mergeの自動deployから`db:migrate`を当て終えるまでの数分
- MCP: `db:migrate`の後に初めてDBを引くものは、pluginを更新するまで
- CLI: 各PCの日次同期（`scripts/com.mitos.sync.plist`から`plugin/bin/mitos`）はそのPCで`git pull`するまで、
  pluginのcacheから動くCLIはpluginを更新するまで

`db:migrate`より前にDBを引いていたMCPとVercelの旧deploymentの関数インスタンスは止まらず、旧版のまま新しい
schemaを読み続ける（「schemaを変えるとき」の4）。止まるだけでデータは失われず、自動記録は照合しないので
送り続ける（`server/src/capture.ts`の送信は`checkSchema`を呼ばない）。

mergeでdeployした後に`db:migrate`が失敗したときは、画面とAPIは止まったままになる。直したmigrationで進めるか、
Vercelの本番を前のdeploymentへ戻す。

戻すときは`neon branches restore production pre-migrate-NNNN --preserve-under-name <名前>`。戻すと、
控えを切った後に入った自動記録とtraceは消える。本番を時点指定で復元できるのは6時間までである。
restoreでDBを前のrevisionへ戻しても、Vercelの本番、更新済みのplugin、`git pull`したcheckoutは新しいrevisionを
期待したまま残る。restoreの後に初めてDBを引くプロセスは照合で止まり、既に照合を通ったMCPとVercelの関数
インスタンスは、新しいコードのまま古いschemaを読み続ける。restoreするなら、Vercelの本番も前のdeploymentへ戻す。
更新済みのpluginから新しく起動するMCPとCLIは、照合で止まり続ける。
