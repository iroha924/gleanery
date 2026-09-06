# issue を引く

## Contents

- 原則
- GitHub
- Linear
- Jira
- その他 / 取れないとき

## 原則

**取得手段はホストと環境で違う。**このスキルは取得のためのラッパーを持たない。
順に試して、取れたら記録し、取れなければ**取れなかったと記録する**。

```
1. ホストが持っている MCP（あれば）
2. その追跡ツールの CLI（あれば）
3. ユーザーに本文を貼ってもらう
4. どれも駄目 → key と url だけ残して fetched: false
```

**黙って空にしない。**`fetched: false` は欠落の記録であって、失敗ではない。
記録に「未取得」と出るので、次に見た人が埋められる。

欲しいのは 5 つ。**題 / 状態 / 本文 / 担当 / 依存関係（親子と blocking）。**
依存関係は再開時の依存図になる。

## GitHub

```bash
gh issue view <番号> --json number,title,state,body,labels,assignees,url,createdAt,updatedAt,parent,blockedBy,blocking,comments
gh issue list --state all --limit 20 --json number,title,state,url
gh pr list --state all --limit 20 --json number,title,state,headRefName,url,mergedAt
```

別リポジトリなら `--repo <owner>/<name>` を足す。
Claude Code に GitHub の MCP が繋がっているなら、そちらでも同じものが取れる。

`blockedBy` / `blocking` / `parent` は GitHub の issue の依存機能。使っていないリポジトリでは
空で返る。その場合は本文中の「blocked by #405」のような記述から拾って `blockedBy` に入れてよいが、
**推測で辺を足さない**（違う依存を描くと、再開した側が順序を間違える）。

## Linear

**CLI は前提にしない。**入っていないマシンがある。

- MCP が繋がっているならそれを使う
- 繋がっていなければ、`https://linear.app/<org>/issue/<KEY>` を `url` に、`ENG-412` のような
  識別子を `key` に入れ、本文はユーザーに貼ってもらう
- 取れなければ `fetched: false`

Linear の識別子は `<チーム略号>-<番号>` の形なので、`key` にはその形をそのまま入れる。

## Jira

**CLI は前提にしない。**

- MCP か、組織で使っている取得手段があるならそれを使う
- 無ければ `https://<site>.atlassian.net/browse/<KEY>` を `url` に、`PROJ-412` を `key` に入れる
- 取れなければ `fetched: false`

Jira の親子は Epic / Story / Sub-task の階層になっていることが多い。`parent` に入れる。

## その他 / 取れないとき

追跡ツールを使っていない、あるいは社内システムで取得手段が無いこともある。
そのときは `key` に呼び名（「9 月の経理定例で決まった件」）、`url` は省略、`fetched: false`。

**識別子すら無い作業は、issue を持たない記録として作ってよい。**`links.issues` を空配列にする。
`find` は題と id でも当たるので、次に再開するときに引ける。
