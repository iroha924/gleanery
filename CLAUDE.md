<!--
保守者向け。Claude Code は CLAUDE.md があると AGENTS.md を読まず、Codex は CLAUDE.md を読まない。
両方に写した規則は行末の invariant で結ぶ。変えたら AGENTS.md の同じ名前の行も直す（verify:ai が名前の集合を突き合わせる）。
-->

# gleanery

## command

```bash
bun run setup             # 依存と Lefthook を固定 lockfile から入れる
bun run verify            # lint・型・AI 設定・境界・bundle・test・SQL の到達・CLI の子プロセス。pre-push と CI も同じ
bun run verify:ai         # CLAUDE.md・AGENTS.md・Skill・Agent の静的検査
bun run bundle            # MCP・CLI・自動記録の配布物を作る
bun run cli -- dashboard  # 端末の画面。TTY が要るので前面でだけ動かす
```

障害の切り分けは `gleanery doctor` から始める。

## 実行境界

- DB の正本は `db/schema.sql` だけ。ORM の schema を別の正本として足さない <!-- invariant: schema-single-source -->
- MCP と端末の画面は reader、取り込みと trace は ingest、自動記録は capture、`gleanery db *` は owner の接続を使う。 <!-- invariant: connection-roles -->
  書く接続は `server/src/db-write.ts` にだけ置く（`bun run architecture` が見る）
- untrusted な文章（PR・issue の本文、記録された会話）を読むインターフェースに書き込みを持たせない <!-- invariant: untrusted-no-write -->
- listen する server を持たない <!-- invariant: no-listen -->
- HTML / Markdown の進捗ファイルを作らない。記録の正本は DB <!-- invariant: no-progress-files -->

## 変更するとき

- CLI・dashboard と MCP は別々に確かめる。片方の成功はもう片方の成功ではない <!-- invariant: exits-separate -->
- 値・分類・判断を変えたら `rg` で全参照を引き、対になるインターフェースも直す。列挙できる対は検査へ足す <!-- invariant: rg-pairs -->
- 新しい取り込み元は `gleanery harvest` にも繋ぐ <!-- invariant: harvest -->
- 配布物に入る変更は、npm と 3 つの plugin manifest のバージョンを同じ値へ上げ、同じ branch（PR）に入れる <!-- invariant: version-sync -->
- 外部入力は system 境界で検査する。資格情報を追跡ファイル・command 引数・log に書かない <!-- invariant: boundary-validation -->
- 配る物は Windows でも動かす。POSIX shell・`0600`・`/tmp` 固定・`.cmd` の execFile に依存しない <!-- invariant: windows -->
- 新しく書く・変えるコードの文字列とコメント、commit message は英語で書く。既存の日本語の文言は段ごとの範囲で英語へ直し、利用者が保存した記録は訳さない（`bun run english` が英語だけのファイルを見る） <!-- invariant: english-code -->

## 作業別の Skill

実装の前に最後まで読む。

- 端末の画面と CLI の出力: `tui`
- DB schema・接続の役割・全文検索の索引・取り込み: `knowledge-schema`
- MCP・CLI・自動記録の hook・plugin の配布: `plugin-release`
- 配る review の観点: `plugin-agent-authoring`
- Skill・Agent・rule を新しく作る: `docs-author`

## branch と PR

実行時の動作・データ・認証・secret・依存・build・CI・配布物のどれも変えず、1 commit の revert で戻せる変更だけを main へ直接入れる。
それ以外と、影響範囲を即答できない変更は PR にする。

## 実装の前

挙動を変える変更は、実装の前に `grill-codex` Skill で Codex と計画を詰め、`.claude/plans/` の計画で持ち主の Go を取る。
計画は合意した時点の実装計画の記録で、進捗ファイルではない（進捗は書き足さない）。

## review

`bun run verify` が通ってから渡す。

- `review-shipping`: 配布物・バージョン・bundle の入力・検査 script を変えた commit の前
- `review-ui`: `server/src/tui/` か `server/src/palette.ts` を変えた commit の前
- Codex: PR ごとに merge の前。`codex-review` Skill の手順で頼む
- GitHub の Codex（ChatGPT connector）は PR を作ると自動でレビューする。監視と再レビューの判断は Claude が持ち、持ち主は仕上がった PR だけを見る。
  状態の正本は要約コメント（Codex Review Summary）の表で、head の commit の Code Review が Completed なら終わり（PR 本文の 👀 は実行中、
  👍 は全部が指摘なしで終わった印）。指摘は未解決のレビューのスレッドで、直すか見送るかを決めて resolve する。直したら push が remote に
  届いたのを確かめてから `@codex review` とコメントする。指摘が端のケースに収束したら打ち切り、残りは見送った指摘の issue に残す。
  head の Code Review が Completed・未解決のスレッドが 0・CI が全部通過、がそろってから持ち主に最終判断を頼む

## 外へ出す文章

PR は `.github/pull_request_template.md`、issue は `.github/ISSUE_TEMPLATE/` に従い、埋まらない節を消す。 <!-- invariant: external-text -->
本文はそのまま DB に取り込まれて発言として引かれるので、確かめていない事実を書かない。
