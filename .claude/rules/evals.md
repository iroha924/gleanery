---
paths:
  - "server/evals/**"
---

# Agentic evals

`bun run evals:agentic` passes the shipped MCP to `claude -p`, or with `--host codex` to `codex exec`, and measures against the owner's DB and subscription. It is in neither `bun run verify` nor CI.

- Give `claude -p` `--no-session-persistence` and pass `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (without them, a session and `memory/` per question pile up in `~/.claude/projects/`)
- Use a temporary working directory per question, and pass `--setting-sources project` and `--strict-mcp-config` (otherwise the owner's plugins and hooks write the eval's conversation to the DB)
- Run holdout questions only for the gate's verdict
- Codex: each question gets a fresh HOME and CODEX_HOME holding only a link to `auth.json`, the shell and other built-ins off, and only sphica's recall and read. Each measurement first runs a capability probe (kept as `probe.jsonl`) and stops if another tool was called. Codex reports no cost, so `--questions` caps a run instead of `--budget`. Compare Codex runs only with a Codex base (`--base codex-base`, kept in `baseline-codex.json`); the two hosts are never compared or averaged
- A run is ineligible when a question called a tool other than sphica's recall and read that the trace does not show was refused before running, or had a call whose replay did not match. `judge.ts` recounts this from the saved traces, so rerunning a run until it avoids a tool is never the fix
- Compare 3 runs of each setup. A question is solved when at least 2 of 3 runs put its answer first. Adopt only with net solved +2 or more, mean top1 and judge direct not lower, turns up at most 20%, returned bytes up at most 30%, and no new errors (`server/evals/agentic/verdict.ts`)
- Match the host, model ID, CLI version (Claude Code or Codex), and effort across the runs you compare (aliases like `--model sonnet` and the default effort change between versions). The run records them, and the judge warns when they do not match
- Point `SPHICA_DB` at a fixed copy made with `vacuum into` (the runner refuses a DB with a pending WAL and records the copy's hash). A migrated copy carries `<db>.json` with the source snapshot hash
- `--ref` of an experiment runs that commit's build scripts on this machine. Pass only your own commits
- Run experiments with `bun run evals:experiment` (bundle from a git ref, pilot, 3 runs, judge, verdict, ledger in `~/.cache/sphica-evals/ledger.jsonl`). Setups whose conditions differ are ineligible, not compared
- `retrieval.json` and `features.json` are frozen. Rebuild them only when the DB no longer holds their answers, and remeasure the base after a rebuild
