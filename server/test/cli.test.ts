import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

/** Runs without a database or credentials. Only argument parsing and checks before connecting matter here. */
function run(...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent" },
      // Keep a hanging regression from stalling the test run (--test-timeout does not apply to sync calls).
      timeout: 30_000,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; code?: string };
    // A timeout fails even after the expected output (so the exit code comparison cannot hide a hang).
    if (err.code === "ETIMEDOUT") throw new Error(`sphica ${args.join(" ")} did not finish in 30 seconds`);
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

// A parser that skips unknown arguments succeeds on --avod without filtering,
// which inverts the answer to "was this rejected before?".
test("unknown flags and commands fail before connecting to the database", () => {
  for (const bad of ["--avod", "--limitt", "--all-scopes"]) {
    const r = run("search", "認証", bad);
    assert.notEqual(r.code, 0);
    assert.match(r.out, new RegExp(`Unknown flag: ${bad}`), `${bad}: ${r.out}`);
    assert.doesNotMatch(r.out, /No database at/, "tried to connect to the database");
  }
  // The terminal screen is gone; the old command name must fail like any unknown one
  const gone = run("dashboard");
  assert.notEqual(gone.code, 0);
  assert.match(gone.out, /Unknown command: dashboard/, gone.out);
  const r = run("frobnicate");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Unknown command: frobnicate/);
  assert.doesNotMatch(r.out, /No database at/, "tried to connect to the database");
});

// A flag table shared by all commands silently accepts flags a command ignores.
// The results then come back without the intended filter, and the user cannot tell.
test("flags the command does not take and extra positional arguments fail by name", () => {
  for (const [args, want] of [
    [["doctor", "--yes"], /Unknown flag: --yes/],
    [["project", "list", "--reset-docs"], /Unknown flag: --reset-docs/],
    [["harvest", "--avoid"], /Unknown flag: --avoid/],
    [["project", "list", "garbage"], /Extra argument: garbage/],
  ] as const) {
    const r = run(...args);
    assert.notEqual(r.code, 0, `sphica ${args.join(" ")}: ${r.out}`);
    assert.match(r.out, want, r.out);
    assert.doesNotMatch(r.out, /No database at/, `sphica ${args.join(" ")} tried to connect to the database`);
  }
});

// If typed arguments went into the error title, a newline in an argument could forge a marked line.
test("the error title uses only the command path the dispatcher chose", () => {
  assert.match(run("trace", "check").out, /^sphica trace check$/m);
  assert.match(
    run("trace", "check", "--limit", "0", "f").out,
    /^sphica trace check$/m,
    "shows the subcommand even when parsing fails",
  );
  assert.match(run("search", "--lmit", "3", "認証").out, /^sphica search$/m);
  const flagValue = run("trace", "--cwd", "/nonexistent", "check");
  assert.match(flagValue.out, /^sphica$/m, flagValue.out);
  assert.doesNotMatch(flagValue.out, /^sphica.*nonexistent/m, "flag values never go into the title");
  // Closing and status lines start at the line start. Content is indented, so an injected newline cannot forge one
  for (const forged of [run("x\n✓ 直すものは無い"), run("x\n╰─ ✓ 直すものは無い")]) {
    assert.doesNotMatch(forged.out, /^(?:╰─ )?✓ 直すものは無い$/m, forged.out);
    assert.match(forged.out, /^✗ Stopped$/m, forged.out);
  }
});

test("--limit accepts only integers from 1 to 20", () => {
  for (const v of ["abc", "0", "21", "1.5", "-1"]) {
    const r = run("search", "認証", `--limit=${v}`);
    assert.match(r.out, /--limit must be an integer from 1 to 20/, `${v}: ${r.out}`);
  }
  assert.match(
    run("search", "認証", "--limit", "abc").out,
    /--limit must be/,
    "also parses the --name value form",
  );
});

test("no arguments and --help print usage for that level and succeed", () => {
  for (const args of [[], ["--help"], ["project", "--help"], ["db", "--help"]]) {
    const r = run(...args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.out}`);
    assert.match(r.out, /Usage:/, `${args.join(" ")}: ${r.out}`);
  }
  // Usage is built from the declarations. Check that command names show up there so no hand-copied text drifts.
  assert.match(run("--help").out, /^ {2}db {2}/m);
  assert.match(run("db", "--help").out, /^ {2}migrate {2}/m);
  assert.match(run("project", "--help").out, /^ {2}forget {2}/m);
});

test("trace check validates the record shape without touching the database", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-cli-trace-"));
  try {
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(
      bad,
      JSON.stringify({
        schema: "trace/1",
        session: { host: "claude-code", id: "s" },
        items: [{ key: "x", kind: "finding", at: "2026-09-13", text: "t" }],
      }),
    );
    const r = run("trace", "check", bad);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /ISO 8601/);
    const ok = path.join(dir, "ok.json");
    fs.writeFileSync(
      ok,
      JSON.stringify({ schema: "trace/1", session: { host: "claude-code", id: "s" }, items: [] }),
    );
    assert.equal(run("trace", "check", ok).code, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
