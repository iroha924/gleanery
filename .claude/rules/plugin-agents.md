---
paths:
  - "plugin/agents/**"
---

# プラグインが配るエージェントを触るとき

`plugin/agents/` に置いたものは `/mitos:review` が起動するレビュアーである。
**ここでの失敗はどれもエラーを出さない。**定義した本人には書いたとおりに見え、
起動もし、出力の形も変わらないまま、中身だけが別物になる。

## 呼ぶときは `mitos:` を付ける

```
subagent_type: mitos:review-adversarial   ← これ
subagent_type: review-adversarial         ← 同名が他にあれば別物へ解決する
```

プラグイン由来の agent は**スコープ付きの識別子**で登録される。素の名前で呼べてしまうことがあるが、
それは「他に同名が無かった」だけで、保証ではない。

## 同名をユーザースコープに置かない

**プラグインの agent は優先順位が最下位である。**公式の表（<https://code.claude.com/docs/en/sub-agents>）:

| 置き場所 | 優先度 |
|---|---|
| managed settings | 1（最高） |
| `--agents` フラグ | 2 |
| `.claude/agents/` | 3 |
| `~/.claude/agents/` | 4 |
| **プラグインの `agents/`** | **5（最低）** |

> When multiple subagents share the same name, Claude Code uses the one from the higher-priority location.

**実測（2026-09-09）**: `~/.claude/agents/review-{adversarial,security,conventions,cleanup,precedent}.md` が
残っていたため、`plugin/agents/` の定義は**一度も起動していなかった**。呼び出しは成功し、
レビューも返ってくるので、出力を見ても気付けない。個人設定側の 5 本を消して初めて効いた。

個人設定リポジトリ（`hir4ta-developer`）の `install.py` は、この理由で `agents` を symlink 対象から
外してある。**レビュアーの定義はプラグイン側だけに置く。**

## `model` と `effort` はフロントマターで固定する

**省略すると、値は 3 つの外部から入ってくる。**解決順は
per-invocation の指定 → フロントマター → `CLAUDE_CODE_SUBAGENT_MODEL` → メイン会話のモデル。
つまり書かなければ、**環境変数かその日のセッションのモデルで決まる。**
安いモデルで開いた日にはレビューだけが浅くなり、出力は同じ形で返るので気付けない。
（`inherit` は「メイン会話に合わせる」を明示する値であって、省略時の既定ではない。
どちらにせよ固定にはならない。）

`effort` の取りうる値はモデルによって違うので、**モデルを固定して初めて `effort` の指定が意味を持つ。**
`effort` だけ書いて `model` を `inherit` のままにするのは、固定したつもりで固定できていない状態である。

**測らずに値を決めない。**各レビュアーの本文に、その値を選んだ理由（読む先が有限か、探索の広さが要るか）を
1 段落で書いてある。値を変えるならその段落も直す。

## ここを直しても、版を上げるまで届かない

**ファイルの監視は効かない。**Claude Code が監視するのは `~/.claude/agents/` と
`.claude/agents/` の 2 つで、`plugin/agents/` はどちらでもない。プラグインの agent は
`~/.claude/plugins/cache/mitos/mitos/<版>/` の複製から読まれ、**複製は版が変わったときしか
起きない**（`AGENTS.md`「MCP を直したら、版を上げないと誰にも届かない」。3 つのマニフェストすべて）。

**したがって `plugin/agents/` の変更が届く条件は、版の更新だけである。**
保存して数秒待っても、セッションを張り直しても、入れ替わらない。

**壊れ方**: 直したつもりで `/mitos:review` を回すと、起動もするしレビューも返ってくる。
中身だけが複製された古い定義である。エラーは出ない。

加えて、`agents/` ディレクトリ自体を新規に作った回は**セッションの再起動も要る** —
ディレクトリの探索はセッション開始時に一度だけ走る。

「書いたのに効いていない」の大半はこの 2 つで、定義の側を疑うと時間を溶かす。

## 自己完結にする。外部を参照しない

**プラグインのキャッシュにはリポジトリ直下の `CLAUDE.md` / `AGENTS.md` が入らない。**
subagent には*配布先の*リポジトリの規約が届き、*mitos 自身の*規約は届かない。

したがって、agent 本文から次を参照しない。

- mitos の `AGENTS.md` / `.claude/rules/`（このファイル自身を含む）
- `plugin/skills/` の中身
- 相対パスで書いた別ファイル

**必要なことは本文に書き切る。**参照で済ませると、配布先では空を指す。

## Codex には配れない

`plugin/.codex-plugin/plugin.json` が読むのは `skills` / `hooks` / `mcpServers` / `apps` だけで、
`agents` は無い。**プラグインのルートは丸ごと複製されるので `plugin/agents/` はコピーされるが、
Codex はそれを読まない。**

Codex 側で同じ観点を回すなら、`plugin/skills/review/SKILL.md` の側に手順として書く。
**agent を足して両方で効くつもりにならない。**

## 直したら届いたかを確かめる

版を上げないとプラグインのキャッシュは入れ替わらない（`AGENTS.md`「MCP を直したら、版を上げないと
誰にも届かない」。3 つのマニフェストすべて）。agent も同じキャッシュから読まれる。

**届いたかは、実際に 1 体起動して確かめる。**ファイルを直したことは、届いた証拠にならない。

作り方そのもの（フロントマターの全フィールド、消えるツール、description の書き方）は
`docs-author` スキルが持っている。ここには写さない — 写すと版がずれる。
