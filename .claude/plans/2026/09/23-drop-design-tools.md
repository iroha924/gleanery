# 設計の道具を消し、gleanery init で DB を作る（PR 8）

- 日付: 2026-09-23
- Codex との議論: 3 往復（session `01a0cdf2-37b5-74e1-a715-205fe96b4152`）。重大な未解決点は 0
- 持ち主の判断: 設計の道具を機能ごと消し winnow も消す。schema から種類を外す（migration）。review は残す。`gleanery db init` を `gleanery init` に改める

## 目的

gleanery を「過去の判断を記録し、セッションへ注入する」ことに絞る。設計の道具は利用者が好みのものを使う。

## 対象外

- 残す: `trace`、`review`、MCP（`recall`・`read`・`check_path`）、自動記録、`harvest`、端末の画面、`gleanery db migrate`・`db reindex`
- 利用者のリポジトリに残った `.gleanery/` は触らない（release の文面で案内する）
- 既存の `message_file` の `read` の行は会話の履歴として残す（新しい記録だけ止める。schema の `read` は残す）

## 方針

- 消す: plugin Skill の `requirements`・`design`・`init`・`winnow`、`server/src/artifacts.ts`、トップレベルの `gleanery init`（`.gleanery/` を作る）と `gleanery check`、`docs.ts` の `.gleanery/` の特別扱い（`.gleanery/` は入れ子も含めて取り込まない）、`capture.ts` の成果物を読んだ記録、`sessions.ts` の成果物の結合、`knowledge.ts` の専用の札、`search.ts` の `（要件定義）`・`（設計書）` の表示、`server/evals/retrieval.json` の該当の期待値、各 test・検査・Skill・README の参照
- 改名: `gleanery db init` → `gleanery init`。旧名の別名は残さない。案内の文言（sqlite.ts・capture.ts・admin.ts・CI の Windows の job・check-sql-live.mjs・README・Skill）を全部直す
- schema: `source_item.kind` から `requirements`・`design` を外す。migration を 2 本に分け、revision 3 にする
  - `0002_drop_artifact_rows.sql`（外部キー on）: `delete from source_item where kind in ('requirements', 'design')`。子孫は既存の `on delete cascade`・`set null` と FTS の削除 trigger が片付ける
  - `0003_rebuild_source_item.sql`（先頭行 `-- gleanery: foreign_keys=off`）: 新しい CHECK の表を作り、残った行を写し、旧表を消して rename、index を作り直す。`sqlite_sequence` の値を temp 表へ控えて戻す。commit の前に `foreign_key_check`
  - `db/schema.sql` は `create table "source_item"` の形にし、`pragma user_version = 3`
- runner（`admin.ts` の `migrate`）:
  - 宣言の無い migration は、連続する分を 1 transaction で当てる。宣言した migration は単独の transaction で、transaction の外で `pragma foreign_keys = off` にし、直後に実値が 0 かを確かめ、`finally` で on に戻す
  - transaction ごとに、ロックを取った後に revision を読み直し、その transaction の中で `user_version` を確定する（0003 が落ちた DB は revision 2 で止まり、再実行できる）
  - 知らない `-- gleanery:` 宣言はエラーにする
- バージョン 0.37.0。release の文面に、消した command・Skill、migration、CLI の `gleanery init` と消した Skill `/gleanery:init` の違いを書く

## 採った案と棄却した案

- 採った: 成果物の行を外部キー on の 0002 で消し、0003 で表を作り直す。棄却: 外部キー off のまま子を手で消す（孫の行が残る。Codex の指摘）
- 採った: 外部キー off を宣言した migration だけに当てる。棄却: 全 migration で常に off（cascade・set null を使う migration の意味が変わる）
- 採った: `sqlite_sequence` を控えて戻す。棄却: 写すだけ（消した id が再び振られる。Codex がメモリ上で再現）
- 採った: schema から種類を外す（持ち主の判断）。棄却: 種類を残す（消した機能の値を DB が受け付け続ける）
- 採った: `.gleanery/` を取り込まない。棄却: 普通の Markdown として取り込む（承認していない下書きまで検索に出る）
- 採った: `review` を残す（持ち主の判断。precedent の観点が過去の判断を変更へ当てている）
- 採った: 計画ファイルを `.claude/plans/` に残す（持ち主が決めた手順）。棄却: 作らない（Codex の意見）

## 手順

1. 作業ブランチを切り、この計画ファイルを最初の commit に入れる
2. migration の test を直す前に書く（下の検証）
3. runner を変え、0002・0003 と schema.sql を書く
4. 機能と Skill を消し、`init` を改名し、参照を直す。段ごとに `bun run verify`
5. `bun run release:plan` → 0.37.0 → review-shipping・review-ui（表示が変わるので）・Codex のレビュー → PR → release

## 検証

- revision 1 の DB に、GitHub の PR・文書・requirements・design の source_item と、それぞれの子孫（conversation・message・message_file・knowledge・knowledge_file・work_item）を入れて migrate する
  - requirements・design の行と子孫だけが消え、ほかの件数は変わらない
  - `foreign_key_check` が空、revision 3、新しく `gleanery init` した DB と `sqlite_schema.sql` が文字列で一致する
  - 次の source_item の id が、移行前の `sqlite_sequence` の値より大きい（残る行が 0 件の場合も）
  - 消した行の語と rowid が全文検索に出ず、残した行が引ける
- runner: 0003 が落ちたら、同じ接続で rollback と `pragma foreign_keys` が 1 に戻ることを見る。revision 2 で止まり、再実行で 3 になる。知らない宣言はエラー。0003 に宣言がある
- CLI: `gleanery init` で DB ができ、`doctor` が全部 ✓。旧 `gleanery db init` と旧 `gleanery init --cwd` は拒まれる
- `bun run verify`、CI（Windows の job を含む）

## リスク

- 表の作り直しの migration が失敗すると DB を壊しうる。1 migration 1 transaction と `foreign_key_check`、実物の DB の test で抑える
- `gleanery init` の意味が変わる。古い README を見た利用者のために release の文面で分けて書く
