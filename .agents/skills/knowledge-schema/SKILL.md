---
name: knowledge-schema
description: gleaneryのDB schema（db/schema.sqlとdb/migrations、SQLite）、接続の役割とauthorizer、全文検索の索引（FTS5）、知識の種類と状態、取り込み元の書き方を変更する。table、列、CHECK、view、trigger、権限、新しいimport経路を触るときと、既存のDBへmigrationを当てるときに使う。端末の画面だけの変更には使わない。
---

# ナレッジschemaを変更する

## Triggers

- `db/schema.sql`のtable、列、CHECK、index、view、triggerを変更する
- `db/migrations`へ手順を足す、または`gleanery db migrate`を既存のDBへ当てる
- 接続の役割（`server/src/sqlite.ts`・`server/src/db-write.ts`のauthorizer）を変える
- 全文検索の索引（FTS5、`gleanery_terms`、`server/src/text.ts`の`terms()`）を変える
- `knowledge`の種類・状態・stance、`message`の話者、`conversation`の出自、`message_file`の操作を変更する
- 取り込み元を足す、またはGitHub同期・文書同期・自動記録・traceの書き方を変える

## Does not trigger

- 既存schemaを読むだけの端末の画面を変更する
- DBを作るだけの作業を行う

## 正本とバージョン

DBは`node:sqlite`の1ファイル（`~/.gleanery/gleanery.db`）。正本は`db/schema.sql`の1本で、今の形だけを表す。
Prisma・Drizzleのschemaを別の正本として足さない（Drizzleは不採用。FTS5の仮想表とtriggerを表せない）。
新しいDBは`gleanery init`が一時ファイルへschema.sqlを当ててからrenameして作る（何度流してもよい）。

バージョンは`pragma user_version`で持つ。schema.sqlの末尾の`pragma user_version = N`と`server/src/sqlite.ts`の
`SCHEMA_REVISION`を同じ数にする。readerとingestの接続は開くときに照合し、食い違えば止まる。
**自動記録（capture）だけは照合しない。**確かめると、DBを上げてからpluginを上げるまで記録が丸ごと止まる。
旧バージョンのまま書き続け、DBが弾いた記録は`rejected/`へ回る。

`db/migrations/NNNN_<名前>.sql`は既存のDBをrevision N-1からNへ進める手順で、正本ではない。
`gleanery db migrate`（`server/src/admin.ts`の`applyMigrations`、owner）は、DBのバージョンより新しいmigrationを番号順に当て、
**transactionごとに**`user_version`を上げる。途中で落ちても前のtransactionの分は残り、打ち直すとその続きから当たる。

- 宣言の無いmigrationは、続く分をまとめて1つのtransaction（`begin immediate`）で当てる
- 表を消す・作り変える（`ALTER TABLE`。列の追加も含む）migrationは、1行目に`-- gleanery: foreign_keys=off`を書く。宣言の無いmigrationでは、runnerのauthorizerがdropとALTERを拒む。単独のtransactionで、その外で外部キーを切って当て、
  commitの前に`pragma foreign_key_check`が空であることを確かめ、終わったら戻す。**宣言を忘れると、外部キーが効いたままのdropが
  子の行をcascadeで消す。**知らない宣言と1行目以外の宣言は、当てる前に止まる
- 行を消すのは宣言の無いmigrationで先に済ませる（外部キーが効いているので、cascadeとset nullが子孫を今の意味どおりに片付ける）。
  作り直すmigrationは残った行を写すだけにする
- autoincrementの表を作り直すときは、`sqlite_sequence`の値を控えて戻す（dropで消え、消したidが振り直される）
- schema.sqlの作り直した表は`create table "表名"`の形で書く（renameの後の`sqlite_schema.sql`と文字列で揃える）
- 名前の形・重複・欠番は`pendingMigrations`が止める。`.`で始まる名前は読まない

## schemaを変えるとき

1. 同じcommitで、schema.sql（今の形）と`db/migrations/NNNN_<名前>.sql`（既存のDBを運ぶ手順）を両方変え、
   `user_version`と`SCHEMA_REVISION`をNNNNへ上げる。`server/test/migrate.test.ts`が「`db/migrations`は2から連続し、
   最大が`SCHEMA_REVISION`とschema.sqlのバージョンに一致する」を検査する
2. `bun run codegen`で`server/src/db-types.ts`を作り直す（メモリ上のSQLiteにschema.sqlを当てて生成する）。
   **手で直さない。**CIの`codegen:check`がずれを落とす。JSONを文字列で持つ列（`refs`・`downsides`・`next`・
   `metadata`）の型は`scripts/codegen.mjs`の`overrides`が付ける。生成列（`knowledge.stance`）は型に出ないので、
   読む側は`sql<…>`で型を付ける
3. 全表`strict`、主キーは全部`not null`を書く（SQLiteはinteger以外の主キーにNULLを許す）
4. 時刻の列は`check (strftime('%Y-%m-%dT%H:%M:%fZ', 列) is 列)`を付ける。`=`で書くと不正な文字列でstrftimeが
   NULLを返しCHECKを通る。書く側は`server/src/db.ts`の`iso()`を通す
5. migrationに`BEGIN` / `COMMIT` / `ROLLBACK`を書かない。runnerがtransactionで包む。SQLiteのCHECKは行ごとに
   すぐ評価される（deferredが無い）ので、既存の行に当たる制約を足す前に、違反する行が0件であることを確かめる
6. 旧バージョンの自動記録は`db migrate`の後も新しいschemaへ書き続ける。captureの3つのviewの列を消す・改名する変更は、
   全PCのpluginが上がった後の別のmigrationにする
7. downは書かない

## SQL の書き方

applicationのクエリはkyselyで書き、結果型は推論させる。node:sqliteを直に扱ってよいのは`sqlite.ts`・`db-write.ts`・
`db.ts`・`admin.ts`・アダプタ（`kysely-node-sqlite.ts`）だけで、`bun run sql`が他のファイルの`node:sqlite`の
importと接続の関数の呼び出しを落とす。node:sqliteの接続を持つ変数は`raw`と呼ぶ（SQLの台帳が`raw.exec(` /
`raw.prepare(`を数える）。

| 形 | 書き方 |
|---|---|
| 1行に子の一覧を入れ子で持たせる | `kysely/helpers/sqlite`の`jsonArrayFrom` / `jsonObjectFrom`。列名は`db.ts`の`JSON_COLUMNS`へ足す（足さないと文字列のまま返る） |
| JSONの列の値 | 読むと`ParseJSONResultsPlugin`が`JSON_COLUMNS`の列だけを値へ戻す。**名前で絞る**（既定の判定は`[`や`{`で始まる本文まで配列に化けさせる）。書くときは`JSON.stringify`して渡す |
| 語彙検索 | `sql`テンプレートでFTS5の表を副問い合わせにしてjoinする（`search.ts`の`knowledgeFts`）。問いは`text.ts`の`ftsQuery`で組む |
| 時刻 | 文字列（ISO 8601、UTC、ミリ秒まで）。辞書順が時系列順。画面とMCPへ渡す境界で`new Date()`にする |
| 真偽値 | `integer`の0/1。node:sqliteはbooleanを束縛できない |
| BLOB | 読むとBufferで返る（アダプタがUint8Arrayから直す）。`content_hash`は`.equals`で比べる |
| 配列との照合 | kyselyの`in`でよい（SQLiteは空の`in ()`を受ける） |
| 多件の書き込み | `insertInto().values([...])`を束（数百行）に分けて流す。1文の変数は32,766まで |
| 上書き | `onConflict(...).doUpdateSet(...)`。変わった行だけを書くなら`.where("表.content_hash", "<>", eb.ref("excluded.content_hash"))` |

書くtransactionは`db.ts`の`inTransaction`（`begin immediate`）で張る。既定の`begin`は読みから始まり、書きへ上がる
ときに別の書き手と当たると`busy_timeout`を待たずに`SQLITE_BUSY`で落ちる。kyselyのSQLiteの接続は1本なので、
transactionの中で他の問い合わせを並行に投げない。`select ... for update`は無い（`begin immediate`が同じ役をする）。

## 表の境界

| 境界 | 表 | 書く口 |
|---|---|---|
| プロジェクトと人 | `project`、`person`、`person_identity` | CLI（project、who）、GitHub同期 |
| 取り込み元の今の状態 | `connector`、`docs_exclude`、`source_item` | GitHub同期、文書同期、CLI（project exclude） |
| 逐語の会話 | `conversation`、`message`、`message_file` | 自動記録（captureの3つのview）、GitHub同期 |
| 検索する知識 | `knowledge`、`knowledge_file` | trace、文書同期 |
| 作業の現在地 | `work_item` | trace |

用途ごとに表を増やさない。知識は`knowledge`一表で、種類は`kind`、「通ってはいけない道」かは
生成列の`stance`（`do` / `dont` / `neutral`）で持つ。stanceをLLMに推測させない。
会話は判断の検索（knowledge / avoid）に混ぜない。混ぜると作業ログが判断を押し出す。

消えたと完全な一覧で確かめられた取り込み元の項目は行ごと消す。`deleted_at`や墓標を置かない。
覆した決定は消さず、`status = 'superseded'`にして`superseded_by_id`で後継を指す（消すと再提案される）。

## 全文検索の索引

検索は語の順位付き検索（FTS5のbm25）で、意味の近さは呼び出し側のAIが語を変えて引き直すことで補う（agentic search）。

- `knowledge_fts`（rowid = `knowledge.id`、列は見出し`h`と本文 + 理由`b`、`bm25(knowledge_fts, 3, 1)`）と
  `message_fts`（rowid = `message.seq`、`indexed = 1`の発言だけ）。どちらもcontentless（`contentless_delete=1`）
- 語は`server/src/text.ts`の`terms()`が切る。**DBのtriggerが書くときに呼ぶ`gleanery_terms`と、問いを組む`ftsQuery`が
  同じ関数を通る。**`gleanery_terms`は`db-write.ts`が書く接続ごとに登録する。登録していない接続（`sqlite3`のCLIなど）
  からknowledge / messageへ書くと`no such function`で落ちる（索引を黙って欠かさない）
- **`terms()`の規則を変えると、既存の索引は古いまま残る。**変えるPRはreleaseの手順に`gleanery db reindex`を書く
- `message.seq`は明示の`integer primary key`（暗黙のrowidはVACUUMで振り直されうる）
- 問いの語は必ず`"…"`で括り、中の`"`を二重にする（`ftsQuery`）。括らないと`AND`・`NEAR`・`:`・`-`が演算子になる

測定は`server/evals/`（一発の検索は`evals:retrieval`、agentに使わせた精度は`evals:agentic`）。

## 値の域を変えるとき

正本はschemaのCHECKで、写しは`server/src/knowledge.ts`の`KINDS`・`STATUSES`・`SPEAKERS`・`ORIGINS`・
`FILE_ACTIONS`にある。片方だけに足すと、DBだけなら検索の札が空になり、コードだけなら取り込みや
自動記録がCHECKで落ちる。`scripts/check-pairs.mjs`が両者を突き合わせる。

種類や状態を足したら、同じ変更で次のインターフェースも扱う。

- `server/src/search.ts`の絞り込みと、`stance`の式が新しい値をどちらへ振るか
- `server/src/mcp.ts`の入力schemaと説明（`recall`の`kinds`）
- `plugin/skills/trace/SKILL.md`の記録の契約と、`server/src/trace.ts`の検査
- `gleanery dashboard`（`server/src/tui/`）の表示と検索
- 列挙できる対なら`scripts/check-pairs.mjs`へ足す

## 接続の役割

同じOSユーザーのプロセスはDBファイルを直接書き換えられるので、OSの権限境界ではない。守るのは
「gleaneryのコードが誤って・untrustedな文章に唆されて書く」経路である。

| 役割 | 開き方 | authorizer | 使うインターフェース |
|---|---|---|---|
| owner | 書ける | 掛けない | `gleanery db *`（`admin.ts`） |
| reader | `readOnly` | 読む・許した関数だけ。DDL・ATTACH・pragmaを拒む | MCP、端末の画面、`gleanery search` |
| ingest | 書ける | DDL・ATTACH・仮想表の作成・書き換えるpragmaを拒む | `harvest`・`trace save`・`who`・`project` |
| capture | 書ける | 3つのview（`capture_*`）へのinsertとそのtriggerの中の書き込みだけ。読めるのは`project`のid・key・nameと`message`のid | 自動記録（`capture.ts`） |

- 書く接続は`server/src/db-write.ts`にだけ置く。MCPと端末の画面のentryから辿って届かないことを`bun run architecture`が見る
- `enableDefensive(true)`を全部の接続で有効にする（FTS5のshadow tableへの直接の書き込みを止める）。node:sqliteの
  既定でも有効だが、既定が変わっても外れないよう明示する
- authorizerのactionは`constants`の名前で参照し、数値を書かない（`SQLITE_UPDATE`と`SQLITE_DETACH`を取り違えた記録がある）
- 初期化の順は固定: 開く → defensiveとpragma → `gleanery_terms` → authorizer。authorizerの後だとpragmaが弾かれる
- captureのviewに無い列（`source_item_id`・`identity_id`・`reply_to_id`・`url`）は名乗れない。GitHubの会話を作ることも、
  他人の身元を名乗ることもできない。**件数を影響行数で数えない**（viewへのinsertは0になる。送る前に在ったidとの差で数える）
- readerの関数の許可リスト（`sqlite.ts`の`READER_FUNCTIONS`）に足すのは、testが`not authorized`で落ちたときだけ
- 権限はコードを読むだけで判定しない。`server/test/db.test.ts`が役割ごとの禁止操作を実際の接続で確かめる

## 書き込み

`content_hash`が一致する行は書き直さない（毎日の同期で全行を書き直さない）。

新しい取り込み元は`gleanery harvest`にも繋ぐ。手動のcommandだけを足して完了にしない。

### 文書

文書同期（`server/src/docs.ts`）は、remoteの既定branchの**commit tree**を読む。作業ツリーは読まない。
`connector.head_oid`に入れたcommitを持ち、そこからfast-forwardできるcommitだけを自動で入れる。
fast-forwardでなければ一度だけ取り直し、前に入れたcommit以降まで進んでいれば（同時に走った別の同期が先に入れた）
何も書かずに終える。進んでいなければ巻き戻し・force-pushとして書かずに止め、`gleanery harvest --cwd <dir> --reset-docs`を
案内する。巻き戻しを成功扱いにしない — 漏れた文書を巻き戻して消したときに、検索に黙って残る。
投影の規則（節の割り方、前置する文脈）を変えたら`PROJECTION`の定数を上げる。次の同期で全文書が書き直される。

- 取り込まない`path`は`docs_exclude`（docsのconnectorに紐づく）に置き、blobを読む前に当てる。追跡された
  Markdownが全部「事実を述べた文書」とは限らない（監査のfixtureは、取り込むと架空の規約が本物より上位で返る）
- `.gleanery/`（入れ子も含む）は取り込まない。以前の要件定義・設計書の置き場所で、承認していない下書きが残りうる
- 原文は`source_item`（`kind`が`document`、`body`に原文）、検索するのは`knowledge`の`document`の節である。
  節の連結から原文は戻らない

### GitHub

GitHub同期（`server/src/github.ts`）は`gh api`で毎回全件を取る。取得を始めた時刻を`connector.snapshot_at`に持ち、
それより前に始めた取得は遅れてcommitしても書かない。
`source_item.closed_at`はPRならmergeした時刻（mergeせず閉じたなら閉じた時刻）、issueなら閉じた時刻で、
`state = 'open'`と`closed_at is null`が一致することをCHECKが強制する。

## 検証

testは一時ディレクトリの本物のSQLite（`server/test/temp-db.ts`）でSQLを実行して結果を見る。`~/.gleanery`を触らない。

- `bun run verify`に次が入っている
  - `sql:reach`: `server/src`の全部のSQLのcall siteが、testの中で本物のSQLiteに実行されたかをV8のカバレッジで数える。
    実行されていない箇所をfile:lineで挙げる
  - `sql:live`: CLIと自動記録のフックを子プロセスで一時HOMEのDBへ通す（`LIVE_FILES`の全call site）
- `bun run codegen:check`: `db-types.ts`がschema.sqlと一致するか
- migrationを足したら、空のDBへ`gleanery init`した形と、前のバージョンから`db migrate`した形で`sqlite_schema`が一致することを確かめる（`server/test/migration-artifacts.test.ts`が前のschemaのfixtureから当てる形）

## 既存のDBへ当てる

DBはPCごとに独立している。**当てるのは自分のPCのDBだけで、他のPCへは届かない。**各PCでそれぞれ当てる。

DBが古いときにMCPの応答が`db migrate`を案内しても、AIがそれを読んでそのまま当てない。持ち主が端末で打つ。

1. mergeする
2. 控えを取る。MCPと自動記録を止めてから`~/.gleanery/gleanery.db`（と`-wal`・`-shm`）を複写する。当てて問題が出たときに
   戻せるのはこれだけで、**取らずに当てると戻せない**
3. 持ち主が端末で`gleanery db migrate`を叩き、当てる一覧を確かめてyesを打つ
4. pluginを更新する（`plugin-release`）
5. `gleanery doctor`で確かめる

戻すなら2の控えで置き換える。控えを取った後に入った自動記録とtraceは消える。コード側も同じcommitまで戻す。
