# mitos で作業するとき

過去の作業から「なぜそうしたか」を貯めて、Claude Code と Codex から引けるようにする道具。
TypeScript / bun、PostgreSQL（pgvector + pg_trgm）、埋め込みは Voyage、生成は OpenAI。
DB は ConoHa VPS の `knowledge-mcp-prod-01` で、Tailscale 経由でのみ待ち受ける。
自己署名の証明書は `plugin/certs/<ホスト名>.crt` に置く。**束ねない** — `db.ts` は接続先の
ホスト名と同じ名前のものだけを CA にし、無ければ公開 CA を使う。
**OS の更新と再起動は無人で当たり、PostgreSQL の更新は人が当てる**（PGDG を自動更新の対象に
入れていないため）。どちらも `mitos doctor` の「VPS」「PostgreSQL の更新」の 2 行に出る。
詳しくは `README.md`「DB を載せている VPS」。

このファイルは Claude と Codex の両方に効く（Claude 側は `CLAUDE.md` が 1 行で取り込んでいる）。
ただし**開発の大半が Claude Code で回るので、壊れても気付かないのは Codex 側になる。**
Codex にしか関係しない主張は、書いた側が実際に叩いて確かめる。
`.claude/rules/` は Claude だけの機構で、そこへ移した内容は Codex から消える。

## 触る前に知っておくこと

### MCP を直したら、版を上げないと誰にも届かない

`bun run bundle` だけでは Claude Code に届かない。プラグインは
`~/.claude/plugins/cache/mitos/mitos/<版>/` へ複製されたものから動き、**複製は版が変わったときしか
起きない。**セッションを張り直しても、`claude plugin marketplace update` を通しても入れ替わらない。

実測（2026-09-08）: `server/src/mcp.ts` に丸 1 日ぶんの変更を入れてビルドし直しても、
キャッシュは 2 日前のままで、新しいツール（`current_work`）はどのセッションにも見えていなかった。

```bash
bun run bundle
# 版を上げる。3 箇所すべてを同じ版にする（pre-commit が揃っているかを見る）
#   .claude-plugin/marketplace.json
#   plugin/.claude-plugin/plugin.json
#   plugin/.codex-plugin/plugin.json  ← 配る先ごとにマニフェストがある
claude plugin update mitos     # 「Restart to apply changes」と出る
# セッションを張り直す
```

忘れても止まる。`plugin/dist/mcp.js` が変わったのに版が同じコミットは、pre-commit の
`mcp-version`（`scripts/check-mcp-version.mjs`）が弾く。規約では守れなかったので機構にした —
これを書いた当日に、書いた本人が 8 コミット続けて踏んだ。

届いたかはツールの一覧で確かめる。足したツールが見えなければ古いまま。

CLI は別経路で、`plugin/bin/mitos` は `plugin/dist/cli.js` を直接読むのでこの手順は要らない。
つまり片方だけ新しくなる。**CLI で動いたことは、MCP で動く証拠にならない。**

### 人間向けの面で動いても、AI 向けの面は別に確かめる

このリポジトリで見つかる欠陥は、ほぼ 1 種類に集約する。
書いたものが AI 向けの出口に届いておらず、人間向けの出口では動くので気付けない。

| 人間向け | AI 向け |
|---|---|
| ダッシュボード / `mitos search` の標準出力 | `quote()` が返す文字列、MCP のツール応答 |
| README | `AGENTS.md`、`CLAUDE.md`、`.claude/rules` |
| `plugin/bin/mitos`（CLI） | `plugin/dist/mcp.js`（プラグインのキャッシュ経由） |

**両方を実際に叩いて確かめる。**片方の成功をもう片方の証拠にしない。

### 片方を直したら、対を探す

同じ判断が 2 箇所以上に現れる形が多い。直す側は 1 箇所しか見ていないので、もう片方が
古いまま残り、そちらはそちらで動くので気付けない。上の「人間向け / AI 向け」はこの特殊形で、
対はその 2 面に限らない。

実測（2026-09-08 から）。件数はここに書かない — 表が増えるたびに数字だけ古くなる。

| 直した場所 | 見落とした対 |
|---|---|
| symlink の末端を lstat で弾く | 途中のディレクトリ自体が symlink のとき（realpath の前方一致へ） |
| `identify()` が見る基点 | `syncDocs` へ渡す引数 |
| `search()` の既定の除外 | `outsideScopes()` が持つ同じリスト |
| MCP が返す記録の帰属 | 画面のチャットが出す帰属 |
| 引用の枠へ入れる `node.text` | 枠の外へ漏れていた `record` の列 |
| README の `mitos doctor` の説明 | `cli.ts` の `USAGE` |
| pre-commit の `pairs` が終了コードを落としていた | 同じ形の `bundle`（この表を書いた直後に踏んだ） |
| Claude のプラグインの版（13 回上げた） | Codex のプラグインの版（作られたときの `0.1.0` のまま。版のゲート自身が Claude 側しか見ていなかった） |
| レビュアーの `effort` を固定した | 同じ理由が当たる `model`（`inherit` のまま残り、その日のセッションのモデルで深さが変わっていた） |
| `USAGE` を README の正本にした | その `USAGE` に書いた「Codex の会話も入る」（`syncSessions` は Codex を読まない。正本にした当のコミットで混入した） |

**探し方は 1 つ。直した関数と定数の参照を全部引く。**同じ判断が要る呼び出し元が 2 つ以上
あれば、それが対である。同じ値を読む場所が複数あるなら、括り出して 1 つにする —
`DEFAULT_EXCLUDED` と `framed()` はそうして対そのものを消した。

機構で止まるのは一部だけ。pre-commit の `pairs`（`scripts/check-pairs.mjs`）が見るのは、
集合として列挙できる対に限る — `kind` の一覧が 3 つの出口で揃っているか、と README の CLI 一覧
（突き合わせず `USAGE` から書き出すので、写しが 1 つになる）。
経路の各段で同じ検査が要る形と、同じデータを別々に組み立てる 2 つの出口は捕まらない。
そこは上の探し方でやる。

### 置き場所はマシンごとに違う

ナレッジは共有、パスは共有しない。作業場所の識別子は git remote なのでマシンをまたいで同じだが、
どこに置いてあるかは `scope_path (scope_id, host, abs_path)` がホストごとに持つ。

`mitos sync` はこのホストの行しか見ない。**新しい PC では `mitos adopt` を 1 回叩く**
（`~/Projects` を走査して、識別子が一致する作業場所へ置き場所を結び付ける）。
叩かないと 1 件も取り込めず、`sync` は終了コード 1 で止まる。
`mitos doctor` の「置き場所」行に、このマシンで取り込める件数が出る。

会話の transcript はそのマシンにしかない（`~/.claude/projects/` と、ccs を使っているなら
`~/.ccs/instances/*/projects/`）。別のマシンで交わした会話は、そのマシンで `sync` を通すまで
ナレッジに入らない。

入るのは Claude Code の会話だけで、Codex の rollout は読んでいない。
Codex で進めた回の判断は `/mitos:trace` を通さないと残らない。

手順は `README.md`「新しい PC で使い始める」。

### 書き込みの境界

**ナレッジを書けるのは CLI だけ。**MCP とフックは `knowledge_ro` で繋ぎ、権限の側で読み取りに限る
（`db/migrations/20260906120000_readonly_role_for_mcp.sql`）。推論する層に資格情報を持たせない。

例外は `search_log` 1 表だけで、追記しかできず、読み戻せず、消せない。

境界を決めるのはロールの権限だけにする。セッションを読み取り専用にする迂回を置くと、
そこへ書くために書き込みトランザクションを開くことになり、接続を共有している他の
ツール呼び出しからも読み取り専用が外れる（実測で確認して撤去した）。
代わりに `KNOWLEDGE_DB_URL_RO` が無いときは繋がずに落とす — 管理側の鍵へ落ちると、
推論する層が「全部書ける鍵」を持つ。

**ナレッジ本体（`record` / `node`）へ MCP から書く道を作らない。**
実測で確かめる手順は `mitos doctor` と、`knowledge_ro` で繋いで
`insert into node` が `permission denied` になることの確認。

## コマンド

入口は `package.json` の scripts にある。

**`bun run test` は pre-commit が走らせていない**（見ているのは biome・tsc・bundle・版・対）。
コミット前に自分で通す。

`bun run dev` は前面でだけ使う。背景で起動すると `--parallel` が TTY を取りにいって落ちる。

資格情報は `~/.claude/knowledge.env`。**リポジトリには置かない。**
鍵は用途で 3 つに分かれていて（管理・読み取り専用・画面の設定）、どれを使うかが
「書き込みの境界」の実体になる。

## 記録の置き場所

**HTML と Markdown の記録ファイルは廃止済み。**正本は DB で、人が読む面はダッシュボード
（`/now` が現在地）。`*.progress.html` / `*.progress.md` を作り直さない。

取り込み口は次で全部。新しい取り込み元を足すときは、既存のどれかと同じ形にする。

| 口 | 何が入るか |
|---|---|
| `mitos ingest` | `/mitos:trace` が書いた IR（判断そのもの） |
| `mitos import-github` | PR と issue の本体、レビューと議論 |
| `mitos import-linear` | Linear の issue とコメント |
| `mitos import-sessions` | Claude Code の会話（1 往復 = 1 件） |
| `mitos import-docs` | リポジトリの Markdown（見出しで節に割る）。既定の検索には出ない |

`mitos ingest` 以外を `mitos sync` が日次で回す（launchd。毎日 6:00）。
判断の構造化（`/mitos:trace` → `ingest`）だけは人が明示的に頼んだときに走る
（機械が書くと未完成の記録になる、という棄却理由が生きている）。

**新しい取り込み口を足したら sync にも繋ぐ。**繋がないと、人が手で叩いたときしか入らない。

### PR と issue の本文は、そのまま記録になる

`import-github` が本文を丸ごと埋め込む（`server/src/github.ts` の `prText`。12,000 字まで、
差分は入れない）。つまり本文だけが、その変更の説明として残る。

**引かれ方は 2 つで違う。**issue の本文は既定の検索に出る。**PR の本文は既定から外してある**
（`search.ts` の `DEFAULT_EXCLUDED`。実測で 24 件・平均 5,015 バイトが結果を埋めたため）ので、
`kinds` を明示したときだけ返る。**したがって定型が直に効くのは issue 側**だが、PR 側も
「引いたときに出てくる唯一の説明」であることは変わらない。

書く前に `.github/pull_request_template.md`（issue は `.github/ISSUE_TEMPLATE/`）を読み、
その節に沿って書く。`gh` の `--template` は `--body` / `--body-file` と併用できないので、
**本文を渡す経路で雛形が自動で入る道は無い。**テンプレートは雛形ではなく、読んで埋める契約である。

埋まらない節は消す。定型だけの節は、埋め込みに入って何も足さない。

## 詳しくは

- `README.md` — 全体像、精度の測り方、新しい PC で使い始める、うまく動かないとき
- `plugin/skills/trace/SKILL.md` — 記録を作る側の契約
- `plugin/skills/review/SKILL.md` — `/mitos:review` の手順と、レビュアーの分担
- `.claude/rules/` — データの形は `knowledge-schema.md`、画面は `dashboard.md`、
  レビュアーの定義を触るときは `plugin-agents.md`
