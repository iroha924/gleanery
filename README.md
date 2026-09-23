# gleanery

[![License](https://img.shields.io/github/license/iroha924/gleanery)](https://github.com/iroha924/gleanery/blob/main/LICENSE)
[![CI](https://github.com/iroha924/gleanery/actions/workflows/check.yml/badge.svg)](https://github.com/iroha924/gleanery/actions/workflows/check.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/iroha924/gleanery/badge)](https://scorecard.dev/viewer/?uri=github.com/iroha924/gleanery)
[![SLSA Build L2](https://img.shields.io/badge/SLSA-Build%20L2-green)](https://www.npmjs.com/package/gleanery#provenance)
[![Dependabot: GitHub Actions](https://img.shields.io/badge/Dependabot-GitHub%20Actions-025E8C?logo=dependabot)](https://github.com/iroha924/gleanery/blob/main/.github/dependabot.yml)

English | [日本語](https://github.com/iroha924/gleanery/blob/main/README.ja.md)

**Local memory of past decisions for Claude Code and Codex.**
gleanery records your coding sessions and the decisions made in them.
You or your agent can then look up what was decided, what was rejected, and why, before making the same call again.
The database is a single SQLite file on your machine.

> [!NOTE]
> The `gleanery` CLI, the terminal dashboard, and the plugin skills currently speak Japanese. Search works with both Japanese and English text.

## Features

- **Look things up while you work.** The MCP tools `recall` and `read` let Claude Code and Codex search past decisions, rejected options, constraints, dead ends, and what you or others said in earlier sessions.
- **Warnings before an edit (Claude Code).** Before the agent edits a file, a hook shows it the constraints recorded for that exact file and any technical debt that was deliberately left there.
- **Automatic session recording.** gleanery keeps your prompts, the agent's final reply for each turn, and the paths of files changed by the agent's edit tools.
- **Decision records on request.** `/gleanery:trace` saves the decisions, rejected options, constraints, and dead ends of a session, plus where the work stands.
- **Multi-perspective review.** `/gleanery:review` runs a separate reviewer for each focus: correctness, security, and written conventions by default, plus redundancy and past decisions with `full`. When Codex is installed, it offers to repeat the review with Codex.
- **Terminal dashboard.** `gleanery dashboard` browses sessions, work in progress, and search results. It is read-only.
- **GitHub and docs import.** `gleanery harvest` imports pull requests, issues, and the repository's Markdown files.

The agent is told to treat records as history, not instructions, and to trust the code when a record and the current code disagree.

## Requirements

- Node.js 24.15 or later
- Claude Code or Codex, or both
- `git`, to identify the repositories you register
- For `gleanery harvest` only: the GitHub CLI (`gh`), signed in with `gh auth login`

## Install

The plugin ships the MCP server, hooks, and skills. The `gleanery` CLI comes from npm and is installed separately. You need both.

**1. Install the CLI**

```bash
npm i -g gleanery
```

**2. Add the plugin**

Claude Code:

```bash
claude plugin marketplace add iroha924/gleanery
claude plugin install gleanery@gleanery
```

Codex:

```bash
codex plugin marketplace add iroha924/gleanery --ref main
codex plugin add gleanery@gleanery
```

In Codex, open `/hooks` and mark gleanery's hooks as trusted. Nothing is recorded until you do. If a plugin update changes the hooks, trust them again.

**3. Create the database**

```bash
gleanery init
```

This creates `~/.gleanery/gleanery.db`. Running it again leaves an existing database untouched.

**4. Check the setup**

```bash
gleanery doctor
```

`doctor` checks Node.js, the CLI and plugin versions, the database, and the recording queue. Start here whenever something looks wrong.

## Quick start

gleanery writes sessions to the database only for repositories you register. A registered repository is called a project.

```bash
cd ~/Projects/your-repo
gleanery project add
```

If the repository has no `origin` remote, give it a name: `gleanery project add --name <name>`.

Then work as usual in Claude Code or Codex. To bring back earlier decisions, ask the agent:

- "Did we already decide how to handle retries here?"
- "Why did we choose this approach?"
- "What did I say about the migration last week?"
- "Let's continue where we left off."

The agent searches with `recall` and opens full records with `read`. At the end of a session with decisions worth keeping, run `/gleanery:trace`.

To import GitHub history and Markdown docs:

```bash
gleanery harvest              # every project gleanery can find on this machine
gleanery harvest --cwd .      # only the current repository
```

Without `--cwd`, gleanery looks for projects directly under `~/Projects` and for projects registered with `--name`. Use `--cwd` for a repository somewhere else.
Docs are read from the default branch of `origin`, or from the local `HEAD` when there is no `origin`.

To browse everything in the terminal:

```bash
gleanery dashboard   # Tab switches screens, / searches, p changes project, q quits
```

## What gets recorded and where it goes

- **Where.** The database is `~/.gleanery/gleanery.db`. Records wait in a local queue, `~/.gleanery/spool`, until they are written to it. Each machine has its own database, and records are not shared between machines.
- **What.** Your prompts, the agent's final reply for each turn, and the paths of edited files. Background-task notifications and messages from other agents are skipped when gleanery recognizes their format.
- **Unregistered repositories.** Sessions in a repository you have not registered stay in the queue. They are written to the database after you register the repository. Held records are dropped after 30 days, and when more than 1,000 are waiting the oldest go first.
- **Secrets.** Only secrets with a recognizable shape are masked:
  - keys with known prefixes
  - `KEY=…` and `"password": …` assignments
  - credentials in URLs
  - authorization headers
  - `mysql -p`

  **Anything else is stored as typed, so do not paste secrets into a session.**
- **Network.** gleanery has no account, no hosted service, and no telemetry, and makes no network connections itself. Two commands call other tools that may: `gleanery harvest` runs `git fetch` and `gh api` with your credentials, and `gleanery doctor` runs `npm` and `claude` to check installed versions.
- **Text written by others.** Pull request and issue text imported by `harvest` may come from anyone. It is passed to the agent as data, and the MCP server cannot write to the database.

To delete a project's data, run `gleanery project forget <name>`, where `<name>` is shown by `gleanery project list`. Without `--yes`, it only shows how many records would be deleted. It deletes records in the database only. Records still waiting in `~/.gleanery/spool` stay there and can be imported again if you register the repository again.

Before you stop using a machine, run `gleanery capture flush` until `gleanery doctor` shows no records waiting to be sent. Each run writes up to 500 records. Records from unregistered repositories are not written, so register those repositories first if you want to keep them.

## Updating

The CLI and the plugin are updated separately.

```bash
npm i -g gleanery@latest
```

Claude Code:

```bash
claude plugin marketplace update gleanery
claude plugin update gleanery@gleanery
```

Codex:

```bash
codex plugin marketplace upgrade gleanery
codex plugin add gleanery@gleanery
```

Restart open sessions afterwards. When a release changes the database schema, the CLI asks you to run `gleanery db migrate`. Back up `~/.gleanery/gleanery.db` before you run it.

## Uninstalling

```bash
npm uninstall -g gleanery
```

Claude Code:

```bash
claude plugin uninstall gleanery@gleanery
```

Codex:

```bash
codex plugin remove gleanery@gleanery
```

Your records stay in `~/.gleanery/` until you delete that directory yourself.

## Troubleshooting

Run `gleanery doctor` first. It shows which part is out of date or not working. Common cases:

- **`gleanery: command not found`.** The plugin does not put the CLI on your PATH. Run `npm i -g gleanery`.
- **Nothing is recorded.** Check that the repository is registered with `gleanery project list`. In Codex, also check that the hooks are trusted in `/hooks`.
- **The MCP server reports an older version.** Restart the session, or run `/reload-plugins` in Claude Code.
- **A search finds nothing.** Search matches words. Try other words, English and Japanese, or shorter terms. An empty result doesn't mean nothing was recorded.

## Commands

| Command | What it does |
|---|---|
| `gleanery init` | Create the database |
| `gleanery doctor` | Check versions, the database, and recording |
| `gleanery project add` | Register the current repository as a project |
| `gleanery harvest` | Import GitHub pull requests, issues, and Markdown docs |
| `gleanery search <words>` | Search from the terminal |
| `gleanery dashboard` | Browse sessions, work, and search results |

Run `gleanery --help` for the full list and `gleanery <command> --help` for each command's options.

## Security

Report vulnerabilities privately as described in [SECURITY.md](https://github.com/iroha924/gleanery/blob/main/SECURITY.md).

Since 0.37.1, each release is built by GitHub Actions from a tag on the head of a pull request whose CI has passed, and staged on npm.
The maintainer checks its SHA-512 checksum and provenance, then approves publication with two-factor authentication.
For these versions, the [npm page](https://www.npmjs.com/package/gleanery#provenance) links to the workflow and the commit each one was built from.

Dependabot opens pull requests to update the GitHub Actions used in CI. It does not cover the npm dependencies bundled into the package, because Dependabot cannot read the Bun lockfile format (v2) this repository uses.

## Contributing

Issues are welcome. Pull requests from outside contributors are closed without review, because the review tools here run with maintainer credentials and cannot safely check out code written by others.

## License

[MIT](https://github.com/iroha924/gleanery/blob/main/LICENSE). The published package bundles its dependencies. Their licenses are listed in `THIRD_PARTY_NOTICES.md` inside the package.
