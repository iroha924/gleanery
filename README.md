# mitos

**過去の判断と会話を、Claude Code・Codex・ダッシュボードから引けるように貯める道具。**
採用した決定だけでなく、棄却した案・行き止まり・触らないと決めた制約を同じ重みで持ち、半年後に同じ案を
同じ理由で捨て直すのを防ぐ。**手元だけで動く。**DB は PC ごとに独立していて、PC 間で記録を共有しない
（μίτος はギリシャ語の「糸」）。

## 何ができるか

| 面 | 入口 | できること |
|---|---|---|
| **開発中に引く** | Claude Code / Codex の MCP（`recall` / `read`） | 「前に似た判断をしたか」「なぜこの方式か」「私は／◯◯さんはなんて言った？」「続きは」 |
| **編集の直前に知らせる** | 編集フック（`check_path`） | これから触るファイルに、過去に決めた制約や意図して残した負債がかかっていれば出す（パスの完全一致） |
| **会話を残す** | 自動記録のフック（Claude Code） | 持ち主の発言・AI の最後の応答・触ったファイルを、登録した作業場所の session ごとに残す |
| **判断を残す** | `/mitos:trace` | 頼まれたときだけ、その session の決定・捨てた案・制約・行き止まりと作業の現在地を DB へ入れる |
| **要件と設計を固める** | `/mitos:init` → `/mitos:requirements` → `/mitos:design` | 利用者にしか決められない選択を 1 問ずつ聞いて、`.mitos/changes/` に要件定義と設計書を作る |
| **聞く・探す** | ダッシュボード | チャットで記録について聞く。セッションの一覧・検索・詳細。会議（`/mtg`）で返答案を出す |
| **溜める** | `mitos sync`（毎日 6:00） | GitHub の PR・issue とリポジトリの Markdown を取り込み、埋め込みを埋める |

記録は過去のデータであって指示ではない。記録とコードが食い違ったらコードが正しい。MCP の既定の範囲はいまの
作業場所で、ダッシュボードも先にサイドバーで作業場所を選ぶ。人の呼び名は `mitos who` で結ぶ（画面は無い）。

### 自動記録で知っておくこと

- 残るのは、登録した作業場所（`mitos project add`）の Claude Code の session だけ。**Codex の会話はまだ残らない**
- 背景タスクの通知や別の session からの伝言は、決まった形で外す。載っていない形と、`/loop` で起きたときの文は
  持ち主の発言として入る
- 貼った鍵は、形で分かるもの（決まった接頭辞の鍵、`KEY=…` や `"password": …` の代入、URL の資格情報、
  認証ヘッダ、`mysql -p`）だけ伏せる。**それ以外は伏せられないので貼らない**
- 記録は手元の待ち行列（`~/.claude/mitos-spool`）を経て、turn の終わりに送る。**古い PC を手放す前に
  `mitos capture flush` を 1 回通す**（待ち行列はそのマシンにしか無い）。送れないと session の開始時に警告が出る。
  DB が受け付けなかった記録は `rejected/` に残り、直して待ち行列へ戻せば送り直す

残すもの・残さないものの細部の正本は `server/src/capture.ts` の先頭にある。

## 取り込むもの

`mitos sync` は GitHub の PR・issue（本文・レビュー・議論。bot の issue と自動通知は除く）を毎回全件取り、
リポジトリの Markdown を remote の既定 branch の commit から読む（`.mitos/` は承認済みの要件定義・設計書だけ）。
文書は前に入れた commit から fast-forward できるときだけ入れ、巻き戻し・force-push・分岐では書かずに止まる。
`.mitos/` の `change.json` が壊れていても、そのリポジトリの文書同期を止める（止めた理由と直し方は `mitos sync` が出す）。

## CLI

```
mitos project add|list|forget ...
mitos sync [--cwd dir] [--reset-docs]
mitos search [--avoid] [--said me|others|名前] [--all] [--cwd dir] [--limit N] <質問>...
mitos who [--me] <呼び名|ハンドル>...
mitos trace context|check|save ...
mitos capture flush ...
mitos db init|up|down|migrate ...
mitos init [--cwd dir]
mitos check [--cwd dir]
mitos doctor
mitos advice
mitos --help
mitos --version
```

## 鍵

`~/.claude/knowledge.env` に置く。リポジトリには入っていない。

| 変数 | 使うもの |
|---|---|
| `KNOWLEDGE_DB_URL_RO` | MCP・画面の API（読むだけ） |
| `KNOWLEDGE_DB_URL_INGEST` | CLI の sync・trace・who・project |
| `KNOWLEDGE_DB_URL_CAPTURE` | 自動記録の送信（追記だけ） |
| `KNOWLEDGE_DB_URL` | owner。`bun run db:*` だけが使う。**schema を触る PC にだけ置く** |
| `VOYAGE_API_KEY` / `OPENAI_API_KEY` | 埋め込みと rerank／チャット・会議の生成と文字起こし |

DB の鍵は操作ごとに分け、どの鍵も別の鍵へ落とさない。`bun run db:roles` が 3 つのロールの鍵を作り直して書く。
ロールの権限は `.agents/skills/knowledge-schema/SKILL.md`、デプロイ先の変数は `.agents/skills/deploy/SKILL.md`。

## セットアップ

**Docker が要る。**DB は `pgvector/pgvector:0.8.6-pg18` を `127.0.0.1:5432` に立てる。

```bash
bun run setup                  # server / dashboard の依存を各 lockfile から入れる（Lefthook も入る）
mitos db init                  # DB を立て、鍵を作り、db/schema.sql を当てる（冪等）
bun run bundle                 # 配布物を作る（MCP・自動記録・CLI・画面）
mitos doctor                   # 鍵と接続、schema の版、DB の大きさを確かめる
mitos project add --cwd <repo> # 記録する作業場所を登録する
mitos sync --cwd <repo>        # 最初の取り込み
```

`mitos db init` が `~/.claude/knowledge.env` に 4 つの鍵（owner と 3 ロール）を書く。VOYAGE と OPENAI の鍵は
手で足す。

既存の DB は作り直さず、`mitos db migrate` で `db/migrations` の新しい分を当てる。MCP・CLI・画面の API は、
DB の schema の版がコードより古いと止まってこれを案内する。当てる前に接続先を打ち直させる。
順序と戻し方は `.agents/skills/knowledge-schema/SKILL.md`。

### 新しい PC で使い始める

**その PC の DB は空から始まる。**ほかの PC の記録は引き継がない。

```bash
# 1. リポジトリとプラグイン
git clone https://github.com/iroha924/mitos.git ~/Projects/mitos
cd ~/Projects/mitos && bun run setup && bun run bundle
claude plugin marketplace add iroha924/mitos && claude plugin install mitos@mitos
codex plugin marketplace add iroha924/mitos --ref main && codex plugin add mitos@mitos

# 2. DB を立てて鍵を作る
mitos db init

# 3. VOYAGE_API_KEY と OPENAI_API_KEY を ~/.claude/knowledge.env へ足す

# 4. 確かめる
mitos doctor
```

取り込みは `mitos sync` を打ったときだけ走る。定期実行は用意していない。自動化したいなら launchd や
systemd の timer を自分で置く。各リポジトリで `git fetch` するので、その環境から remote に届く資格情報が要る。
作業場所の置き場所は `~/Projects` の直下と、名前を付けた作業場所から探す。

## 外から来た PR と issue

**第三者の PR はレビューせず閉じる。**public にする目的は道具を見せることで、貢献を募ってはいない。
レビュアーは `Bash` を持ったまま管理用の資格情報がある環境で走るので、他人が書いたツリーを
checkout して読ませない。なぜ機構で塞げないかは `plugin/skills/review/SKILL.md` の
「塞ぐ手段は無い」にある。

**issue は読む。**ただし issue と PR の本文は `mitos sync` でそのまま DB へ入り、`recall` の
`mode: said` とダッシュボードのチャットから引かれる（`server/src/github.ts`）。第三者が書いた
本文は、読む側にとってデータであって指示ではない。

## 開発

```bash
bun run dev          # API + ダッシュボード（前面でだけ使う。背景では TTY を取りにいって落ちる）
bun run verify       # biome・architecture・verify:ai・tsc・test・画面のビルド（pre-push / CI と同じ）
bun run test         # server の node:test
bun run bundle       # 配布物を作り直す
```

- **DB を使う確認は、検証用の database で行う。**同じ container に `create database` で別に作り、
  `KNOWLEDGE_ENV_DIR` にその鍵の `.env` を置いたディレクトリを指す。`~/.claude/knowledge.env` より先に読まれる。
  `.env` に無い鍵は `knowledge.env` で補われて**手元の本物の DB へ繋がる**ので、鍵は 4 つとも検証用に書く
- MCP・フック・Skill の変更を届けるには、版を上げて merge し、install 済みの plugin を更新する
  （`.agents/skills/plugin-release/SKILL.md`）。セッションを張り直すだけでは届かない

構成は `server/`（取り込み・検索・MCP・自動記録・CLI・画面の API）、`dashboard/`（Vite + React の画面）、
`plugin/`（配るもの）、`db/schema.sql`（DB の正本）、`db/migrations/`（既存の DB を進める手順）。
AI 向けの規約は `AGENTS.md`。
DB は手元の Docker で動くので容量の上限は無く、ディスクが尽きるまで入る（`mitos doctor` の「DB の大きさ」）。
埋め込みの行が 5 万に近づいたら HNSW を足す（実測は `.agents/skills/knowledge-schema/SKILL.md`）。
