---
paths:
  - "server/evals/**"
---

# agentic の eval

`bun run evals:agentic` は出荷の MCP を `claude -p` に渡し、持ち主の DB とサブスクで測る。`bun run verify` にも CI にも入れない。

- `claude -p` に `--no-session-persistence` を付け、`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` を渡す（付けないと `~/.claude/projects/` に問いごとの session と `memory/` が溜まる）
- 作業ディレクトリは問いごとの一時ディレクトリにし、`--setting-sources project` と `--strict-mcp-config` を付ける（持ち主の plugin と hook が eval の会話を DB へ書く）
- holdout の問いはゲートの判定でだけ流す
- 同じ構成を 3 回流した平均どうしで比べる
- 比べる run のモデルの ID・Claude Code のバージョン・effort を揃える（`--model sonnet` のような別名と既定の effort はバージョンで変わる）。run が記録し、judge が揃わないと警告する
- 測る DB は `GLEANERY_DB` で指す（MCP の設定へ明示して渡す）
