#!/bin/bash
# 開いている PR を見て、まだ見ていないものをレビューして投稿する。systemd timer から呼ぶ。
#
# **webhook は使えない。**この箱はインターネットからの受信を 1 つも開けていないので、
# GitHub から叩いてもらう道が無い（`e-routine-cannot-reach-local` と同じ形）。
# こちらから見に行くしかない。
#
# **head の SHA まで込みで覚える。**PR 番号だけで覚えると、push し直しても二度と見ない。
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
gh_env=$HOME/.claude/gh.env
state=$HOME/.claude/reviewed.txt
repos=$HOME/.claude/review-repos.txt   # 1 行 1 つの owner/repo

[ -r "$gh_env" ] || { echo "$gh_env が無い。GITHUB_TOKEN=... を mode 600 で置く" >&2; exit 1; }
[ -r "$repos" ] || { echo "$repos が無い。見にいく owner/repo を 1 行ずつ書く" >&2; exit 1; }
# shellcheck disable=SC1090
. "$gh_env"
: "${GITHUB_TOKEN:?$gh_env に GITHUB_TOKEN が無い}"
touch "$state"

while read -r repo; do
  case "$repo" in "" | \#*) continue ;; esac

  # **draft は見ない。**書きかけに指摘しても手戻りにしかならない。
  #
  # **最後まで辿る。**1 ページ目だけ取ると、open が 100 件を超えたときに 101 件目以降が
  # エラーも出さずに対象から消える。「見ていない」と「指摘が無い」が区別できなくなる。
  open=""
  page=1
  while :; do
    got=$(curl -fsSL \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/repos/$repo/pulls?state=open&per_page=100&page=$page")
    [ "$(printf '%s' "$got" | jq 'length')" -gt 0 ] || break
    open="$open$(printf '%s' "$got" | jq -r '.[] | select(.draft | not) | "\(.number) \(.head.sha)"')
"
    page=$((page + 1))
  done

  while read -r num sha; do
    [ -n "${num:-}" ] || continue
    key="$repo#$num@$sha"
    grep -qxF "$key" "$state" && continue

    echo "$(date -Is) レビュー: $key"
    if "$here/review-pr.sh" "$repo" "$num" --post; then
      # **成功したときだけ覚える。**失敗を覚えると、原因を直した後も二度と見ない。
      echo "$key" >> "$state"
    else
      echo "$(date -Is) 失敗: $key（次回もう一度見る）" >&2
    fi
  done <<< "$open"
done < "$repos"
