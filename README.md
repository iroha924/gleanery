# mitos

**過去の判断と会話を、Claude Code・Codex・ダッシュボードから引けるように貯める道具。**
採用した決定だけでなく、棄却した案・行き止まり・触らないと決めた制約を同じ重みで持ち、半年後に同じ案を
同じ理由で捨て直すのを防ぐ。持ち主 1 人が、どの PC からでも同じ記録を引く（μίτος はギリシャ語の「糸」）。

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
mitos project add [--cwd <dir>] [--name <名前>]  作業場所を登録する（remote が無いなら --name でこの PC での名前を付ける）
mitos project list                               登録済みの作業場所と、最後の同期
mitos project forget <key|名前> [--yes]          作業場所のデータを消す（--yes が無ければ数えるだけ）
mitos sync [--cwd <dir> [--reset-docs]]          この PC にある作業場所の GitHub と文書を同期する（日次用）。文書は
                                                 remote の既定 branch から入れ、fast-forward でなければ止まる
                                                 （--reset-docs はその作業場所を今の状態に揃える）
mitos search <質問> [--avoid] [--said me|others|<名前>] [--all] [--cwd <dir>] [--limit N]
                                                 引けるかを確かめる（--said は発言を探す）
mitos who [<呼び名> <ハンドル>... [--me]]         GitHub のハンドルと人を結ぶ（--me は持ち主）
mitos trace context [--host claude-code|codex]   いまの session の会話と、進行中の作業を出す（trace の材料）
mitos trace check <trace.json|->                 trace の記録の形を確かめる（DB に触らない。- は標準入力）
mitos trace save <trace.json|->                  trace の記録を入れる（- は標準入力）
mitos capture flush                              自動記録の待ち行列を DB へ送る
mitos init [--cwd <dir>]                         要件定義と設計書の置き場所 .mitos/ をリポジトリの根に作る
mitos check [--cwd <dir>]                        .mitos/ の change.json を検査する（DB に触らない）
mitos doctor                                     plugin の版、鍵と接続、schema、同期と自動記録の状態
mitos advice                                     編集フックが制約を出した割合
mitos --version                                  この CLI の版と置き場所
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
| `CLERK_SECRET_KEY` / `CLERK_PUBLISHABLE_KEY` / `MITOS_ALLOWED_USER_ID` | 画面の API の認証（通すのは 1 人だけ）。揃わないと `bun run api` は起動しない |

DB の鍵は操作ごとに分け、どの鍵も別の鍵へ落とさない。`bun run db:roles` が 3 つのロールの鍵を作り直して書く。
ロールの権限は `.agents/skills/knowledge-schema/SKILL.md`、デプロイ先の変数は `.agents/skills/deploy/SKILL.md`。

## セットアップ

DB を初めて作るときだけ、owner の鍵を置いてから次を叩く。

```bash
bun run setup                  # server / dashboard の依存を各 lockfile から入れる（Lefthook も入る）
bun run db:apply               # 空の DB に db/schema.sql を当てる
bun run db:roles               # 3 つのロールに鍵を作り、knowledge.env へ書く
bun run bundle                 # plugin/dist を作る（MCP・自動記録・CLI）
mitos doctor                   # 鍵と接続、schema の版、DB の大きさを確かめる
mitos project add --cwd <repo> # 記録する作業場所を登録する
mitos sync --cwd <repo>        # 最初の取り込み
```

既存の DB は作り直さず、owner の鍵がある PC で `bun run db:migrate` を叩いて `db/migrations` の新しい分を当てる。
MCP・CLI・画面の API は、DB の schema の版がコードより古いと止まってこれを案内する。`db:migrate` は当てる前に
接続先の endpoint 名を打ち直させる。本番へ当てる順序と戻し方は `.agents/skills/knowledge-schema/SKILL.md`。

### 新しい PC で使い始める

```bash
# 1. ~/.claude/knowledge.env を手で置く（owner の KNOWLEDGE_DB_URL は置かない）

# 2. リポジトリとプラグイン。plugin は GitHub から入れる（ローカルの directory を marketplace にすると、
#    Claude Code は作業ツリーを直接読み、配布したものと違う中身で動く）
git clone https://github.com/iroha924/mitos.git ~/Projects/mitos
cd ~/Projects/mitos && bun run setup && bun run bundle
claude plugin marketplace add iroha924/mitos && claude plugin install mitos@mitos
codex plugin marketplace add iroha924/mitos --ref main && codex plugin add mitos@mitos

# 3. ダッシュボードを使うなら
cd ~/Projects/mitos/dashboard && clerk env pull

# 4. 確かめる
mitos doctor

# 5. 日次同期（この PC でも取り込むなら）
sed -e "s#__MITOS_DIR__#$HOME/Projects/mitos#g" -e "s#__HOME__#$HOME#g" \
  ~/Projects/mitos/scripts/com.mitos.sync.plist > ~/Library/LaunchAgents/com.mitos.sync.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mitos.sync.plist
```

日次同期は launchd が毎日 6:00 に `mitos sync` を叩く（ログは `~/.claude/mitos-sync.log`、外すのは
`launchctl bootout gui/$(id -u)/com.mitos.sync`）。各リポジトリで `git fetch` するので、launchd の環境から remote に
届く資格情報が要る。作業場所の置き場所は `~/Projects` の直下と、名前を付けた作業場所から探す。

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
bun run verify       # biome・architecture・verify:ai・tsc・test・Next.js の本番ビルド（pre-push / CI と同じ）
bun run test         # server の node:test
bun run bundle       # plugin/dist を作り直す
```

- **CLI・同期・plugin を変える作業は別の git worktree で行う。**日次同期は `~/Projects/mitos` の
  `plugin/bin/mitos` を叩くので、そこで branch を切ると作業途中の `dist` で本番の DB へ書く
- **DB を使う確認は、本番から切った Neon の branch で行う。**`KNOWLEDGE_ENV_DIR` に branch の鍵の `.env` を置いた
  ディレクトリを指すと、`~/.claude/knowledge.env` より先に読まれる。`.env` に無い鍵は `knowledge.env` で補われて
  本番へ繋がるので、DB の鍵は 4 つとも branch 向きで書く。branch を親の状態へ戻すのは
  `neon branches reset <branch> --parent`
- MCP・フック・Skill の変更を届けるには、版を上げて merge し、install 済みの plugin を更新する
  （`.agents/skills/plugin-release/SKILL.md`）。セッションを張り直すだけでは届かない

構成は `server/`（取り込み・検索・MCP・自動記録・CLI・画面の API）、`dashboard/`（Next.js）、`plugin/`（配るもの）、
`db/schema.sql`（DB の正本）、`db/migrations/`（既存の DB を進める手順）。
流れは [docs/diagrams/](docs/diagrams/README.md)、AI 向けの規約は `AGENTS.md`。
DB は Neon で、容量の上限（Free は 512 MB）に当たると書き込みが止まる（`mitos doctor` の「DB の大きさ」）。
埋め込みの行が 5 万に近づいたら HNSW を足す（実測は `.agents/skills/knowledge-schema/SKILL.md`）。
