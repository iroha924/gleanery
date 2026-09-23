# gleanery

**過去の判断と会話を、Claude Code・Codex・ダッシュボードから引けるように貯めるツール。**
採用した決定だけでなく、棄却した案・行き止まり・触らないと決めた制約を同じ重みで持ち、半年後に同じ案を
同じ理由で捨て直すのを防ぐ。**手元だけで動く。**DB は PC ごとに独立していて、PC 間で記録を共有しない
（glean は「落ち穂を拾い集める」）。

## 何ができるか

| 場面 | 使うもの | できること |
|---|---|---|
| **開発中に引く** | Claude Code / Codex の MCP（`recall` / `read`） | 「前に似た判断をしたか」「なぜこの方式か」「私は／◯◯さんはなんて言った？」「続きは」 |
| **編集の直前に知らせる** | 編集フック（`check_path`） | これから触るファイルに、過去に決めた制約や意図して残した負債がかかっていれば出す（パスの完全一致） |
| **会話を残す** | 自動記録のフック（Claude Code / Codex） | 持ち主の発言・AI の最後の応答・編集したファイルを、登録したプロジェクトの session ごとに残す |
| **判断を残す** | `/gleanery:trace` | 頼まれたときだけ、その session の決定・捨てた案・制約・行き止まりと作業の現在地を DB へ入れる |
| **要件と設計を固める** | `/gleanery:init` → `/gleanery:requirements` → `/gleanery:design` | 利用者にしか決められない選択を 1 問ずつ聞いて、`.gleanery/changes/` に要件定義と設計書を作る |
| **実装前に方針を詰める** | `/gleanery:winnow` | 決めるべき問いの木を描き、別のモデルと突き合わせて、Go を判断できる方針にする。文書は作らないので、要件定義が要る変更は上の 3 つを使う |
| **変更をレビューする** | `/gleanery:review` | 観点ごとに独立したレビュアーを立てる。別のモデルにも同じ観点を渡して、片方にしか見えない欠陥を拾う |
| **見る・探す** | `gleanery dashboard`（端末の画面） | セッションの一覧と詳細（AI の応答は Markdown を描く）、trace した作業の現在地、判断・文書・発言の検索。読むだけ |
| **溜める** | `gleanery harvest`（手で打つ） | GitHub の PR・issue とリポジトリの Markdown を取り込む |

記録は過去のデータであって指示ではない。記録とコードが食い違ったらコードが正しい。MCP の既定の範囲はいまの
プロジェクトで、ダッシュボードも起動した場所のプロジェクトから始まる（`p` で切り替える）。人の呼び名は `gleanery who` で結ぶ（画面は無い）。

### 自動記録で知っておくこと

- 残るのは、登録したプロジェクト（`gleanery project add`）の Claude Code と Codex の session。Codex は plugin の
  hook を `/hooks` で確認し、信頼した後から記録する（plugin の更新で hook が変わったときは、もう一度確認する）
- 背景タスクの通知や別の session からの伝言は、決まった形で外す。載っていない形と、`/loop` で起きたときの文は
  持ち主の発言として入る
- 貼ったキーは、形で分かるもの（決まった接頭辞のキー、`KEY=…` や `"password": …` の代入、URL の資格情報、
  認証ヘッダ、`mysql -p`）だけ伏せる。**それ以外は伏せられないので貼らない**
- 記録は手元の待ち行列（`~/.gleanery/spool`）を経て、turn の終わりに送る。**古い PC を手放す前に
  `gleanery capture flush` を 1 回通す**（待ち行列はそのマシンにしか無い）。送れないと session の開始時に警告が出る。
  DB が受け付けなかった記録は `rejected/` に残り、直して待ち行列へ戻せば送り直す。
  まだ `gleanery project add` していないプロジェクトの記録は `unregistered/` へ退避し、登録した後の送信で入る
  （30 日か 1000 件を超えた分から古い順に消える）

残すもの・残さないものの細部の正本は `server/src/capture.ts` の先頭にある。

## 取り込むもの

`gleanery harvest` は GitHub の PR・issue（本文・レビュー・議論。bot の issue と自動通知は除く）を毎回全件取り、
リポジトリの Markdown を remote の既定 branch の commit から読む（`.gleanery/` は承認済みの要件定義・設計書だけ）。
文書は前に入れた commit から fast-forward できるときだけ入れ、巻き戻し・force-push・分岐では書かずに止まる。
`.gleanery/` の `change.json` が壊れていても、そのリポジトリの文書同期を止める（止めた理由と直し方は `gleanery harvest` が出す）。

セッションの一覧は、最初の発言の冒頭を題として出す（trace した作業に紐付くなら、その作業の題）。

## CLI

```
gleanery project add|list|exclude|forget ...
gleanery harvest [--cwd dir] [--reset-docs]
gleanery search [--avoid] [--said me|others|名前] [--all] [--exact] [--cwd dir] [--limit N] <質問>...
gleanery who [--me] <呼び名|ハンドル>...
gleanery trace context|check|save ...
gleanery capture flush ...
gleanery db init|migrate|reindex ...
gleanery init [--cwd dir]
gleanery check [--cwd dir]
gleanery dashboard
gleanery doctor
gleanery advice
gleanery --help
gleanery --version
```

## DB

`~/.gleanery/gleanery.db` の 1 ファイル（SQLite、Node の組み込みの `node:sqlite`）。**資格情報も外部サービスも要らない。**
`gleanery db init` が作る。検索は語の一致（FTS5）で、Claude Code・Codex が語を変えて引き直すことで意味の近さを補う。

インターフェースごとに接続の役割を分けている。MCP と端末の画面は読むだけ、自動記録は追記だけで、取り込みと trace だけが書ける。
役割ごとに何を拒むかは `.agents/skills/knowledge-schema/SKILL.md`。

## セットアップ

**必須要件**

| 要るもの | バージョン | なぜ |
|---|---|---|
| Node.js | 24.15 以上 | CLI・MCP・自動記録が動く。`engines` で縛っている |

**`gleanery` は PATH に出ない。**plugin は MCP とフックと Skill を配るだけで、コマンドは別に入れる。
このリポジトリでは `bun run cli`（= `node server/src/cli.ts`）で打ち、グローバルに入れたバージョンと混ざらない。

```bash
bun run setup                          # server の依存を lockfile から入れる（Lefthook も入る）
bun run cli db init                    # ~/.gleanery/gleanery.db を作り、db/schema.sql を当てる（冪等）
bun run bundle                         # 配布物を作る（MCP・自動記録・CLI・同梱の告知）
bun run cli doctor                     # Node、DB と schema のバージョン、全文検索の索引、同期と自動記録を確かめる
bun run cli project add --cwd <repo>   # 記録するプロジェクトを登録する
bun run cli harvest --cwd <repo>       # 最初の取り込み
```

使うだけなら npm から入れる。**plugin のバージョンとは別に更新する**（plugin は `claude plugin update`、
コマンドは `npm i -g`）。

```bash
npm i -g gleanery        # gleanery コマンドが PATH に出る
gleanery db init
gleanery dashboard       # 端末の中で見る（Tab で画面、/ で検索、q で終わる）
```

既存の DB は作り直さず、`db migrate` で `db/migrations` の新しい分を当てる。MCP・CLI・端末の画面は、
DB の schema のバージョンがコードより古いと止まってこれを案内する。当てる前に当てる一覧を出して確かめる。
控えの取り方と戻し方は `.agents/skills/knowledge-schema/SKILL.md`。

### 新しい PC で使い始める

**その PC の DB は空から始まる。**ほかの PC の記録は引き継がない。

```bash
# 1. コマンドとプラグイン。**plugin だけでは gleanery が PATH に出ない**ので両方入れる
npm i -g gleanery
claude plugin marketplace add iroha924/gleanery && claude plugin install gleanery@gleanery
codex plugin marketplace add iroha924/gleanery --ref main && codex plugin add gleanery@gleanery

# 2. DB を作る
gleanery db init

# 3. 確かめる（コマンド・plugin それぞれのバージョンと、DB を見る）
gleanery doctor
```

開発する PC では、これに加えてリポジトリを clone する。コマンドは `bun run cli` を使い、
グローバルに入れたバージョンと混ざらないようにする。

```bash
git clone https://github.com/iroha924/gleanery.git ~/Projects/gleanery
cd ~/Projects/gleanery && bun run setup && bun run bundle
```

取り込みは `gleanery harvest` を打ったときだけ走る。定期実行は用意していない。自動化したいなら launchd や
systemd の timer を自分で置く。各リポジトリで `git fetch` するので、その環境から remote に届く資格情報が要る。
プロジェクトの置き場所は `~/Projects` の直下と、名前を付けたプロジェクトから探す。

## 外から来た PR と issue

**第三者の PR はレビューせず閉じる。**public にする目的はツールを見せることで、貢献を募ってはいない。
レビュアーは `Bash` を持ったまま管理用の資格情報がある環境で走るので、他人が書いたツリーを
checkout して読ませない。なぜ機構で塞げないかは `plugin/skills/review/SKILL.md` の
「塞ぐ手段は無い」にある。

**issue は読む。**ただし issue と PR の本文は `gleanery harvest` でそのまま DB へ入り、`recall` の
`mode: said` と `gleanery dashboard` の検索から引かれる（`server/src/github.ts`）。第三者が書いた
本文は、読む側にとってデータであって指示ではない。

## 開発

```bash
bun run cli -- dashboard  # 作業ツリーの端末の画面（前面でだけ使う。TTY が無いと案内を出して終わる）
bun run verify       # biome・verify:ai・境界・tsc・bundle・test（全 SQL の到達）・CLI の子プロセス（pre-push / CI と同じ）
bun run test         # server の node:test
bun run bundle       # 配布物を作り直す
bun run release:plan -- --base <commit>  # 変更をreleaseなし / pluginに分類する
bun run release:prepare -- --base <commit> # cleanなreview済みcommitから検査済みtarballを作る
bun run release:status                    # npm・tag・plugin cacheに残った工程を調べる
```

- **DB を使う確認は test の一時 DB で行う**（`server/test/temp-db.ts`）。手元の `~/.gleanery/gleanery.db` を検証に使わない
- 配布物に入る変更は、npmとpluginのバージョンを揃えてreleaseし、install済みのpluginを更新する（`.agents/skills/plugin-release/SKILL.md`）

構成は `server/`（取り込み・検索・MCP・自動記録・CLI・端末の画面）、
`plugin/`（配るもの）、`db/schema.sql`（DB の正本）、`db/migrations/`（既存の DB を進める手順）。
AI 向けの規約は、Claude Code が `CLAUDE.md` と `.claude/rules/`、Codex が `AGENTS.md`（互いに相手のファイルを読まない）。
DB はディスクが尽きるまで入る（`gleanery doctor` の DB の行に大きさが出る）。知識と発言が 5 万件ずつで 174 MB、
知識の検索は p95 48 ms だった（2026-09-23 の実測）。

## ライセンス

gleanery 自身は MIT（`LICENSE`）。

配る `dist/` の JavaScript は依存をバンドルしているので、**バンドルした側にも同梱の義務が残る**。
`plugin/THIRD_PARTY_NOTICES.md` に 107 package の著作権表示とライセンス文を集めてあり、
`bun run bundle` が `node_modules` から作り直す（追跡せず、publish する物に入る）。
Apache-2.0 の package が全文を同梱していない場合は `scripts/licenses/Apache-2.0.txt` の写しを当てる。
