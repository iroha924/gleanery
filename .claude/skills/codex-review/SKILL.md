---
name: codex-review
description: gleanery の差分のレビューや調査を Codex（codex exec）に頼む。PR を merge する前、一次情報で決まらない判断を別のモデルと突き合わせるとき、入った変更を振り返るときに使う。Codex の指摘を受け取って直すところまでを扱う。Claude Code 側の reviewer（review-shipping・review-ui）を立てるときには使わない。
---

# Codex にレビューと調査を頼む

## Triggers

- PR を merge する前（差分の独立レビュー）
- 一次情報で決まらない判断や、規範どうしが衝突したとき
- main へ入った変更を振り返るとき

## Does not trigger

- Claude Code 側の reviewer（`review-shipping`・`review-ui`）を立てる
- Codex に実装を任せる

## 頼み方

```bash
codex exec -s read-only --ephemeral - < <依頼文のファイル> > <出力のファイル> 2>&1
```

- Bash の `run_in_background` で投げ、完了の通知を待つ。1 本で 10〜15 分かかる。途中で止めない
- モデルと effort は渡さない（持ち主の `~/.codex/config.toml` に従う）
- 依頼文は scratchpad に書き、次を入れる
  - 範囲: `git diff <base>..<head>`、または未 commit の `git diff` と基準の commit
  - 変更の要旨と、持ち主が決めたこと（指摘の対象にしない）
  - 受け入れ条件
  - 返す形: 重い順、`file:line`、再現できる入力、確かさ（再現済み / 読んで確定 / 推測）。欠陥が無ければ無いと書く
  - 読むだけでファイルを書き換えないこと
- Claude 側の reviewer の結論と自分の見立てを渡さない（独立した判断でなくなる）

## 受け取り方

- 最終の答えは出力の `tokens used` の後にもう一度出る。そこを読む
- 指摘は主張として扱う。コードか再現で裏を取り、直す前のコードで落ちる test を書いてから直す
- 直したら、直した差分だけを範囲にして再レビューに出す
- 採らなかった指摘は、理由を 1 行ずつ PR 本文の「見送った指摘」に書く
- 指摘が周辺の入力だけになり、受け入れ条件の違反が無くなったら止める
