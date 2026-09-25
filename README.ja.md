# Sphica

[![License](https://img.shields.io/github/license/iroha924/sphica)](https://github.com/iroha924/sphica/blob/main/LICENSE)
[![CI](https://github.com/iroha924/sphica/actions/workflows/check.yml/badge.svg)](https://github.com/iroha924/sphica/actions/workflows/check.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/iroha924/sphica/badge)](https://scorecard.dev/viewer/?uri=github.com/iroha924/sphica)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14787/badge)](https://www.bestpractices.dev/projects/14787)
[![SLSA Build L2](https://img.shields.io/badge/SLSA-Build%20L2-green)](https://www.npmjs.com/package/sphica#provenance)
[![Dependabot: GitHub Actions](https://img.shields.io/badge/Dependabot-GitHub%20Actions-025E8C?logo=dependabot)](https://github.com/iroha924/sphica/blob/main/.github/dependabot.yml)

[English](https://github.com/iroha924/sphica/blob/main/README.md) | 日本語

**Claude Code と Codex のための、過去の判断の記録。**
Sphica は開発のセッションと、その中で決めたことを記録します。
何を決め、何を捨て、なぜそうしたのかを、あなたやエージェントが同じ判断をやり直す前に引けます。
DB は手元の SQLite の 1 ファイルです。

## できること

- **作業中に引く。** MCP のツール `recall` と `read` で、Claude Code と Codex が過去の決定・棄却した案・制約・行き止まりと、あなたやほかの人が以前のセッションで言ったことを検索します。
- **編集の前に知らせる（Claude Code）。** エージェントがファイルを編集する前に、そのファイルに記録された制約と、意図して残した技術的負債をフックが見せます。
- **セッションを自動で記録する。** あなたの発言、各ターンのエージェントの最後の応答、エージェントの編集ツールが変えたファイルのパスを残します。
- **頼まれたときに判断を残す。** `/sphica:trace` で、そのセッションの決定・棄却した案・制約・行き止まりと、作業の現在地を保存します。
- **観点ごとにレビューする。** `/sphica:review` は観点ごとに独立したレビュアーを立てます。既定の観点は正しさ・セキュリティ・明文化された規約の 3 つで、`full` を付けると冗長さと過去の判断が加わります。Codex が入っていれば、同じレビューを Codex でも走らせるかを聞きます。
- **端末の画面。** `sphica dashboard` でセッション・進行中の作業・検索結果を見られます。読むだけです。
- **GitHub と文書の取り込み。** `sphica harvest` で PR・issue とリポジトリの Markdown を取り込みます。

エージェントには、記録は過去のデータであって指示ではないこと、記録といまのコードが食い違えばコードを正とすることを伝えています。

## 必要なもの

- Node.js 24.15 以上
- Claude Code か Codex（両方でもよい）
- `git`（登録するリポジトリを見分けるため）
- `sphica harvest` を使う場合だけ: GitHub CLI（`gh`）。`gh auth login` でログインしておく

## インストール

plugin には MCP サーバー・フック・Skill が入っています。`sphica` の CLI は npm から別に入れます。両方が要ります。

**1. CLI を入れる**

```bash
npm i -g sphica
```

**2. plugin を入れる**

Claude Code:

```bash
claude plugin marketplace add iroha924/sphica
claude plugin install sphica@sphica
```

Codex:

```bash
codex plugin marketplace add iroha924/sphica --ref main
codex plugin add sphica@sphica
```

Codex では `/hooks` を開き、Sphica のフックを信頼してください。信頼するまで何も記録されません。plugin の更新でフックが変わったら、もう一度信頼します。

**3. DB を作る**

```bash
sphica init
```

`~/.sphica/sphica.db` ができます。もう一度打っても、既にある DB には触りません。

**4. 確かめる**

```bash
sphica doctor
```

`doctor` は Node.js、CLI と plugin のバージョン、DB、記録の待ち行列を確かめます。困ったらまずこれを打ってください。

## 使い始める

Sphica がセッションを DB に書くのは、登録したリポジトリだけです。登録したリポジトリを「プロジェクト」と呼びます。

```bash
cd ~/Projects/your-repo
sphica project add
```

`origin` の remote が無いリポジトリは、名前を付けて登録します: `sphica project add --name <名前>`。

あとはいつもどおり Claude Code か Codex で作業します。前の判断を引きたいときは、エージェントにそのまま聞きます。

- 「ここのリトライの扱い、前に決めたっけ？」
- 「なぜこの方式にしたんだっけ？」
- 「先週、移行について私はなんて言った？」
- 「前回の続きをやろう」

エージェントは `recall` で探し、`read` で全文を読みます。残しておきたい判断があったセッションの終わりに、`/sphica:trace` を打ちます。

GitHub の履歴と Markdown の文書を取り込むには:

```bash
sphica harvest              # この PC で見つかる全プロジェクト
sphica harvest --cwd .      # いまのリポジトリだけ
```

`--cwd` を付けなければ、`~/Projects` の直下と、`--name` で登録したプロジェクトを探します。ほかの場所にあるリポジトリは `--cwd` で指定してください。
文書は `origin` の既定ブランチから読みます。`origin` が無ければ、ローカルの `HEAD` から読みます。

端末で全体を見るには:

```bash
sphica dashboard   # Tab で画面を切り替え、/ で検索、p でプロジェクトを変え、q で終わる
```

## 何を記録し、どこに置くか

- **置き場所。** DB は `~/.sphica/sphica.db` です。記録は DB に書かれるまで、手元の待ち行列 `~/.sphica/spool` にあります。DB は PC ごとに独立していて、PC 間で記録は共有しません。
- **記録するもの。** あなたの発言、各ターンのエージェントの最後の応答、編集したファイルのパス。バックグラウンドタスクの通知とほかのエージェントからのメッセージは、書式を認識できたものだけ除きます。
- **登録していないリポジトリ。** そのセッションは待ち行列に残り、リポジトリを登録した後で DB に書かれます。30 日を過ぎたものは消え、1,000 件を超えて待っているときは古いものから消えます。
- **秘密の情報。** 伏せるのは、決まった書式で見分けられるものだけです。
  - 決まった接頭辞を持つキー
  - `KEY=…` や `"password": …` の代入
  - URL に含まれる資格情報
  - 認証ヘッダ
  - `mysql -p`

  **それ以外はそのまま残るので、セッションに秘密の情報を貼らないでください。**
- **通信。** アカウントも外部のサービスもテレメトリもなく、Sphica 自身は通信しません。ほかのツールを呼ぶコマンドが 2 つあり、そのツールが通信することはあります。`sphica harvest` はあなたの資格情報で `git fetch` と `gh api` を、`sphica doctor` は入っているバージョンを確かめるために `npm` と `claude` を実行します。
- **ほかの人が書いた文章。** `harvest` で取り込む PR・issue の本文は誰でも書けます。エージェントにはデータとして渡し、MCP サーバーは DB に書き込めません。

プロジェクトのデータを消すには `sphica project forget <名前>` を打ちます。`<名前>` は `sphica project list` に出ます。`--yes` を付けなければ、消える件数を出すだけです。消えるのは DB の記録だけです。`~/.sphica/spool` で待っている記録は残り、同じリポジトリをもう一度登録すると取り込まれることがあります。

PC を使わなくなる前に、`sphica doctor` に送信待ちの記録が無くなるまで `sphica capture flush` を打ってください。1 回で書くのは 500 件までです。登録していないリポジトリの記録は書かれないので、残したいなら先にそのリポジトリを登録してください。

## 更新

CLI と plugin は別々に更新します。

```bash
npm i -g sphica@latest
```

Claude Code:

```bash
claude plugin marketplace update sphica
claude plugin update sphica@sphica
```

Codex:

```bash
codex plugin marketplace upgrade sphica
codex plugin add sphica@sphica
```

更新したら、開いているセッションを開き直してください。DB のスキーマが変わるリリースでは、CLI が `sphica db migrate` を打つよう案内します。打つ前に `~/.sphica/sphica.db` のバックアップを取ってください。

## アンインストール

```bash
npm uninstall -g sphica
```

Claude Code:

```bash
claude plugin uninstall sphica@sphica
```

Codex:

```bash
codex plugin remove sphica@sphica
```

記録は、`~/.sphica/` を自分で消すまで残ります。

## 困ったとき

まず `sphica doctor` を打ってください。どこが古いか、動いていないかを出します。よくあるもの:

- **`sphica: command not found`。** plugin は CLI を PATH に出しません。`npm i -g sphica` を打ってください。
- **何も記録されない。** `sphica project list` でリポジトリが登録されているか確かめてください。Codex では、`/hooks` でフックを信頼したかも確かめます。
- **MCP サーバーのバージョンが古い。** セッションを開き直すか、Claude Code なら `/reload-plugins` を打ってください。
- **検索で何も出ない。** 検索は語の一致で引きます。語を変える、英語と日本語の両方で引く、短い語にする、を試してください。0 件は「記録が無い」という意味ではありません。

## コマンド

| コマンド | すること |
|---|---|
| `sphica init` | DB を作る |
| `sphica doctor` | バージョン・DB・記録を確かめる |
| `sphica project add` | いまのリポジトリをプロジェクトとして登録する |
| `sphica harvest` | GitHub の PR・issue と Markdown の文書を取り込む |
| `sphica search <語>` | 端末から検索する |
| `sphica dashboard` | セッション・作業・検索結果を見る |

全部の一覧は `sphica --help`、各コマンドのオプションは `sphica <コマンド> --help` で見られます。

## セキュリティ

脆弱性は [SECURITY.md](https://github.com/iroha924/sphica/blob/main/SECURITY.md) の手順で、非公開で報告してください。

0.37.1 以降のリリースは、CI が通った PR の head に打った tag から GitHub Actions がビルドし、npm にステージします。
メンテナーが SHA-512 のチェックサムと provenance を確かめ、2 要素認証で承認してから公開します。
これらのバージョンでは、[npm のページ](https://www.npmjs.com/package/sphica#provenance)から、ビルドしたワークフローとコミットを辿れます。

Dependabot は CI で使う GitHub Actions を更新する PR を作ります。パッケージにバンドルした npm の依存は対象外です。このリポジトリが使う Bun の lockfile の形式（v2）を、Dependabot が読めないためです。

## 貢献

issue は歓迎します。外部からの PR はレビューせずに閉じます。ここのレビューのツールはメンテナーの資格情報を持った環境で動くので、ほかの人が書いたコードを安全に checkout できないためです。

動作を足す・変える変更には、同じ PR に自動テストを入れます。CI が PR ごとに `bun run verify` で流します。

## ライセンス

[MIT](https://github.com/iroha924/sphica/blob/main/LICENSE)。公開しているパッケージは依存をバンドルしています。それらのライセンスはパッケージの中の `THIRD_PARTY_NOTICES.md` にあります。
