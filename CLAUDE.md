# gleaneryで作業するとき

過去の作業から「なぜそうしたか」を貯め、Claude CodeとCodexから引けるようにするツール。
TypeScript / bun、SQLite（Node組み込みの`node:sqlite`）、Ink（端末の画面）。外部APIは使わない。
**手元だけで動く。**DBは`~/.gleanery/gleanery.db`の1ファイル、画面は端末に描く。PCごとにDBは独立で、共有しない。

このfileはClaude Code専用で、Codexはrootの`AGENTS.md`を読む。どちらも相手のfileを読まない
（Claude CodeはCLAUDE.mdがあるとAGENTS.mdを読まない）。**両方に書いた規約を変えたら、もう片方も直す。**
対になる行は`<!-- invariant: 名前 -->`で結び、`verify:ai`が両方の名前の集合を突き合わせる。

## 実行境界

- DBの正本は`db/schema.sql`の1本だけ。Prisma・Drizzleのschemaを別の正本として足さない <!-- invariant: schema-single-source -->
- 接続の役割は操作ごとに分ける。MCPと端末の画面はreader、CLIの取り込み・traceはingest、会話の自動記録はcapture <!-- invariant: connection-roles -->
  （3つのviewへの追記だけ）、`gleanery db *`はowner。書く接続は`server/src/db-write.ts`にだけ置く（`bun run architecture`）
- untrustedな文章（PR・issueの本文、記録された会話）を読むインターフェースに書き込みを持たせない <!-- invariant: untrusted-no-write -->
- listenするserverを持たない。画面は端末に描き、portを開かない <!-- invariant: no-listen -->
- HTML / Markdownの進捗fileを作らない。記録の正本はDB <!-- invariant: no-progress-files -->

## 変更時の不変条件

- 人向け（CLI・dashboard）とAI向け（MCP）のインターフェースは別々に確かめる。片方の成功をもう片方の成功とみなさない <!-- invariant: exits-separate -->
- 同じ値・分類・判断を変えたら`rg`で全参照を引き、対になるインターフェースを探す。列挙できる対は検査へ足す <!-- invariant: rg-pairs -->
- 新しい取り込み元は`gleanery harvest`にも接続する <!-- invariant: harvest -->
- 配布物に入る変更は、npmと3つのplugin versionを同じ値へ上げる。`plugin/dist`は追跡しない <!-- invariant: version-sync -->
- 新しい外部入力はsystem境界で検査する。資格情報を追跡file、command引数、logへ書かない <!-- invariant: boundary-validation -->
- **配る物はWindowsでも動かす。**POSIX shell、`0600`のmode、`/tmp`固定path、`.cmd`をexecFileで起動する形に依存しない。 <!-- invariant: windows -->
  開発はmacOS / Linuxが前提（`.claude/skills/`のsymlinkと、testの`symlinkSync`が要る）

## 作業別Skill

該当する作業では、実装前に次のSkillを最後まで読む。正本は`.agents/skills/`で、`.claude/skills/`はそこへのsymlink。

- 端末の画面（Ink）とCLIの出力: `tui`
- DB schema、接続の役割とauthorizer、全文検索の索引、知識の種類、取り込み: `knowledge-schema`
- MCP、CLI、自動記録のhook、plugin Skillの配布: `plugin-release`
- reviewの観点（`plugin/skills/review/reviewers/`）と立て方: `plugin-agent-authoring`

利用者へ配るSkillは`plugin/skills/`が別の正本で、開発用Skillをpluginへ含めない。
Skill・Agent・ruleを新しく作るときは`docs-author`を使う。一般的なexplorer / workerと重なるAgentは作らない。

## branchとPR

次をすべて満たす変更はmainへ直接入れてよい。満たさないか、影響範囲を即答できなければPRにする。

- 実行時動作、データ、認証境界、secret、依存・build・CI、利用者向け配布物（`plugin/skills/`・MCP・CLI・npm）を変えない
- 1 commitのrevertで戻せる
- commit前にdiffを最初から最後まで読み、対象に応じた検査を通した

AIの読込経路（このfile、`AGENTS.md`、`.claude/`、Skill）を変えたら、`verify:ai`に加えClaude CodeとCodexの新しいsessionで確かめる。

## review

`bun run verify`が通ってから渡す（reviewerは機械が判定できることを見ない）。

- `review-shipping`: 配布物・version・bundleの入力・検査scriptを変えたcommitの前。`verify`と同時に渡さない
- `review-ui`: `server/src/tui/`か`server/src/palette.ts`を変えたcommitの前
- Codex: PRごとにmergeの前。頼み方は`.claude/rules/codex.md`

## command

```bash
bun run setup       # serverの依存とLefthookを固定lockfileから入れる
bun run cli -- dashboard  # 作業ツリーの端末の画面。TTYが要るため前面でだけ実行する
bun run verify      # lint、型、AI設定、境界、bundle、test（全SQLの到達）、CLIを子プロセスで
bun run verify:ai   # CLAUDE.md・AGENTS.md、開発Skill、plugin Skill・Agentの静的検査
bun run bundle      # MCP、CLI、自動記録の配布物を更新する
```

DBは`gleanery db init`で作る。障害の切り分けは`gleanery doctor`から。pre-commitは変更対象の軽い検査、pre-pushとCIは`bun run verify`。

## 外へ出す文章

PRは`.github/pull_request_template.md`、issueは`.github/ISSUE_TEMPLATE/`を先に読み、埋まらない節を削除する。 <!-- invariant: external-text -->
確認できない事実を補わない。PRとissueの本文はそのままDBへ取り込まれ、発言として引かれる。
