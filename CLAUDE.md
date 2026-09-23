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
- 配布物に入る変更は、npm と 3 つの plugin manifest のバージョンを同じ値へ上げ、同じ commit に入れる <!-- invariant: version-sync -->
- 外部入力は system 境界で検査する。資格情報を追跡ファイル・command 引数・log に書かない <!-- invariant: boundary-validation -->
- 配る物は Windows でも動かす。POSIX shell・`0600`・`/tmp` 固定・`.cmd` の execFile に依存しない <!-- invariant: windows -->

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

## review

`bun run verify` が通ってから渡す。

- `review-shipping`: 配布物・バージョン・bundle の入力・検査 script を変えた commit の前
- `review-ui`: `server/src/tui/` か `server/src/palette.ts` を変えた commit の前
- Codex: PR ごとに merge の前。`codex-review` Skill の手順で頼む

## 外へ出す文章

PR は `.github/pull_request_template.md`、issue は `.github/ISSUE_TEMPLATE/` に従い、埋まらない節を消す。 <!-- invariant: external-text -->
本文はそのまま DB に取り込まれて発言として引かれるので、確かめていない事実を書かない。
