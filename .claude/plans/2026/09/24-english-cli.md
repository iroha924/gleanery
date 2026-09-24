# CLI と dashboard を英語にする（完全な英語化の第 1 段）

- 日付: 2026-09-24
- Codex との議論: 2 往復（session `01a0d20e-7b05-7a52-a884-acabae512718`）。4 点（C10〜C13）を反映すれば重大な未解決点は無い、で合意
- 持ち主の判断: 最終的に完全に英語にする。まず CLI（dashboard を含む）。触るファイルのコメントを英語に直し、新しいコメントと commit message は英語。これを CLAUDE.md と AGENTS.md に書く。issue・PR のテンプレートは後の段。**利用者は日本語で記録を残す人も対象**（持ち主を含む）

## 目的

`gleanery` の CLI と `gleanery dashboard` が出す文字（見出し・案内・エラー・キーの説明・札・全文表示の囲い）を英語にする。

## 対象外

- MCP の応答と tool の説明（`mcp.ts` と、MCP が使う既定の出力）。自動記録の hook の出力（`panel.ts`）。plugin Skill・Agent の本文。issue・PR のテンプレート。`.claude/rules`・Skill などの開発文書
- **DB に入る値**（`text.ts` の伏せ字の札、`docs.ts` の節の key「本文」、trace の内容、取り込んだ本文）。変えると content_hash が変わり既存の行が書き直される
- 開発用の scripts の出力

## 制約

- 日本語の記録の保存・表示・検索（語の切り方、`ftsQuery`）と、日本語の文字幅に合わせた列と罫線の揃えを崩さない
- test の日本語の fixture は残し、日本語の記録がそのまま表示されることを確かめる

## 方針

1. 翻訳の仕組み（i18n、locale の切り替え）は入れず、英語へ置き換える
2. CLI だけから届く module（`cli.ts`、`tui/*`、`admin.ts`、`plugin.ts` の doctor、`capture.ts` の CLI の経路、`github.ts`・`docs.ts` の harvest の案内、`sessions.ts` の「題なし」）の文字を英語にする
3. MCP と共有する表示（`knowledge.ts` の札、`search.ts` の `read()`・`renderWork()`・`framed()`・話者の札）は、MCP の既定の出力を保ち、CLI・TUI には英語の表示経路を渡す。札は日本語の label の文字列比較ではなく、種類・状態・話者の区分から引く。英語の囲いにも、呼び出しごとに変える閉じ札とバイト上限を効かせる。MCP を英語にする段で 1 つに戻す
4. `sqlite.ts`・`project.ts`・`assets.ts` の Error（次に打つ command の案内）は英語にする。MCP の失敗応答にも英語の案内が出るのを受け入れる
5. `trace.ts` の検査の文（`trace check` / `save` が出す）を英語にする
6. `plugin/skills/trace/SKILL.md` は、CLI と同じ件数の表現を写している箇所だけ合わせる
7. 触ったファイルのコメントは英語にする。日本語の値を残すファイル（`knowledge.ts`・`search.ts`・`docs.ts` など）もコメントは英語にする
8. 機械の検査 `scripts/check-english.mjs` を足す。js-tokens（server の devDependencies）で文字列・template・コメントを字句として読み、ひらがな・カタカナ・漢字・全角の記号を探す
   - 英語だけのファイル: 文字列とコメントの両方を見る。コメントだけのファイル: コメントだけを見る
   - 例外は対象のリテラルの直前の印に理由を書く。印の付いたリテラルに日本語が無ければ落とす（要らなくなった例外を残さない）
   - `bun run verify` と lefthook に入れる。一覧は後の段で増やす
9. CLAUDE.md と AGENTS.md に同じ名前の invariant を足す: 新しく書く・変えるコードの文字列とコメント、commit subject は英語。既存の日本語の文言は段ごとの範囲で変える
10. バージョンは 0.38.0。README の「CLI と dashboard は日本語」の注記を直す

## 用語

| 日本語 | 英語 |
|---|---|
| 決定 | decision |
| 採った案 / 棄却した案 | chosen option / rejected option |
| 制約 | constraint |
| 行き止まり | dead end |
| 作業 | work |
| セッション / プロジェクト | session / project |
| 記録 | record |
| 自動記録 | recording |
| 取り込み | import（command は harvest） |
| 持ち主 | you（本人を指す文）/ owner |

## 採った案と棄却した案

- 採った: 英語へ置き換える。棄却: i18n と locale の切り替え（最終的に英語だけにする）
- 採った: 共有の表示は CLI・TUI に英語の経路を渡す。棄却: 共有の札を今回英語にする（MCP の応答が変わる）、共有の札を残す（CLI と dashboard に日本語が残る）
- 採った: 案内の Error は英語にする。棄却: CLI 側で英語へ写す（同じ文を 2 か所で持つ）
- 採った: 検査は字句（js-tokens）で文字列とコメントを見る。棄却: 出力全体に日本語が無いことを見る（日本語の記録で落ちる）、行単位の正規表現（複数行の template や文字列の中の `//` を見分けられない）
- 採った: 1 PR。棄却: CLI の command と dashboard で分ける（同じ版に入り、共有の表示と test がある）

## 手順

1. この計画を最初の commit に入れる
2. `check-english` と一覧を書き、今のコードで落ちることを確かめる
3. コマンドごとの英語の期待値の test を先に書き、今のコードで落ちることを確かめる
4. 共有の表示に英語の経路を足す（`search.ts`・`knowledge.ts`）
5. module ごとに文字列とコメントを英語にし、test の期待値を直す
6. CLAUDE.md・AGENTS.md・README・trace Skill を直す。`release:plan` の後に 0.38.0 へ上げる
7. verify → pack して dashboard を疑似端末で通す → review-ui・review-shipping・Codex → PR → release（stage の block も初めて通す）

## 検証

- `check-english` と英語の期待値の test が、直す前に落ちて直した後に通る
- `bun run verify`。sql:live の期待値を直すときは、到達と結果を見る条件を保つ
- 配る物を展開し、`--help`・`doctor`・`harvest`・`search`・`trace context` を端末と pipe の両方で、dashboard を疑似端末で通す（検索結果の全文を含む）
- 日本語の記録がそのまま表示され、列と罫線が揃う。狭い端末で崩れない（review-ui）
- MCP の応答が変わっていない（`recall`・`read` の既定の出力の test が通る）

## リスク

- 文字の数が多く（`cli.ts` だけで 183 行）、訳の揺れが出る。用語の表で揃える
- test の期待値の大量の書き換えで、検査を弱める書き換え（正規表現を緩める）が混ざる。review-shipping に見てもらう
- 共有の表示の経路を 2 つ持つ間、片方だけを直す誤りが出る。MCP の段で 1 つに戻す
2026-09-24: 検査の字句解析は TypeScript 7 に JavaScript の API が無いので、server の devDependencies に js-tokens 10.0.0 を足して使う（npm で来歴・公開日・依存 0 を確認）。持ち主の Go を得た（devDependency に限る）。
2026-09-24: 持ち主のゴール（英語の利用者は CLI と dashboard で、自分の記録以外の日本語を見ない）に合わせ、DB に入る gleanery の札も英語にした: 秘密の伏せ字、長い発言を切った印、AskUserQuestion のメモ、文書の節の key の既定値（PROJECTION を 3 へ）。持ち主の Go を得た（既存の DB は消してよい）。README の英語表示の注記は持ち主の判断で置かない。
