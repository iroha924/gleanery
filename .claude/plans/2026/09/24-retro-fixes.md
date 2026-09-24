# 振り返りレビューの残り 5 件を直す（PR 4b）

- 日付: 2026-09-24
- Codex との議論: 1 往復（session `01a0cf69-a170-7023-b4e0-8e4e288c4482`）。Codex の修正案を全部受け入れ、重大な未解決点は 0
- 持ち主の判断: tasks.md の順（PR 7 の後に PR 4b）で進める

## 目的

Codex の振り返りレビュー（v0.33.32..v0.35.0）で出て、いまも残っている 5 件を直す。1 件目は、第三者が書いた文章で端末の表示を偽装できるセキュリティの欠陥である。

## 対象外

- MCP の応答（`framed` と `visible` が別の境界として扱う。端末向けの修正は当てない）
- 作業の一覧のページ送り（「黙って切れる」を直すだけ。古い作業へ移る手段は足さない）
- バージョンの prerelease（持っていない）

## 方針

### 1. 端末の制御文字

- 悪用の筋: `gleanery harvest` が取り込む PR・issue の本文や、記録された会話に ESC や CR を仕込む。それを端末に出す経路が落とさずに出すと、表示を書き換えられる（行頭の印の上書き、偽の ✓ の行、色やカーソルの操作）
- 塞ぐ位置は出す境界。複数行の本文は `plain`、1 行に収めるもの（名前・path・題）は `inline`（どちらも `server/src/panel.ts` にある）
- 端末の画面（`server/src/tui/app.ts`）: 表示の直前に、複数行・1 行・Markdown 用の小さな表示関数を置き、表示する全部の欄を通す。data.ts の値は変えない（検索と参照に使う値を変えない）。Markdown は入力を `plain` に通してから `renderMarkdown` に渡す（描画器が付ける装飾の ANSI は残る）
  - 対象: 発言の本文、セッションの題・支流名・ファイルパス・trace の記録、作業の一覧と詳細、検索結果と全文（`ReadView`）、画面上部のプロジェクト名、読み取りのエラー。`oneLine` は空白を畳むだけなので `inline` を通す
- CLI（`server/src/cli.ts`）: `trace context`（`plain(framed(...))`）、`search` の pipe の末尾のプロジェクト名、`project list`・`add`・`forget`・`exclude` の名前と path、`doctor` のプロジェクト名、`harvest` のプロジェクト名と同期結果、`who` の登録結果の linked handle
- `plain` はタブと一部の結合文字を意図して残すので、test の条件は「ESC と CR（と plain が落とす制御文字）が無い」にする

### 2. marketplace.json を配布物の入力に数える

- `scripts/lib/release-scope.mjs` の入力に `.claude-plugin/marketplace.json` を足す。`scripts/release-plan.mjs` の versionFiles にも足す（`source.version` だけの変更は数えない）

### 3. バージョンの下げを拒む

- `scripts/check-mcp-version.mjs`: 旧バージョンとの大小の検査を「配布物の入力が変わっていなければ通す」より前に置く。入力が変わったなら新しいバージョンが厳密に大きいこと、バージョンだけの変更でも下げは失敗にする。`major.minor.patch` を数で比べる

### 4. 作業の一覧が黙って切れる

- `listWork` で 101 件を読み、`Data.works()` は 100 件と `hasMore` を返す。`WorkList` は「最新 100 件（ほかにもある）」を 1 行出し、その分を一覧の高さから引く

### 5. eval の `--name` で外のディレクトリを消しうる

- `server/evals/agentic/run.ts`: 削除より前に `--name` を `^[A-Za-z0-9][A-Za-z0-9._-]*$` に限る。既存の `OUT/<name>` が symlink なら拒み、削除先の親の実パスが `OUT` の中であることを確かめる

## 次に同じ誤りを止めるもの

- 1: 表示の経路を列挙した回帰 test。TUI は偽の `Data` で一覧・詳細・全文を開き、CLI は一時 DB の記録で該当の command を流す。pipe では ESC と CR を禁じ、TUI と TTY では制御文字を含む入力が表示や行の構造を偽装できないことを見る。型で強制する案は、Ink の `Text` が string を受けるだけなので棄却する
- 2・3: 一時の git リポジトリの version gate の test（取得元だけを変える → 落ちる、`source.version` だけを変える → 数えない、下げる → 落ちる）
- 4: 100 件と 101 件の境界の test
- 5: 越境する名前と、symlink を置いた場合が削除の前に落ちる test

## 採った案と棄却した案

- 採った: 出す境界で `plain` / `inline` を通す。棄却: 読んだ直後（data.ts）で書き換える（検索や参照に使う値まで変わる）
- 採った: 経路を列挙した回帰 test。棄却: 全 command を一括で流す検査（TUI と TTY は装飾の ANSI を持つので「ESC が無い」で判定できない）
- 採った: 下げの検査を早期に通す分岐より前に置く。棄却: 最後の比較だけを置き換える（バージョンだけを下げた変更が通る）
- 採った: eval の名前を字句で限り、symlink も拒む。棄却: `path.resolve` の文字列の検査だけ（symlink の先は外になりうる）
- 採った: 作業の一覧は案内だけ。棄却: ページ送り（欠陥の範囲を超える）

## 手順

1. 作業ブランチを切り、この計画を最初の commit に入れる
2. 項目ごとに test を先に書き、直す前のコードで落ちることを確かめてから直す
3. `bun run verify`、review-ui（画面が変わる）、review-shipping（検査 script が変わる）、Codex のレビュー
4. 0.37.3 へ上げ、PR → CI → PR の head に tag → stage → 持ち主の承認 → merge → latest

## 検証

- 上の test がすべて、直す前に落ちて直した後に通る
- `bun run verify`、CI（Windows の job を含む）
- 端末の画面を実機で開き、制御文字を含む記録が崩れずに出ることを目で見る（CI では見えない）
