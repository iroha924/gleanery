# merge した PR の判断を knowledge に入れ、issue のテンプレートを揃える（#72・#73）

- 日付: 2026-09-24
- Codex との議論: 3 往復（session `01a0d12c-274d-7790-8efe-c37127a7f8f8`）。重大な未解決点は 0
- 持ち主の判断: #72 と #73 を 1 つの PR で対応する。生成 AI の API は持たない（#117 で棄却済み）

## 目的

merge した PR の本文の「## 採った案と棄却した案」に書いた判断を、`recall` の knowledge と avoid から引けるようにする。
いまは PR 本文が発言（message）にしか入らず、`mode: said` でしか当たらない。あわせて、issue を書く型を揃える。

## 対象外

- issue からの取り出し（issue の終了理由 `state_reason` を持っておらず、足すと schema と同期の変更が増える。#72 の範囲を PR に絞ったことを PR 本文と issue に書く）
- `check_path`（ファイルに結ぶ書式は作らない。`check_path` は `applies_to` の付いた constraint / debt だけを読む）
- 自動の覆し（後の PR が前の判断を覆したかは判定しない。覆すときは `/gleanery:trace` で残す）
- confidence（NULL のまま。書式どおりに取り出せたことは、理由の正しさの根拠にならない）
- コメント・レビューからの取り出し、本文を AI で読んで分類すること

## 方針

### 取り出し（純関数）

- 対象は、本文の message（`external_id = "body"`）の「## 採った案と棄却した案」の節の中の行だけ。コードブロックの中は読まない
- 行の書式: `- 採った: <案>。棄却: <案>（<理由>）、<案>（<理由>）`。「棄却:」の後ろは括弧の外の「、」で分け、各案の末尾の「（…）」を理由にする。「棄却:」が無い行は採った案だけの決定にする
- 行全体が書式に合わなければ飛ばし、飛ばした行数を同期の結果に出す（自由な文の古い PR は取り出さない）
- 取り出し規則の版の定数を content_hash に入れる（規則を変えたら次の同期で作り直す）

### 対象の PR

- merge した PR だけ（閉じただけ・開いているものは決まっていない）
- 本文の author が持ち主であるもの。持ち主は `person.is_self` の人に結んだ `person_identity`（`gleanery who --me`）。第三者の本文を「判断の記録」にしない
- 結んでいなければ判断を作らず、harvest の結果に案内を出す:「harvest で身元を登録 → `gleanery who --me <呼び名> <handle>` → もう一度 harvest」
- 本文が変わっていなくても、同期のたびに全部の merge 済み PR の対象資格を判定し直す（持ち主の紐付けを変えたら、以前の持ち主の本文から作った行が消える）

### knowledge の形

- 1 行を decision（`accepted`、body は採った案）と option（`chosen` 1 件、`rejected` n 件、reason に理由）にし、`decision_id` で結ぶ（trace と同じ形）
- heading は「PR #<番号>（<merge した日>）の判断」、occurred_at は merge した時刻、refs に PR の URL（`source_item.url` と一致）、source_item_id と conversation_id を持つ
- key は `github:<owner/repo>/pull/<番号>#<内容 hash の先頭 12 桁>-<出現番号>`。search.ts の出所の間引きが PR ごとになり、trace の ref（`<host>:<id>#<key>`）にも合うので `supersedes` で覆せる

### 再同期

- 残る行は更新し、消えた行だけ消す（`k:<id>` の参照を切らない。docs.ts と同じ）
- upsert は既にある行の `status` と `superseded_by_id` を書き換えない（本文・heading・reason・refs・occurred_at・content_hash だけ）。trace の覆し（superseded・was_chosen）は、本文が同じまま・規則の版を上げた後も残る
- 行を編集して key が変わった場合は、古い行を消し、新しい行を accepted で入れる（持ち主の言い直しとみなす）
- PR が消えたら source_item の cascade で消える

### issue のテンプレート（#73）

- 「不具合」「判断が要る論点」「見送った指摘（既存の deferred-finding.md）」の 3 本と `config.yml`（`blank_issues_enabled: true`。構想などの自由な issue は blank で書く）
- 見出しは少なくし、「埋めたらコメントは消す」の指示を残す（本文は DB に入り、定型が残ると検索を薄める）
- issue からは取り出さないので、「判断が要る論点」に「採った案と棄却した案」の節は持たせない（取り出されると誤解させない）

## 採った案と棄却した案

- 採った: 決まった書式の行だけを取り出す。棄却: 本文を生成 AI で読んで分類する（API を持たない）
- 採った: 持ち主は `person.is_self` に結んだ身元で判定する。棄却: 同期に使う `gh api user`（同期のアカウントが変わると判断が増減する）
- 採った: merge した PR だけ。棄却: 閉じた issue も入れる（終了理由を持っておらず、completed でも本文の案が承認されたとは言えない）
- 採った: 残る行は更新し、消えた行だけ消す。棄却: 同期のたびに作り直す（`k:<id>` の参照が切れる）
- 採った: 出所を PR ごとにする key。棄却: `github:<repo>#…`（検索の出所の間引きが同じリポジトリの全 PR を 1 つに束ねる）
- 採った: upsert で status を保つ。棄却: 取り出した状態で上書きする（trace で覆した判断が再同期で復活する）
- 採った: 目的を recall に絞る。棄却: check_path まで含める（ファイルに結ぶ書式と推測が要る）

## 手順

1. 作業ブランチを切り、この計画を最初の commit に入れる
2. issue のテンプレートと config.yml
3. 取り出しの純関数の test を書き（直す前に落ちる）、純関数を書く
4. github.ts の同期へ繋ぐ（ingest の接続、同じ transaction）。sql:reach・sql:live の到達を足す
5. `bun run verify`、review-shipping、Codex のレビュー → PR → release:plan に従って release

## 検証

- 純関数: 実例（#117・#118 の節）で採った案・棄却した案・理由が分かれる。括弧の中の「、」で分けない。自由な文の行とコードブロックは飛ばし、数える
- 同期（一時 DB）: 持ち主の merge 済み PR だけが入る。第三者の PR、merge していない PR は入らない。紐付けが無いと入らず案内が出る。紐付けを変えると以前の行が消える
- 再同期: 同じ本文では書き直さない（content_hash）。本文の行を編集すると古い行が消えて新しい行が入る。PR を消すと消える
- 覆し: trace で覆す → 同じ本文で再同期 → 規則の版を上げて再同期、のどちらでも superseded のまま。knowledge と avoid の結果が変わらない
- recall: avoid で棄却した案が、knowledge で採った決定が出る（MCP と CLI の search を別々に確かめる）

## リスク

- 書式の揺れ（全角・半角のコロン、句点の抜け）で取りこぼす。飛ばした行数を出して気付けるようにする
- merge 済みの PR の本文は、書き込み権限のある者が後から編集できる（持ち主だけのリポジトリなら持ち主）
- 過去の PR をまとめて取り込むと knowledge が増え、既存の検索の順位が変わる
- 本文を編集して key が変わると、trace で覆していた判断が accepted で入り直す
