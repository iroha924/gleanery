# Starting the other model's lanes

Part of `/gleanery:review`. **Read this only when you decided to use the other model.**
**Do not assemble it by guesswork without reading**: this holds not just spellings but the flags whose removal widens permissions,
and the paths where failure looks like success. If you could not read it, mark those lanes `unable` and do not start them.

Where the aspect bodies live (`$R`) and which tools each aspect gets are decided in SKILL.md Step 3. Do not recount them here.

## Starting

| You are | Call the other with |
|---|---|
| **Claude** | `codex exec --ephemeral -s read-only --output-schema <schema> -o <out> -` |
| **Codex** | `claude -p --agents '<JSON>' --agent <name> --no-session-persistence --output-format json` |

**When calling Claude from Codex, put the aspect body into the `--agents` JSON.** The package ships no agent definitions,
so assemble it here, in the form `{"<name>":{"description":"...","prompt":"<aspect body>","tools":["Read","Grep","Glob"]}}`,
and select it with `--agent <name>`.

**Put in `tools` exactly what the SKILL.md table decides.** The 3 that need to run things (correctness, security, the validator)
get `Bash`; the rest do not. **Writes by a reviewer given `Bash` cannot be stopped** (measured: a reviewer with only `Read` and `Bash`
created `probe.txt`). With only `Read` / `Grep` / `Glob` there is no way to write (in the same measurement, nothing was created).

**Either way, pass the diff as a file.** Aspects without `Bash` cannot run `git`, and even for those with it,
the PR author decides the range, so do not have them assemble commands.

**Both pass the prompt file on stdin.** Write it in the form your host's shell accepts:
**`< file` is a syntax error in PowerShell, and on that host not a single lane starts.**

```bash
# POSIX
cat "$prompt_file" | claude -p --agents "$agents_json" --agent "$name" --no-session-persistence --output-format json
```

```powershell
# PowerShell
Get-Content -Raw -Encoding utf8 -LiteralPath $promptFile |
  & claude -p --agents $agentsJson --agent $name --no-session-persistence --output-format json
```

**Do not drop flags from the examples.** What gets copied is the example, not the explanation, and copying an example without
`--no-session-persistence` reopens, just there, the permission widening closed below.

**Do not use `codex exec review`.** It can set the range with `--base` and `--uncommitted`, but
**`--base` cannot be combined with a custom prompt** (measured 2026-09-09: `error: the argument
'--base <BRANCH>' cannot be used with '[PROMPT]'`). Passing a definition body rejects the range option,
so **to use a reviewer definition, call `codex exec` without `review`.**

**So write the range into the prompt.** Append the same "how to pass it" table as SKILL.md Step 3 to the end of the body.

**Failure returns exit 0.** Even on an argument error the background job finishes with 0, so
**always check that the output file exists.** Otherwise it reads as "the Codex side had 0 findings"
(measured: 2 lanes silently failed this way).

`--ephemeral` keeps no session. `-s read-only` stops writes.
`--output-schema` fixes the output shape. **Do not set the depth**: follow what the user chose.

**Assemble the `--agents` JSON every time.** The package ships no agent definitions, so pack the aspect body and
the tools the SKILL.md table decides here.

**Put what you pass on stdin, not in arguments.** The range contains branch and file names, and **the PR author decides them**.
Arguments show up in `ps` and have a length limit too.

| What to pass | Why |
|---|---|
| `--agents '<JSON>'` and `--agent <name>` | Passes the aspect body and `tools` on the spot. A name that does not exist goes to stderr and fails with **exit 1** |
| `--no-session-persistence` | Keeps no session on disk. **The point is that `--resume` becomes impossible afterwards** (below) |

**Do not pass `--model` or `--effort`.** Follow what the user chose.

**Do not use `deny` in `--settings` as a way to stop writes.** Only what is named is removed, and
**writes through MCP remain** (measured: a reviewer with `Edit` / `Write` / `Bash` denied
created `probe.txt` through Serena). What stops them is `tools` above.

**`--max-turns` does not exist in 2.1.278** (0 hits in `--help`). Detecting cutoffs relies on the `completion` line in Step 4.

**Do not use `--resume` on this path.** In one call, have it give the full list first, then the full text of every finding in number order.
**Write that at the end of the prompt**: the reviewers' default is "return full text only for what is requested", so
without it only the list comes back, and **there is no longer a way to ask for the rest.**

> This is the only call, and there is no way to ask for more. After giving the full list, continue in the same response with the full text of every finding in number order.

What this avoids is not truncated full text but **permission widening.** **If `--agent` is left out of a `--resume`,
the reviewer runs with `Edit` and `Write`** (measured: tools went from 2 to 51.
**There is no error and the context is kept, so the output gives no hint**). It happens on the second call, after the untrusted diff
has been read, and the package cannot close it with permissions. So instead of preventing the omission by care,
`--no-session-persistence` **never creates a resumable state**
(measured: `--resume` on the `session_id` returned by a call with this flag
fails with `No conversation found with session ID` and exit 1).

Lanes that were cut off are not collected; they go into the ledger as `cut short`.

**This form is only for when Codex is the host.** When Claude is the host, take the results in parts by number, as in Step 4.

**Start `codex exec` directly, disposable, one per lane.** A review is not a conversation; it needs independent, disposable, parallel runs.
Going through a mechanism that shares one log or session makes parallel lanes fight over it.

**Run the chosen other model's lanes every round.** Give both models the same aspects and the same range.
5 Codex lanes use 1.04 to 1.72 million tokens per round (measured 2026-09-13).
If a usage limit hits midway, follow "Rounds without independent confirmation" in SKILL.md.

**If Codex's sandbox has no network, `claude` can start but cannot reach the API.**
Measured (2026-09-21): `curl` could not resolve `api.anthropic.com` (exit 6), and `claude -p` returned
`Failed to authenticate: OAuth session expired and could not be refreshed`.
**It looks like a credentials problem but is a network block.** In that case do not silently drop lanes; follow the next section.

### Codex lanes take about 15 minutes. Do not kill them midway

**Measured (2026-09-09): a lane that completed took 15.5 minutes.** Deeper aspects take longer.

**Do not read `collab: Wait` as a sign it stopped.** Across 3 lanes on the same day, **the lane with the most `collab: Wait` (14)
completed**, and a lane with only 1 was killed while still running. There is no correlation.

**MCP authentication errors are not a sign it stopped either.** `AuthRequired` / `Transport channel closed` also appear in lanes that
completed (context7 in the measurement). `-c mcp_servers='{}'` does not remove them, but they do not need removing to complete.

**Have completion notified.** If you send lanes to the background one at a time, **what comes back is not a lane finishing but a lane starting.**
From then on the only way to know about completion is polling, and **"still running" and "finished and wrote the output" become indistinguishable.**
Put all lanes into one background job, and **have it return only when every lane completes** (`wait` on POSIX,
`Wait-Job` in PowerShell).

Measured (2026-09-21): because only the start was awaited, **3 lanes were reported "running"**
even after all 5 lanes had completed and written their output. Counting line growth and `pgrep` does not tell the moment of completion.

Judge progress by **whether the log's line count is growing.** If it stopped, the line count stops too.

**State in the prompt "do not write to files".** It runs with `-s read-only`, so
attempts to write repeat `patch rejected` and waste time (measured: 3 times without the statement, 0 with it).
