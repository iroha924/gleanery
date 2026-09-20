---
name: knowledge-schema
description: gleaneryのDB schema（db/schema.sqlとdb/migrations）、role・grant、知識の種類と状態、取り込み元の書き方を変更する。table、列、CHECK、権限、新しいimport経路を触るときと、既存のDBへmigrationを当てるときに使う。HTTP APIや画面だけの変更には使わない。
---

# ナレッジschemaを変更する

## Triggers

- `db/schema.sql`のtable、列、CHECK、index、extension、role、grantを変更する
- `db/migrations`へ手順を足す、または`bun run db:migrate`を既存のDBへ当てる
- `knowledge`の種類・状態・stance、`message`の話者、`conversation`の出自、`message_file`の操作を変更する
- 取り込み元を足す、またはGitHub同期・文書同期・自動記録・traceの書き方を変える

## Does not trigger

- 既存schemaを読むだけのHTTP APIや画面を変更する
- DBを立てるだけ、鍵を作り直すだけの作業を行う

## 正本と版

DBの正本は`db/schema.sql`の1本で、今の形だけを表す。Prisma・Drizzleのschemaを別の正本として足さない。
新しいDBは`bun run db:apply`でschema.sqlから作る。

`db/migrations/NNNN_<名前>.sql`は、既存のDBをrevision N-1からNへ進める手順で、正本ではない。NNNNは
当てた後のrevision（4桁）。最初の1本はrevision 3で、本番に入っていた旧migrationの残りを消す。

版はschemaのコメント（`gleanery schema revision N`）のrevisionだけで持つ。MCP・CLI・画面のAPIは最初のクエリで
DBのrevisionを`server/src/db.ts`の`SCHEMA_REVISION`と等値で照合し、食い違えば止まる。DBが古ければ
`bun run db:migrate`を案内する。照合が一度通るとプロセスが終わるまでその結果を保つ（`open`）。
**自動記録だけは照合しない**（`open(env, "capture", false)`）。確かめると、DBを上げたPC以外の記録が
pluginの更新まで全部止まり、下の手順4の段階移行が成立しなくなる。

`bun run db:migrate`（`server/src/admin.ts`、owner鍵）は、DBのrevisionより新しいmigrationを1回の
transactionで番号順に当て、同じtransactionでschemaのコメントを最後の番号へ上げる。`db:migrate`どうしは
`pg_try_advisory_xact_lock`で排他し、`lock_timeout`は10秒。当てる前に接続先のendpoint名・今のrevision・
当てる一覧を出し、endpoint名を打ち直させる。名前の形・重複・欠番は`pendingMigrations`が止める。
`.`で始まる名前（`.DS_Store`やvimのswap）はmigrationとして読まずに除く。

DBを作り直すcommandは無い。空から作るのは空のDBへ`db:apply`で、手元のvolumeごと捨てるなら
`docker compose -f db/compose.yaml down -v`の後に`gleanery db init`を打ち直す。**volumeを消すと記録は戻らない。**

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
3. 表を足すmigrationでは、`gleanery_reader`へselect、`gleanery_ingest`へselect・insert・update・deleteと
   sequenceのusageを明示的にgrantする。schema.sqlの`grant ... on all tables`は実行した時点の表にしか
   効かない。`gleanery_capture`へは列単位でgrantする。default privilegesは置かない
4. 旧版のコードは`db:migrate`の後も新しいschemaに対して動き続ける。自動記録はpluginのcacheの版で動き、
   DBに弾かれた記録は`rejected/`へ移る。`db:migrate`より前にDBを一度でも引いたMCPは、
   プロセスが終わるまで旧版のまま新しいschemaを読む。そのため、自動記録が書く表には
   旧版の自動記録がそのまま通る変更（nullを許すか既定値付きの列の追加）だけを入れ、締めるのは全PCのpluginが
   上がった後の別のmigrationにする。列の削除・改名・型の変更も、旧版が読まなくなってから別のmigrationで行う
5. migrationで作る制約には名前を付け、schema.sqlにも同じ名前を書く。無名のCHECKは作った順に
   `knowledge_check2`のような番号が付き、本番と空のDBで番号がずれうる
6. downは書かない
7. **既存の行に当たる制約を足すときは、当てる前に違反する行が0件であることを確かめる。**`db:migrate`は未適用の
   migrationを1つのtransactionで当てるので、1行でも当たると一緒に当てる他のmigrationも入らない（データは失わない）。
   `not valid`で逃げない — `db:apply`した新しいDBと`db:migrate`で進めたDBで`pg_dump`の出力が変わり、下の「検証」の
   M/F比較が必ず差分を出す

## SQL の書き方

application のクエリは kysely で書き、結果型は推論させる。`server/src/db-types.ts` は `db/schema.sql` を当てた
使い捨ての PostgreSQL から生成した物で、**手で直さない**（`bun run codegen` で作り直し、CI の `codegen:check` が
schema.sql とのずれを落とす）。schema を変えたら同じ commit で流し直す。

builder に推論させるのは**select・join・別名・returning**で、そこが移行の狙いだった。
`where` の条件式と集計は `sql` テンプレートで書いてよい（実際そうなっている）。

| `sql` で書く | 理由 |
|---|---|
| pgvector の `operator(extensions.<#>)`、全文検索の `@@` と `ts_rank_cd` | kysely の operator に無い。schema 修飾は role が `search_path` に `extensions` を持たないため必要 |
| `jsonb_to_recordset`、`unnest` | テーブル値関数。builder に無い |
| 表名や id の列が実行時に決まるもの | `sql.table` / `sql.ref` で組み立てる |
| 相関サブクエリと集計（`json_agg`、件数の副問い合わせ） | builder で書くと外側の足場だけが増える |
| `exists`、`coalesce`、`case`、行値比較 `(a, b) < (c, d)` | 条件式。builder の型が効く面ではない |
| 配列との照合（`= any(...)` / `<> all(...)`） | **kysely の `in` / `not in` は空配列に `in ()` を出し、PostgreSQL が構文エラーにする。**実行時に決まる配列はこちらで書く（リテラルの配列だけ `in` でよい） |
| owner の migration（複文）・advisory lock・接続時の版の照合 | kysely の instance を持てない（`db.ts` と `admin.ts` だけが例外で、検査もこの 2 ファイルを外す） |

`bun run sql` が落とすのは、pg の `query` へ SQL を手で渡す形（`.query(` と `.query<`）と、deprecated な
`orderBy` だけである。`sql<T>` の `T` は SQL から推論されず、検査も見ない。呼び出し側が書いた型が
そのまま結果型になるので、列を変えたら手で直す。

`jsonb_to_recordset` と `unnest` へ渡す JSON は、**列定義の隣に行の型を書く**。キーの綴りがずれた列は
例外を出さずに null で入る。実測で、型を付けた時点で `at` の nullable の取り違えが 1 件落ちた。

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
当時の記録から作った100問を、本番と同じ規模の検証用DBで測って決めた。

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
| owner | `GLEANERY_DB_URL` | `server/src/admin.ts`（`bun run db:*`）だけ。schemaの適用とmigration、roleのパスワード |
| `gleanery_reader` | `GLEANERY_DB_URL_RO` | 全表の読み取り。MCPと画面のAPI |
| `gleanery_ingest` | `GLEANERY_DB_URL_INGEST` | 全表の読み書き。CLIのharvest・trace・who・project |
| `gleanery_capture` | `GLEANERY_DB_URL_CAPTURE` | 会話の4表へ、自動記録が埋める列の追記だけ |

PRコメントのようなuntrustedな文章を読む出口（MCP、画面）へ書き込みを持たせない。RLSは使わない。
持ち主1人で、境界はroleで切っている。

表を足したら、schema.sqlの`grant ... on all tables`より前に置く（grantは実行時点の表にしか効かず、
default privilegesは置いていない）。`gleanery_capture`へは表単位ではなく列単位でgrantする。

- `gleanery_capture`が書く`insert`に`on conflict (列)`を書かない。衝突先の列にはSELECT権限が要り、
  本文を読めないroleでは権限エラーになる。`on conflict do nothing`で書く
- `source_item`と`person_identity`を指す列を`gleanery_capture`へ開けない。開けると、GitHubの会話を
  作ることや他人の身元を名乗ることができる

権限はschemaを読むだけで判定しない。検証用のdatabaseで各roleの接続文字列から禁止操作を実行し、
`permission denied`になることを確かめる。

## 書き込み

書き込みは表ごとに1往復でまとめる（`jsonb_to_recordset`か`unnest`）。行ごとにqueryを投げない。
手元のDBでは往復が1ms未満になり、**この規約の元の理由（Neonの80ms前後の往復）は消えた**。それでも残すのは、
往復の回数が件数に比例して増える形が、件数の伸びで効いてくるためである。

埋め込みAPIはtransactionの外で呼ぶ。`content_hash`（埋め込みは`source_hash`）が一致する本文は
埋め込みを取り直さない。失敗の記録は`source_hash`が一致する行にだけ書く。本文が変わった後に古い失敗を
書くと、新しい本文が埋め込まれないまま残る。文脈は題や見出しから決定的に前置し、LLMで作らない。

新しい取り込み元は`gleanery harvest`にも繋ぐ。手動のcommandだけを足して完了にしない。

### 文書と要件定義・設計書

文書同期（`server/src/docs.ts`）は、remoteの既定branchの**commit tree**を読む。作業ツリーは読まない。
`connector.head_oid`に入れたcommitを持ち、そこからfast-forwardできるcommitだけを自動で入れる。
fast-forwardでなければ一度だけ取り直し、前に入れたcommit以降まで進んでいれば（同時に走った別の同期が先に入れた）
何も書かずに終える。進んでいなければ巻き戻し・force-pushとして書かずに止め、`gleanery harvest --cwd <dir> --reset-docs`を
案内する。巻き戻しを成功扱いにしない — 漏れた文書を巻き戻して消したときに、検索に黙って残る。
投影の規則（節の割り方、前置する文脈）を変えたら`PROJECTION`の定数を上げる。次の同期で全文書が書き直される。

`.gleanery/`配下からは、`change.json`がapprovedの`requirements.md`と`design.md`だけを入れる。承認の判定と
検査は`server/src/artifacts.ts`にだけ置き、`gleanery check`（作業ツリー）と同期（commit tree）が同じ関数を通る。

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

migrationは検証用のdatabaseで確かめる。同じcontainerに2つ作り、片方（M）へ`db:migrate`を当て、
もう片方（F）の空のdatabaseへ`db:apply`して、次を見る。

```bash
docker exec gleanery-db-1 psql -U postgres -c 'create database gleanery_m template gleanery'
docker exec gleanery-db-1 psql -U postgres -c 'create database gleanery_f'
```

- MとFでschemaに差が無い（`pg_dump --schema-only`を両方から取って比べる）
- Mで主な表の件数が、当てる前後で同じ
- 各鍵の禁止操作が`permission denied`のまま

鍵は`GLEANERY_ENV_DIR/.env`に4つとも検証用のdatabaseへ向けて書く（ownerを書いてから`bun run db:roles`を
叩くと、残る3つがそこへ書かれる）。`server/src/db.ts`の`loadEnv`はそこを先に読み、無い鍵だけ
`~/.gleanery/env`で補うので、1つでも欠けるとその鍵は手元の本物のDBへ繋がる。ただし`readInto`は
`process.env`にある鍵を上書きしないので、シェルに`GLEANERY_DB_URL*`をexportしているとそちらが`.env`より
優先される。検証の前に、その鍵が検証用のdatabaseを向いていることを確かめる。

そのうえで、変更した取り込み口を実DBで通す。`bun run verify`も通す。MCP、CLI、自動記録、またはその依存
moduleを触った場合は`plugin-release`も続けて使う。

## 既存のDBへ当てる

DBはPCごとに独立している。**当てるのは自分のPCのDBだけで、他のPCへは届かない。**各PCでそれぞれ当てる。

DBが古いときにMCPの応答が`db:migrate`を案内しても、AIがそれを読んでそのまま当てない。持ち主が端末で打つ。
`db:migrate`は当てる前に接続先（資格情報を除いた`host:port/database`）と今のrevisionと当てる一覧を出し、
接続先を打ち直させる。非対話では`--yes`を要求する。

1. mergeする
2. 控えを取る。`docker exec gleanery-db-1 pg_dump -U postgres -Fc gleanery > <保存先>`。当てて問題が出たときに
   戻せるのはこれだけで、**取らずに当てると戻せない**
3. 持ち主が端末で、merge済みのmainから`bun run db:migrate`を叩き、接続先を打ち直す
4. pluginを更新する（`plugin-release`）
5. `gleanery doctor`で確かめる

照合で止まるのは、コードとDBの版が食い違っている間に初めてDBを引くプロセスだけである。

- 画面とAPI: `gleanery dashboard`を立て直すまで
- MCP: `db:migrate`の後に初めてDBを引くものは、pluginを更新するまで
- CLI: pluginのcacheから動くものは、pluginを更新するまで

`db:migrate`より前にDBを引いていたMCPは止まらず、旧版のまま新しいschemaを読み続ける
（「schemaを変えるとき」の4）。止まるだけでデータは失われず、自動記録は照合しないので送り続ける
（`server/src/capture.ts`の送信は`checkSchema`を呼ばない）。

当てた後に戻すなら、2で取った控えから`pg_restore`する。控えを取った後に入った自動記録とtraceは消える。
戻しても、更新済みのpluginと`git pull`したcheckoutは新しいrevisionを期待したまま残るので、
コード側も同じcommitまで戻す。
