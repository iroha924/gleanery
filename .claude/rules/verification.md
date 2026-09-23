# 検証のしかた

**緑だったことと、検査したことは別である。**このリポジトリで実際に空振りした 4 つを挙げる。

## releaseは分類から始める

配布物へ入る変更では、versionを編集する前に
`bun run release:plan -- --base <前回のrelease commit>`を実行する。表示された種別を変えて扱わない。 <!-- invariant: release-plan -->

- `none`: releaseしない
- `plugin`: 配布物に入る変更（MCP・CLI・端末の画面・hook・plugin Skill/Agent・共有module）。npmと3つのplugin versionを同じ値へ上げる

不可逆な操作は自動化せず、cleanなreview済みcommitで
`bun run release:prepare -- --base <前回のrelease commit>`が残したtarballだけをpublishする。

## test は一時ディレクトリの本物の SQLite で SQL を実行する

DB は `node:sqlite` の 1 ファイルで、資格情報もネットワークも要らない。test は `server/test/temp-db.ts` で一時
ディレクトリに DB を作り、本番と同じ接続の factory（reader・ingest・capture）で SQL を実行して**結果**を見る。
組み立てた SQL の文字列を照合しない（偽の DB は、実行されない SQL を緑のまま通した。#85 で 2 種類・6 箇所）。 <!-- invariant: real-sqlite-tests -->

- `~/.gleanery` を触らない。DB の path は引数か `GLEANERY_DB` で渡す
- `sql:reach` が「`server/src` の全部の SQL の call site が test の中で実行されたか」を数える。実行されない箇所は
  file:line で落ちる。台帳は `scripts/lib/sql-call-sites.mjs`
- CLI と自動記録のフックは test から DB を差し込めないので、`sql:live` が子プロセスで一時 HOME の DB へ通す。
  親が期限と終了を持つ

**子プロセスの `HOME` を一時ディレクトリへ向ける。**外すと、検査が持ち主のデータを壊す。実測: `capture flush` が <!-- invariant: temp-home -->
持ち主の `~/.gleanery/spool` を読み、使い捨ての DB へ送って未送信 4 件を消した。親の `GLEANERY_DB` も子へ渡さない
（渡すと、子は一時 HOME ではなくそちらの DB を開く）。

## agentic の eval は持ち主の DB とサブスクを使う

`bun run evals:agentic`（`server/evals/agentic/`）は、出荷の MCP を `claude -p` に渡して持ち主の実 DB を引かせる。
測る物が持ち主の記録と持ち主の枠なので、`sql:live` の条件には当てはめず、**`bun run verify` にも CI にも入れない。**

- `claude -p` に `--no-session-persistence` を付ける。実測: 付けずに回した実験で `~/.claude/projects/` に
  1 問 1 つずつ、379 個のセッションが溜まった。付けても cwd ごとに空の `memory/` ができるので
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` も渡す（実測: 42 問で 42 個）
- 作業ディレクトリは問いごとの一時ディレクトリにし、`--setting-sources project` と `--strict-mcp-config` で
  持ち主の plugin と hook を読ませない。読ませると自動記録が eval の会話を持ち主の DB へ書く
- 検証用（holdout）の問いはゲートの判定でだけ流す。見て直すと、ゲートが改善の途中を測るだけになる
- 1 回では比べない。同じ構成を 3 回流した平均どうしで比べる（実測: 同じ構成の 4 回で top1 が 7 問動いた）
- **比べる条件を揃える。**`--model sonnet` のような別名の指す先と、Claude Code の既定の effort はバージョンで変わる（2026-09-23 に
  Opus 5.5 が既定になった）。run は実際のモデルの ID・Claude Code のバージョン・effort を記録し、judge は揃わない run どうしを比べると
  警告する。基準に記録が無かったときは、各問いの trace（init）から確かめて書き足した
- 測る DB は `GLEANERY_DB` で指せる（MCP の設定へ明示して渡す）。旧構成と同じ記録で比べるときに使う

## 黙って skip するテストを書かない

前提が無いとき `continue` で飛ばすと、CI では常に飛んで緑になる。前提が無いなら落とす。 <!-- invariant: no-silent-skip -->

実測: 画面のビルド成果物が無ければ飛ばすキャッシュの検査を書いたが、`verify` は `build` より先に
`test` を走らせていたので、一度も動かないまま通っていた。`verify` の順序を `check && bundle && test` に変え（`bundle` が配布物を建てる）、
飛ばす代わりに落とすようにして直した。

## test から外部 API に繋がない

test は資格情報なしで通す（`.github/workflows/check.yml` も同じ前提で書いてある）。GitHub は偽の `gh` を PATH の <!-- invariant: no-external-api -->
先頭に置いて渡す（`scripts/lib/live-harness.mjs`）。

止めるのは `--test-timeout=60000`（`server/package.json`）で、こちらが正本である。実測: 接続を掴んだまま閉じない
検査を足したら、`bun run verify` が 22 分終わらなくなった。test の後始末（`TempDb.done()`）で接続を閉じる。

## SQLite の返り値は型の宣言と違うことがある

kysely の型は `db-types.ts`（生成）から来るが、実際の値は node:sqlite が決める。test で実行して初めて分かる。

- BLOB は Uint8Array で返る（型は Buffer）。`.equals` で hash を比べる経路が落ちた（文書の同期の test で見つかった）。 <!-- invariant: sqlite-values -->
  アダプタ（`server/src/kysely-node-sqlite.ts`）が Buffer に揃える
- 行は prototype を持たない object で返る。`assert.deepStrictEqual` は prototype まで比べる
- STRICT の表は、失わずに変換できる値（`"1"` → 1）を受ける。拒むことを確かめる値は変換できないものにする
- `integer primary key` の表で `returning rowid` は列名が主キーの名前で返る。`returning rowid as rowid` と書く
- node:sqlite は defensive を既定で有効にしている。外す検査で落ちることを確かめるなら `enableDefensive(false)` にする

## 配る物は展開して見る

`plugin/dist` と `plugin/db` は追跡しないので、`git diff` には出ない。`npm pack` して <!-- invariant: pack-and-inspect -->
リポジトリの外へ展開し、中身を数えて起動する。

実測: 配布物に 115 個のフォントと React が入っていたのに、ライセンスの告知に 1 件も載っていなかった。
リポジトリを見ているだけでは気付けない。CI の「配る tarball が自己完結しているか」がこれを見る。
