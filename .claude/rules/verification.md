# 検証

## release

- 配布物に入る変更は、バージョンを編集する前に `bun run release:plan -- --base <前回のrelease commit>` を流し、出た種別で扱う <!-- invariant: release-plan -->
  - `none`: release しない
  - `plugin`: 配布物に入る変更（MCP・CLI・端末の画面・hook・plugin Skill/Agent・共有 module）。npm と 3 つの plugin manifest を同じバージョンへ上げる
- npm へ出すのは、PR の head に打った `v<version>` の tag から `.github/workflows/release.yml` が stage した tarball だけ。手元から `npm publish` しない。stage の承認・merge・latest への昇格は `plugin-release` Skill の手順で手で打つ
- release の各段の前に `plugin-release` Skill を開き直し、書かれたコマンドをそのまま打つ。environment `npm-release` の承認、npm の Staged Packages の承認、`npm dist-tag add` は持ち主がする。Claude は代わりに押さない・打たない <!-- invariant: release-owner-steps -->

## test

- 一時ディレクトリの本物の SQLite（`server/test/temp-db.ts`）で SQL を実行し、結果を見る。組み立てた SQL の文字列を照合しない（実行されない SQL が緑のまま通る） <!-- invariant: real-sqlite-tests -->
- `~/.gleanery` を触らない。DB の path は引数か `GLEANERY_DB` で渡す
- `sql:reach` は `server/src` の SQL の call site（`LIVE_FILES` を除く。そちらは `sql:live`）が test で実行されたかを数える。台帳は `scripts/lib/sql-call-sites.mjs`
- CLI と自動記録の hook は `sql:live` が子プロセスで通す。子の `HOME` は一時ディレクトリにし、親の `GLEANERY_DB` を渡さない（持ち主の `~/.gleanery` を読み書きする） <!-- invariant: temp-home -->
- 前提が無いときに skip しない。落とす（CI で常に飛んで緑になる） <!-- invariant: no-silent-skip -->
- 外部 API に繋がない。資格情報なしで通す。GitHub は偽の `gh` を PATH の先頭に置く（`scripts/lib/live-harness.mjs`） <!-- invariant: no-external-api -->
- 接続は `TempDb.done()` で閉じる（掴んだままだと `verify` が終わらない）。期限の正本は `server/package.json` の `--test-timeout`

## SQLite の返り値

- BLOB は Uint8Array で返る。`server/src/kysely-node-sqlite.ts` が Buffer に揃える <!-- invariant: sqlite-values -->
- 行は prototype を持たない object で返る（`assert.deepStrictEqual` は prototype まで比べる）
- STRICT の表は変換できる値（`"1"` → 1）を受ける。拒むことを確かめる値は変換できないものにする
- `integer primary key` の表の `returning rowid` は主キーの名前で返る。`returning rowid as rowid` と書く
- node:sqlite は defensive が既定で有効。外して落ちることを確かめるときは `enableDefensive(false)`

## 配布物

- `plugin/dist` と `plugin/db` は追跡しないので `git diff` に出ない。`npm pack` して repository の外へ展開し、中身を数えて起動する <!-- invariant: pack-and-inspect -->
