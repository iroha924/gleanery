---
name: tui
description: gleaneryの端末の画面（`gleanery dashboard`、server/src/tui/ の Ink）とCLIの出力の見た目（server/src/tui/view.ts）を変更する。画面・キー操作・一覧と詳細の表示・CLIの出力の形・記号とアイコン・Markdownの描画・CLIのbundleを触るときに使う。セッションや作業の読み出し（server/src/sessions.ts）を画面のために変えるときも使う。MCP・CLIの他のcommandだけの変更やDB schemaの変更には使わない。
---

# 端末の画面を変更する

`gleanery dashboard` は Ink で描く端末の画面で、**読むだけ**である。

## Triggers

- `server/src/tui/` の画面・キー操作・表示を変更する
- 画面が読むもの（`server/src/sessions.ts`、`server/src/tui/data.ts`）を変更する
- CLI の出力の形（`server/src/tui/view.ts`。見出し・節・字下げ・締めの行）を変更する
- アイコン（`server/src/tui/icons.ts`）、Markdown の描画（`markdown.ts`）、CLI の bundle（`scripts/bundle-cli.ts`）を変更する

## Does not trigger

- MCP・他の CLI command・取り込みだけを変更する
- DB schema や接続の役割を変更する。その場合は `knowledge-schema`
- バージョンを上げて届ける。その場合は `plugin-release`（TUI は CLI の一部なので release の種別は `plugin`）

## 依存について知っておくこと

記憶で API を選ばない。バージョンは `server/package.json` が正本で、API は `server/node_modules/<package>` の型定義（`.d.ts`）を読む。
下の事実はバージョンを上げたときに崩れうるので、上げたら型定義で確かめ直す。

| 依存 | 規約に効く事実 |
|---|---|
| ink | `useWindowSize`・`useInput(handler, { isActive })`・`render(..., { alternateScreen })`を使っている。開発時だけ `react-devtools-core` と `ws` を動的 import する（bundle で差し替える理由） |
| @inkjs/ui | `TextInput`（`onSubmit`・`isDisabled`）を使っている。読み込み中は自前の `Twinkle`（`icons.ts` の `TWINKLE`） |
| ink-scroll-view | `ScrollView` の ref の `scrollTo`（`getBottomOffset` までに収める）/ `scrollToTop` / `scrollToBottom` で動かす。`scrollBy` は本文の終わりで止まらない |
| ink-link | 型が `children` を props の必須にしている |
| marked | **marked-terminal の peer（`<16`）の外のバージョンを、持ち主の決定で入れている** |
| marked-terminal | 型を同梱しない。`@types/marked-terminal` は古い marked を引き込むので入れず、`marked-terminal.d.ts` で宣言する |
| ink-testing-library | 描画と `stdin.write` の入力が Ink の今のバージョンで動く。動かなくなったら `render` に偽の stdout を渡す形へ替える |

## 置き場所

| ファイル | 持つもの |
|---|---|
| `tui/tui.ts` | entry。TTY でなければ案内して終わる。reader の接続を開いて閉じる |
| `tui/app.ts` | タブ・キー操作・画面・操作の案内 |
| `tui/data.ts` | 画面が呼ぶ読み出しの型（`Data`）と本物の実装。test は偽の `Data` を渡す |
| `tui/icons.ts` | 記号と読み込み中の回転（`TWINKLE`）を名前付きで持つ唯一の場所 |
| `tui/markdown.ts` | AI の応答を ANSI にする |
| `sessions.ts` | セッション・プロジェクト・作業の一覧の query |

## 書き方

- **JSX を使わず `createElement`（`h`）で書く。**この repository は Node の型剥がしで `src` を直接動かし（`node src/cli.ts`、
  `node --test`）、Node は JSX を読めない
- children は第 3 引数以降で渡す（biome の `noChildrenProp`）。型が children を props の必須にしている部品（`ink-link`）だけ、
  理由を書いた `biome-ignore` で props に渡す。自前の部品は children を任意にするか、別の名前（`render`）の props にする
- **SQL を `tui/` に書かない。**`sessions.ts`・`search.ts` の関数を `data.ts` から呼ぶ。MCP・CLI と同じ関数を通すので、
  同じ語で同じ順位が返る
- 接続は reader だけ。`tui/` から ingest / capture / owner の接続や、書き込む module（`capture.ts`・`trace.ts` など）を
  import しない（`server/test/tui.test.ts` が見る）。**取り込み・trace を起動するキーを足さない**
- DB は読むだけの接続（`openReader`）だけを開く（`data.ts`）。書く接続（`db-write.ts`）を import しない（`bun run architecture` が止める）

## 画面の作法

- データを引く画面は、読み込み・空・失敗・成功の 4 つを出す（`useLoad` と `Pending`）。空と失敗を同じ表示にしない。
  失敗の文は「何を読めなかったか」から始める
- 詳細を開いている間も一覧は `display: "none"` で隠すだけにする。作り直すと、Esc で戻ったときに選んでいた行・ページ・
  検索の語が消える（実測で踏んだ）
- 一覧の行で、札や日時のような幅の決まった列は `flexShrink: 0` の Box に入れ、題の列だけを縮めて `truncate-end` で切る。
  縮めると日本語の札が途中で折り返して行が崩れる（実測で踏んだ）
- キーを足したら、画面の下の案内にも足す。文字を打っている間（検索の入力）は、1 文字の操作（`q`・`j`・`/`）を発火させない
- **色は `server/src/palette.ts` のくすんだアースカラーだけを使う**（持ち主の決定。hex をほかに書かない）。ベースはテラコッタ
  （見出し・選んでいる行・タブ・割合の棒）。記録の札は `kindColor` が種類と状態で決める。避ける道と失敗はローズウッド、
  採る道はセージ、止まっている・未解決は黄土。「避ける判断」（`rosewood`）と「失敗・読めなかった」（`failure`）はいまは同じ
  値だが、意味が違うので名前を分けて持つ。色で意味を足すときも、値ではなく名前を足す
- @inkjs/ui の部品の色は `server/src/tui/theme.ts` のテーマで差し替える。色数の少ない端末へ落とすのは chalk と Ink に任せる

## アイコン

`icons.ts` の名前で参照し、記号を画面のコードに書かない。**Unicode の標準の記号だけを使う**（持ち主の決定。Nerd Font を
必須にしない）。Nerd Font の記号は私用領域にあり、そのフォントが無い端末では □ になる。標準の記号なら、端末のフォントに
無くても OS の代替フォントが描く。

足すときは次を満たす記号を選ぶ（Python の `unicodedata.east_asian_width` で確かめる）。

- 東アジアの文字幅が中立（`N`）。曖昧（`A`）は日本語の端末の設定で 2 桁になり、列がずれる。広い（`W`）は常に 2 桁
- 絵文字として描かれない（`\p{Emoji_Presentation}` に当たらない）。`test/tui.test.ts` が私用領域と絵文字を見る

読み込み中の回転（`TWINKLE`）は Claude Code と同じく形の近い星を行って戻る。`·` と `✽` は幅が曖昧なので、描く側で幅 2 の
枠に入れて横の文字をずらさない。

## Markdown

`renderMarkdown(text, width)` は幅ごとに `Marked` の instance を 1 つ持つ。marked-terminal の癖（見出しの `##` が残る、
箇条書きの中の inline の記法が描かれない）は、見出しの設定と text の renderer で描いている。描いた後は色（SGR）だけを残し、
ほかの制御文字と文字を隠す指定を落とす（Markdown は文字参照を戻す）。**marked を上げたら test の Markdown の検査を必ず通す**（peer の範囲外で
入れているので、壊れても install では気付けない）。

## bundle

CLI は出力も dashboard も Ink で描くので、Ink は `plugin/dist/cli.js` にバンドルする（別ファイルに分けない）。
`scripts/bundle-cli.ts` が `Bun.build` で `cli.js` を作り（`scripts/bundle.mjs` から呼ぶ）、`react-devtools-core` と `ws` を
空の module へ差し替える（開発時だけ通る経路なので挙動は変わらない）。`bun build` の command でバンドルすると、この差し替えが
できずに落ちる。MCP と自動記録（`mcp.js`・`capture.js`）は Ink を読まない。

## CLI の出力

CLI の command は `server/src/tui/view.ts` の部品で出す（`console.log` に素の文字列を渡さない）。

| 部品 | 使う場面 |
|---|---|
| `document(見出し, 要点, 節, 締め)` | 1 回で出し切る結果。節は `table`（一覧）・`cards`（Badge 付きの項目。検索の記録）・`fields`（項目と値）・`meter`（割合）・`note`（お知らせ・空）・`lines` |
| `failure(見出し, 理由)` | 止まったとき。端末では赤の Alert |
| `steps(見出し, 手順, 注意)` | 打つ command の手順。command は折らない（入らない幅では枠を付けない） |
| `title`・`section`・`indent`・`closing` | harvest のように途中経過を流すもの、doctor のように節ごとに出すもの |

- 端末では、見出しの枠に要点を添え、見出しの後・節の間・締めの前に空行を置く。色と飾りは標準出力と標準エラーの両方が
  端末のときだけで、pipe（AI が Bash から読む）では字下げした文字だけにし、折り返さない。見出しは `✦ <text>` の 1 行
- **中身は必ず字下げし、締めの行だけを行頭に置く。**外から来た文字（PR の題、DB に残ったエラー文）は、枠・セル・字下げの
  中にだけ入れる。改行を含んでも、行頭の締めの行や状態の行を偽造できない（`server/test/view.test.ts`・`cli.test.ts`）
- `search` の pipe は、記録の囲い（`framed`）を付けた MCP と同じ文字で出す（AI が読む出力）。端末では `cards` で出す
- 自動記録のフックは Ink を読まないので `server/src/panel.ts` の形のまま出す
- `@inkjs/ui` の部品は型が children を props の必須にしているので、`view.ts` の `part` で渡す

## 検証

1. `bun run verify`。`server/test/tui.test.ts` が `ink-testing-library` で偽の `Data` を描き、キーを送って中身を見る。
   直すときは、直す前のコードでその test が落ちることを確かめる
2. **配る物を展開して、端末で動かす。**`bun run bundle` → `cd plugin && npm pack` → repository の外へ展開し、
   `node_modules` の無い場所で `node package/dist/cli.js dashboard` を起動する（AI が端末を持たないときは
   `script -q /dev/null node package/dist/cli.js dashboard`（macOS）/ `script -qc 'node package/dist/cli.js dashboard' /dev/null`（Linux）で
   疑似端末を与えて入力を送る）。セッション一覧 → Enter で詳細 → Esc、Tab で作業の一覧 → Enter で詳細 → Esc、Tab で検索 → 語を打って
   Enter → 結果を Enter で全文、を通して `q` で終了コード 0 を見る。pipe から起動すると案内を出して 1 で終わる
3. 日本語の本文で列と罫線が揃うこと、端末を狭くしたときに選んだ行が画面の外へ出ないことを目で見る
4. 画面を変えた commit の前に、画面のレビューを受ける（Claude Code では `review-ui`。端末の画面の節がある）
