# mitos で作業するとき

過去の作業から「なぜそうしたか」を貯めて、Claude Code と Codex から引けるようにする道具。
TypeScript / bun、PostgreSQL 17（pgvector + pgroonga）、埋め込みは Voyage、生成は OpenAI。
**DB は ConoHa VPS の `knowledge-mcp-prod-01`** で、Tailscale 経由でのみ待ち受ける。
証明書は `plugin/certs/` に置き、`db.ts` がそこにある `.crt` を全部 CA として読む。

**このファイルは Claude と Codex の両方に効く。**Claude 側は `CLAUDE.md` が 1 行で取り込んでいる。

## 触る前に知っておくこと

### MCP を直したら、版を上げないと誰にも届かない

**`bun run bundle` だけでは Claude Code に届かない。**プラグインは
`~/.claude/plugins/cache/mitos/mitos/<版>/` へ複製されたものから動き、**複製は版が変わったときしか
起きない。**セッションを張り直しても、`claude plugin marketplace update` を通しても入れ替わらない。

実測（2026-09-08）: `server/src/mcp.ts` に丸 1 日ぶんの変更を入れてビルドし直しても、
キャッシュは 2 日前のままで、新しいツール（`current_work`）はどのセッションにも見えていなかった。

```bash
bun run bundle
# plugin/.claude-plugin/plugin.json と .claude-plugin/marketplace.json の version を上げる
claude plugin update mitos     # 「Restart to apply changes」と出る
# セッションを張り直す
```

**忘れても止まる。**`plugin/dist/mcp.js` が変わったのに版が同じコミットは、pre-commit の
`mcp-version`（`scripts/check-mcp-version.mjs`）が弾く。**規約では守れなかったので機構にした** —
これを書いた当日に、書いた本人が 8 コミット続けて踏んだ。

**届いたかはツールの一覧で確かめる。**足したツールが見えなければ古いまま。

**CLI は別経路。**`plugin/bin/mitos` は `plugin/dist/cli.js` を直接読むので、この手順は要らない。
つまり**片方だけ新しくなる。CLI で動いたことは、MCP で動く証拠にならない。**

### 人間向けの面で動いても、AI 向けの面は別に確かめる

このリポジトリで見つかる欠陥は、ほぼ 1 種類に集約する。
**書いたものが AI 向けの出口に届いておらず、人間向けの出口では動くので気付けない。**

| 人間向け | AI 向け |
|---|---|
| ダッシュボード / `mitos search` の標準出力 | `quote()` が返す文字列、MCP のツール応答 |
| README | `AGENTS.md`、`CLAUDE.md`、`.claude/rules` |
| `plugin/bin/mitos`（CLI） | `plugin/dist/mcp.js`（プラグインのキャッシュ経由） |

**両方を実際に叩いて確かめる。**片方の成功をもう片方の証拠にしない。

### 置き場所はマシンごとに違う

**ナレッジは共有、パスは共有しない。**作業場所の識別子は git remote なのでマシンをまたいで同じだが、
どこに置いてあるかは `scope_path (scope_id, host, abs_path)` がホストごとに持つ。

`mitos sync` はこのホストの行しか見ない。**新しい PC では `mitos adopt` を 1 回叩く**
（`~/Projects` を走査して、識別子が一致する作業場所へ置き場所を結び付ける）。
叩かないと 1 件も取り込めず、`sync` は終了コード 1 で止まる。
`mitos doctor` の「置き場所」行に、このマシンで取り込める件数が出る。

**会話の transcript はそのマシンにしかない**（`~/.claude/projects/`）。
別のマシンで交わした会話は、そのマシンで `sync` を通すまでナレッジに入らない。

手順は `README.md`「新しい PC で使い始める」。

### 書き込みの境界

**ナレッジを書けるのは CLI だけ。**MCP とフックは `knowledge_ro` で繋ぎ、権限の側で読み取りに限る
（`supabase/migrations/20260906120000_readonly_role_for_mcp.sql`）。推論する層に資格情報を持たせない。

例外は `search_log` 1 表だけで、**追記しかできず、読み戻せず、消せない**。

**境界を決めるのはロールの権限だけにする。**セッションを読み取り専用にする迂回を置くと、
そこへ書くために書き込みトランザクションを開くことになり、接続を共有している他の
ツール呼び出しからも読み取り専用が外れる（実測で確認して撤去した）。
代わりに `KNOWLEDGE_DB_URL_RO` が無いときは**繋がずに落とす** — 管理側の鍵へ落ちると、
推論する層が「全部書ける鍵」を持つ。

**ナレッジ本体（`record` / `node`）へ MCP から書く道を作らない。**
実測で確かめる手順は `mitos doctor` と、`knowledge_ro` で繋いで
`insert into node` が `permission denied` になることの確認。

## コマンド

```bash
bun run check      # biome + tsc（server / dashboard）
bun run test       # node:test
bun run bundle     # plugin/dist を作り直す（MCP・フック・CLI）
bun run eval       # 答えの正しさを測る
bun run dev        # API + ダッシュボード
```

**`bun run dev` は前面でだけ使う。**背景で起動すると `--parallel` が TTY を取りにいって落ちる。

資格情報は `~/.claude/knowledge.env`（`SUPABASE_DB_URL` / `KNOWLEDGE_DB_URL_RO` /
`KNOWLEDGE_DB_URL_CFG` / `VOYAGE_API_KEY`）。**リポジトリには置かない。**
**`SUPABASE_DB_URL` という名前は Supabase を離れた後も残っている**（書き込み用の鍵という意味）。
名前の付け替えは移行と分けるために保留した。

## 記録の置き場所

**HTML と Markdown の記録ファイルは廃止済み。**正本は DB で、人が読む面はダッシュボード
（`/now` が現在地）。`*.progress.html` / `*.progress.md` を作り直さない。

取り込み口は 5 つ。**新しい取り込み元を足すときは、既存のどれかと同じ形にする。**

| 口 | 何が入るか |
|---|---|
| `mitos ingest` | `/mitos:trace` が書いた IR（判断そのもの） |
| `mitos import-github` | PR と issue の本体、レビューと議論 |
| `mitos import-linear` | Linear の issue とコメント |
| `mitos import-sessions` | Claude Code の会話（1 往復 = 1 件） |
| `mitos import-docs` | リポジトリの Markdown（見出しで節に割る）。**既定の検索には出ない** |

**`mitos ingest` 以外の 4 つを `mitos sync` が日次で回す**（launchd。毎日 6:00）。
判断の構造化（`/mitos:trace` → `ingest`）だけは人が明示的に頼んだときに走る
（機械が書くと未完成の記録になる、という棄却理由が生きている）。

**新しい取り込み口を足したら sync にも繋ぐ。**繋がないと、人が手で叩いたときしか入らない。

## 詳しくは

- `README.md` — 全体像、精度の測り方、新しい PC で使い始める、うまく動かないとき
- `.claude/rules/knowledge-schema.md` — データの形（`server/src` と `supabase/migrations` で自動ロード）
- `plugin/skills/trace/SKILL.md` — 記録を作る側の契約
