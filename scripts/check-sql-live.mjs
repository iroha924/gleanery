#!/usr/bin/env node
// Runs the shipped entry points (the CLI and the capture hook) as child processes against SQLite in a temp HOME, checking
// SQL, connection roles (the authorizer), and cleanup together.
//
// `sql:reach` runs functions that take a db as an argument from tests. The CLI opens its own connections, so tests have no seam to inject one.
// Starting it for real shows more than a seam would (role connections stop SQL outside their permissions).
//
// .claude/rules/verification.md explains why the child HOME points to a temp directory.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { coveredSites } from "./lib/coverage.mjs";
import { fakeGh, makeRepo, root, runCli, runHook, withTempDir } from "./lib/live-harness.mjs";
import { ALLOWED_UNREACHED, callSites, LIVE_FILES } from "./lib/sql-call-sites.mjs";

const failures = [];
const note = (what, r) => {
  if (r.timedOut) failures.push(`${what}: killed after timing out`);
  else if (r.status !== 0) failures.push(`${what}: exit ${r.status}\n${r.out.trim().slice(0, 600)}`);
  return r;
};

await withTempDir(async (dir) => {
  const covDir = path.join(dir, "coverage");
  fs.mkdirSync(covDir, { recursive: true });
  const repo = makeRepo(dir);
  fakeGh(dir);

  {
    // Outside any repository, so init only creates the database (from the repository root it would register this checkout too)
    note("init", runCli(["init", "--cwd", dir], dir, covDir));

    // ---- CLI: create, import, then delete, in that order ----
    // The repo has a remote, so no --name (the CLI would refuse it). The key becomes git:github.com/example/live.
    note("init (register)", runCli(["init", "--cwd", repo], dir, covDir));
    note("project list", runCli(["project", "list"], dir, covDir));
    // Document exclusions. add creates the connector, list reads with a join, and remove filters with a subquery.
    note("exclude add", runCli(["project", "exclude", "add", "--cwd", repo, "docs"], dir, covDir));
    const excluded = note("exclude list", runCli(["project", "exclude", "list", "--cwd", repo], dir, covDir));
    if (!/^\s+docs\s+directory$/m.test(excluded.out))
      failures.push(`exclude list does not show the added path\n${excluded.out.slice(0, 400)}`);
    note("exclude remove", runCli(["project", "exclude", "remove", "--cwd", repo, "docs"], dir, covDir));
    // **harvest only half succeeds here.** The project key comes from the remote spelling, so
    // a GitHub URL makes the document sync fetch the real remote, which is unreachable locally
    // (rewriting it locally with insteadOf also changes what `git remote get-url` returns, so the key stops being github).
    // Rather than ignoring this, check by the output text that the GitHub side succeeds and only the document side fails.
    const harvest = runCli(["harvest", "--cwd", repo], dir, covDir);
    if (!/GitHub: /.test(harvest.out))
      failures.push(`the GitHub side of harvest did not run\n${harvest.out.slice(0, 600)}`);
    if (!/Could not fetch the remote's default branch/.test(harvest.out)) {
      failures.push(
        `the document side of harvest fetched a remote that should be unreachable locally\n${harvest.out.slice(0, 600)}`,
      );
    }
    // Second round. There are fewer messages and issues than before, so the branches that delete removed messages and issues run here.
    const again = runCli(["harvest", "--cwd", repo], dir, covDir, { SPHICA_FAKE_GH_ROUND: "2" });
    if (!/GitHub: /.test(again.out))
      failures.push(`the second harvest did not go through GitHub\n${again.out.slice(0, 400)}`);
    if (!/(?:PRs and issues|PR or issue) \([^)]*(?<!\d)1 removed\)/.test(again.out))
      failures.push(`the second harvest did not delete the removed issue\n${again.out.slice(0, 400)}`);
    if (!/1 PR or issue \(1 rewritten/.test(again.out) || !/\d+ messages? \(0 rewritten/.test(again.out))
      failures.push(
        `the second harvest rewrote messages of a PR whose title alone changed\n${again.out.slice(0, 400)}`,
      );

    note("who (list)", runCli(["who"], dir, covDir));
    // english-exempt: Japanese record fixture sent through the real CLI and hook
    note("who (link)", runCli(["who", "--me", "私", "someone"], dir, covDir));

    // trace commands write to the cwd project and require the record's session to match the current host session.
    const asSession = (id) => ({ cwd: repo, CLAUDE_CODE_SESSION_ID: id });
    const trace = path.join(dir, "trace.json");
    fs.writeFileSync(
      trace,
      JSON.stringify({
        schema: "trace/1",
        session: { host: "claude-code", id: "live-1" },
        // english-exempt: Japanese record fixture sent through the real CLI and hook
        work: { key: "w-1", title: "検査", goal: "SQL を通す", current: "通している", status: "active" },
        items: [
          {
            key: "d-1",
            kind: "decision",
            status: "accepted",
            at: "2026-09-13T10:00:00+09:00",
            // english-exempt: Japanese record fixture sent through the real CLI and hook
            text: "実 DB で通す",
            // english-exempt: Japanese record fixture sent through the real CLI and hook
            context: "偽の db では権限が見えない",
            options: [
              // english-exempt: Japanese record fixture sent through the real CLI and hook
              { text: "実 DB", chosen: true },
              // english-exempt: Japanese record fixture sent through the real CLI and hook
              { text: "偽の db", chosen: false, why: "書き込みも受け付ける" },
            ],
            // english-exempt: Japanese record fixture sent through the real CLI and hook
            confirmation: "この検査が緑であること",
          },
        ],
      }),
    );
    note("trace check", runCli(["trace", "check", trace], dir, covDir, { cwd: repo }));
    // context reads the session's messages and existing decisions before a record is written. This is the only place its read SQL runs.
    note("trace context", runCli(["trace", "context"], dir, covDir, asSession("live-1")));
    note("trace save", runCli(["trace", "save", trace], dir, covDir, asSession("live-1")));
    // Run the set-taking branches with an empty set too. A bug once passed an empty array to in and produced `in ()`.
    const empty = path.join(dir, "empty.json");
    fs.writeFileSync(
      empty,
      JSON.stringify({ schema: "trace/1", session: { host: "claude-code", id: "live-2" }, items: [] }),
    );
    note("trace save (empty items)", runCli(["trace", "save", empty], dir, covDir, asSession("live-2")));

    // Capture. Queue through the hook, then flush. Flushing an empty queue returns 0 and never runs the write SQL.
    const turn = { session_id: "live-1", prompt_id: "p1", cwd: repo };
    const hook = (extra) => runHook({ ...turn, ...extra }, dir, covDir, asSession("live-1"));
    // english-exempt: Japanese record fixture sent through the real CLI and hook
    hook({ hook_event_name: "UserPromptSubmit", prompt: "実 DB で SQL を通す" });
    hook({
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: `${repo}/docs/design.md` },
    });
    // english-exempt: Japanese record fixture sent through the real CLI and hook
    hook({ hook_event_name: "Stop", last_assistant_message: "通した。" });
    note("capture flush", runCli(["capture", "flush"], dir, covDir, asSession("live-1")));

    // Records from an unregistered project are set aside, not dropped (#104). If the owner works on a new machine before
    // running init, those messages land here. Deleting them would lose them for good.
    const stranger = makeRepo(dir, "https://github.com/example/stranger.git", "stranger");
    const strangerTurn = { session_id: "live-3", prompt_id: "p9", cwd: stranger };
    const strangerAs = { cwd: stranger, CLAUDE_CODE_SESSION_ID: "live-3" };
    runHook(
      // english-exempt: Japanese record fixture sent through the real CLI and hook
      { ...strangerTurn, hook_event_name: "UserPromptSubmit", prompt: "未登録のプロジェクトでの発言" },
      dir,
      covDir,
      strangerAs,
    );
    runHook(
      // english-exempt: Japanese record fixture sent through the real CLI and hook
      { ...strangerTurn, hook_event_name: "Stop", last_assistant_message: "返した。" },
      dir,
      covDir,
      strangerAs,
    );
    const strayed = runCli(["capture", "flush"], dir, covDir, strangerAs);
    const kept = path.join(dir, ".sphica", "spool", "unregistered");
    const left = fs.existsSync(kept) ? fs.readdirSync(kept).filter((f) => f.endsWith(".json")) : [];
    if (left.length === 0) {
      failures.push(
        `records from the unregistered project are not in ${kept}. They may have been dropped\n${strayed.out.slice(0, 400)}`,
      );
    }

    // Set-aside records older than 30 days are pruned. Without the limit, using an unregistered project for long would fill the disk.
    const stale = path.join(kept, `${Date.now() - 40 * 24 * 60 * 60 * 1000}-0-stale.json`);
    fs.writeFileSync(stale, JSON.stringify({ v: 1, kind: "message", project: "git:example/none" }));

    // Registering the project brings the set-aside records in. Without this link, setting them aside would be pointless.
    note("init (set-aside project)", runCli(["init", "--cwd", stranger], dir, covDir));
    const retried = runCli(["capture", "flush"], dir, covDir, strangerAs);
    if (!/new messages\s+[1-9]/.test(retried.out)) {
      failures.push(`set-aside records were not stored after registering\n${retried.out.slice(0, 400)}`);
    }
    const after = fs.existsSync(kept) ? fs.readdirSync(kept).filter((f) => f.endsWith(".json")) : [];
    if (after.length) failures.push(`set-aside records remain after sending: ${after.join(" / ")}`);
    if (fs.existsSync(stale)) failures.push(`a set-aside record older than 30 days was not pruned: ${stale}`);
    // Do not rely on the doctor exit code. Plugin versions and install state depend on the local machine (such as an npm CLI that
    // differs from the working tree), so it can be 1 for reasons unrelated to this check. Check only the database rows by content.
    const doctor = runCli(["doctor"], dir, covDir);
    for (const [label, want] of [
      ["Schema version", /✓ Schema version\s+revision \d+/],
      ["Full-text index", /✓ Full-text index\s+healthy/],
      ["Projects", /Projects/],
    ]) {
      if (!want.test(doctor.out))
        failures.push(`doctor does not report ${label} as healthy\n${doctor.out.slice(0, 800)}`);
    }

    // ---- Control sequences from external text never reach the terminal ----
    // PR and issue bodies and titles, handles, conversations, remote spellings, and directory names are decided by third parties or outside factors.
    // First confirm that the injected value reached the output (reach), then check for no ESC, BEL, or CR (no color on a pipe)
    const controlled = (out) => ["\u001b", "\u0007", "\r"].some((c) => out.includes(c));
    const clean = (what, r, reach, { status = true } = {}) => {
      if (status) note(what, r);
      if (!r.out.includes(reach))
        failures.push(
          `the injected value (${reach}) did not reach the ${what} output, so the check would pass vacuously\n${r.out.slice(0, 400)}`,
        );
      if (controlled(r.out))
        failures.push(
          `control sequences remain in the ${what} output\n${JSON.stringify(r.out.slice(0, 400))}`,
        );
    };
    const esc = "\u001b[2J\u001b]0;pwn\u0007\r";
    // After linking with who --me, decisions are written from the owner's merged PR bodies (the fake gh marks the PR merged only in the hostile round)
    const decided = runCli(["harvest", "--cwd", repo], dir, covDir, { SPHICA_FAKE_GH_ROUND: "hostile" });
    if (!/PR decisions: [1-9]/.test(decided.out))
      failures.push(`harvest does not report PR decisions\n${decided.out.slice(0, 600)}`);
    clean("who (third-party handle)", runCli(["who"], dir, covDir), "someone");
    // english-exempt: Japanese record fixture sent through the real CLI and hook
    clean("who (link)", runCli(["who", "--me", "私", `someone${esc}`], dir, covDir), "someone");
    // english-exempt: Japanese record fixture sent through the real CLI and hook
    hook({ hook_event_name: "UserPromptSubmit", prompt: `制御列${esc}を含む発言` });
    // english-exempt: Japanese record fixture sent through the real CLI and hook
    hook({ hook_event_name: "Stop", last_assistant_message: `応答${esc}` });
    note("capture flush (control sequences)", runCli(["capture", "flush"], dir, covDir, asSession("live-1")));
    const context = runCli(["trace", "context"], dir, covDir, asSession("live-1"));
    // english-exempt: Japanese record fixture sent through the real CLI and hook
    clean("trace context", context, "を含む発言");
    // The agent reads trace context, so the owner's messages are headed "Owner", never "You" (which would read as the agent).
    if (!/^## Owner \(/m.test(context.out))
      failures.push(
        `trace context does not head the owner's messages with "## Owner"\n${context.out.slice(0, 400)}`,
      );
    const evil = makeRepo(dir, `https://github.com/example/ev${esc}il.git`, "evil\u001b[2Jdir");
    clean("init (remote and directory name)", runCli(["init", "--cwd", evil], dir, covDir), "evil");
    clean("project list", runCli(["project", "list"], dir, covDir), "example/ev");
    // The doctor exit code depends on the local plugin state, so it is not checked (same reason as above)
    clean("doctor", runCli(["doctor"], dir, covDir), "example/ev", { status: false });

    note(
      "project forget",
      runCli(["project", "forget", "git:github.com/example/live", "--yes"], dir, covDir),
    );
  }

  // ---- Count reach ----
  const sites = callSites(root).filter((s) => LIVE_FILES.some((f) => s.startsWith(`${f}:`)));
  const covered = coveredSites(covDir, root, sites);
  const missed = sites.filter((s) => !covered.has(s));

  if (missed.length) {
    const allowed = new Set(ALLOWED_UNREACHED.map((a) => a.site));
    const unexpected = missed.filter((s) => !allowed.has(s));
    if (unexpected.length) {
      failures.push(
        `some SQL does not run even against the real database.\n    ${unexpected.join("\n    ")}\n` +
          "  If it cannot be reached, add it with a reason to ALLOWED_UNREACHED in scripts/lib/sql-call-sites.mjs.",
      );
    }
  }
  for (const a of ALLOWED_UNREACHED) {
    if (covered.has(a.site)) failures.push(`${a.site}: now reached. Remove it from ALLOWED_UNREACHED`);
  }

  if (failures.length) {
    console.error(`${failures.length} failures in the real database lane.\n`);
    for (const f of failures) console.error(`  ${f}\n`);
    process.exit(1);
  }
  console.log(
    `real database: ran the CLI as a child process and ran ${covered.size} / ${sites.length} SQL sites`,
  );
});
