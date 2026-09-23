# Security Policy

## Supported versions

Only the latest release published to npm under the `latest` tag receives security fixes.
Older versions do not get backports, so please upgrade before reporting.

## Reporting a vulnerability

**Do not open a public issue for a security report.** Use GitHub's private vulnerability reporting instead:

1. Open <https://github.com/iroha924/gleanery/security/advisories/new>.
2. Describe the problem, the affected version (`gleanery --version`), the steps to reproduce it, and the impact you observed.
3. Submit the form. Only the maintainer is notified.

gleanery is maintained by one person. Reports are handled on a best-effort basis. Issues that expose credentials, run commands, or compromise the published package are handled before any other work.
After a fix is released, a GitHub Security Advisory is published and the reporter is credited unless they ask not to be.

## Scope

In scope:

- The `gleanery` npm package: the CLI, the MCP server, and the recording hooks
- The Claude Code and Codex plugins published from this repository
- The release pipeline in `.github/workflows/`

Out of scope. Please report these to their own projects:

- Claude Code, Codex, Node.js, `git`, and the GitHub CLI
- The behavior of the model that reads gleanery's records

## What gleanery trusts

gleanery stores everything in one local SQLite file (`~/.gleanery/gleanery.db`) and does not run a network server.
Pull request and issue text imported by `gleanery harvest`, as well as recorded conversations, may have been written by someone else.
gleanery treats that text as data. The MCP server and the terminal dashboard open the database read-only.
A way to make gleanery write through those read-only paths, or to make recorded text act as instructions, is in scope.
