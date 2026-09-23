# gleaneryで作業するとき

過去の作業から「なぜそうしたか」を貯め、Claude CodeとCodexから引けるようにする道具。
TypeScript / bun、SQLite（Node組み込みの`node:sqlite`）、Ink（端末の画面）を使う。外部APIは使わない。
**手元だけで動く。**DBは`~/.gleanery/gleanery.db`の1ファイル、画面は端末に描く。PCごとにDBは独立で、共有しない。

Claude Codeはrootの`CLAUDE.md`からこのfileをimportする。両AIに共通する常時規約はここだけを正本にし、
gleanery自身の開発手順は`.agents/skills/`へ置く。`.claude/skills/`は同じSkillへのsymlinkである。
利用者へ配るSkillは`plugin/skills/`が別の正本であり、開発用Skillをpluginへ含めない。

## 実行境界

- DBの正本は`db/schema.sql`の1本だけ。Prisma・Drizzleのschemaを別の正本として足さない
- 接続の役割は操作ごとに分ける。MCPと端末の画面はreader（読むだけ。`server/src/sqlite.ts`）、CLIの取り込み・traceはingest、
  会話の自動記録はcapture（3つのviewへの追記だけ）、ownerはDBを管理するcommand（`gleanery db *`）だけが使う。
  書く接続は`server/src/db-write.ts`にだけ置き、読む出口から届かないことを`bun run architecture`が見る
- untrustedな文章（PR・issueの本文、記録された会話）を読む出口に書き込みを持たせない。
  端末の画面はreaderだけを持ち、取り込みを起動する経路を持たない
- **listenするserverを持たない。**画面は端末に描き、portを開かない
- HTML / Markdownの進捗fileを作らない。記録の正本はDB、セッションの表示は`gleanery dashboard`

## 変更時の不変条件

- 人向けとAI向けの出口は別々に動かす。CLIやdashboardの成功をMCP応答の成功とみなさない
- 同じ値・分類・判断を変更したら`rg`で全参照を引き、対になる出口を探す。列挙できる対は検査へ足す
- 新しい取り込み元は`gleanery harvest`にも接続する。手動commandだけを追加して完了にしない
- 配布物に入る変更は、npmと3つのplugin versionを同じ値へ上げる。`plugin/dist`は追跡しない
- 新しい外部入力はsystem境界で検査する。資格情報を追跡file、command引数、logへ書かない
- **配る物はWindowsでも動かす。**POSIX shell、`0600`のmode、`/tmp`固定path、`.cmd`をexecFileで起動する形に
  依存しない。**このrepositoryでの開発はmacOS / Linuxを前提にする** — `.claude/skills/`の4本のsymlinkと、
  `artifacts.test.ts` / `docs.test.ts`の`symlinkSync`が要る

## 作業別Skill

該当する作業では、実装前に次のSkillを最後まで読む。

- 端末の画面（Ink）とCLIの出力: `tui`
- DB schema、接続の役割とauthorizer、語彙索引、知識の種類、取り込み: `knowledge-schema`
- MCP、CLI、自動記録のhook、plugin Skillの配布: `plugin-release`
- reviewの観点（`plugin/skills/review/reviewers/`）と立て方: `plugin-agent-authoring`

Skill・Agent・rule自体を新規作成するときは、Claude Codeでは既存の`docs-author`、Codexでは組み込みの
`skill-creator`を使う。一般的なexplorer / workerと重なるrepo Agentは作らず、独立contextや固定modelが
結果を変える専門検査だけをAgentにする。

## branchとPR

PRの要否はfile数ではなく影響面で決める。次をすべて満たす変更はmainへ直接入れてよい。

- 実行時動作、データ、認証境界、secret、build、利用者向け配布物を変えない
- 1 commitのrevertで戻せる
- commit前にdiffを最初から最後まで読み、対象に応じた検査を通した

例は文書、repository開発用の`.agents/skills/`・`.claude/`、test・evalの追加、意図した実行時動作を
変えない内部整理である。AIの読込経路を変えた場合は`verify:ai`に加えClaude CodeとCodexの新しい
sessionで確認する。

端末の画面の実行時動作、DB schema・権限・データ変換、認証境界・secret、依存・build・CI、
`plugin/skills/`・MCP・CLI・npm配布物を変える場合はPRを使う。
影響範囲を即答できない変更もPRへ寄せる。

repository専用のreviewerが2体ある（Claude Codeのみ、`.claude/agents/`）。**機械が判定できることは
見ない**ので、`bun run verify`が通ってから渡す。担当は各定義にある。

- `review-shipping`: 配布物・version・bundleの入力・検査scriptを変えたcommitの前。`verify`と同時に渡さない
- `review-ui`: `server/src/tui/`か`server/src/palette.ts`を変えたcommitの前

**Codex側に同じreviewerを置かない**（意図した非対称）。定義を二重に持つと基準が2箇所で古くなるので、
Codexへは`codex-talk`で差分の場所と受け入れ条件を渡す。

Codexがこのrepository自身をreviewするときは、導入済みcacheではなくcheckoutの
`plugin/skills/review/SKILL.md`を読む。cacheは最後に公開した版で、作業中のSkill変更を含まない。
Skill一覧の場所が`rN/...`なら、`Skill roots`にある`rN`の値と残りをそのまま結合する。
marketplace名やplugin名が重なって見えても、pathの一部を推測で省かない。

## 最小command索引

```bash
bun run setup       # serverの依存とLefthookを固定lockfileから入れる
bun run cli -- dashboard  # 作業ツリーの端末の画面。TTYが要るため前面でだけ実行する
bun run verify      # lint、型、AI設定、境界、bundle、test（全SQLの到達）、CLIを子プロセスで
bun run verify:ai   # AGENTS、repository開発Skill、plugin Skill・Agentの静的検査
bun run bundle      # MCP、CLI、自動記録の配布物を更新する
```

DBは`gleanery db init`で作る。個別command、setup、運用は
READMEを読み、障害の切り分けは`gleanery doctor`から始める。pre-commitは変更対象の軽い検査、
pre-pushとCIは`bun run verify`を実行する。

## 外へ出す文章

PRは`.github/pull_request_template.md`、issueは`.github/ISSUE_TEMPLATE/`を先に読み、埋まらない節を
削除する。確認できない事実を補わない。PRとissueの本文はそのままDBへ取り込まれ、発言として引かれる。

## 参照先

- `README.md`: 全体像、setup、全command、新しいPC
- `plugin/skills/trace/SKILL.md`: 判断を記録する契約
- `server/src/capture.ts`: 会話を自動記録する範囲（持ち主の判定、残すものと残さないもの）
- `plugin/skills/review/SKILL.md`: reviewの実行と担当分け
