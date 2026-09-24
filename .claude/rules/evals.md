---
paths:
  - "server/evals/**"
---

# Agentic evals

`bun run evals:agentic` passes the shipped MCP to `claude -p` and measures against the owner's DB and subscription. It is in neither `bun run verify` nor CI.

- Give `claude -p` `--no-session-persistence` and pass `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (without them, a session and `memory/` per question pile up in `~/.claude/projects/`)
- Use a temporary working directory per question, and pass `--setting-sources project` and `--strict-mcp-config` (otherwise the owner's plugins and hooks write the eval's conversation to the DB)
- Run holdout questions only for the gate's verdict
- Compare averages of 3 runs of the same setup
- Match the model ID, Claude Code version, and effort across the runs you compare (aliases like `--model sonnet` and the default effort change between versions). The run records them, and the judge warns when they do not match
- Point `GLEANERY_DB` at the DB being measured (pass it explicitly in the MCP config)
