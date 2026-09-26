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
  return runIn("/nonexistent", ...args);
}
function runIn(home: string, ...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home },
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

// A parser that skips unknown arguments would run the command as if the misspelled flag were not there.
test("unknown flags and commands fail before connecting to the database", () => {
  for (const bad of ["--avod", "--limitt", "--all-scopes"]) {
    const r = run("project", "list", bad);
    assert.notEqual(r.code, 0);
    assert.match(r.out, new RegExp(`Unknown flag: ${bad}`), `${bad}: ${r.out}`);
    assert.doesNotMatch(r.out, /No database at/, "tried to connect to the database");
  }
  // Removed commands (the terminal screen, and search, which MCP recall covers) fail like any unknown one
  for (const name of ["dashboard", "search"]) {
    const gone = run(name);
    assert.notEqual(gone.code, 0);
    assert.match(gone.out, new RegExp(`Unknown command: ${name}`), gone.out);
  }
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
    [["harvest", "list", "--avoid"], /Unknown flag: --avoid/],
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
  assert.match(run("harvest", "read", "--lmit", "3").out, /^sphica harvest read$/m);
  const flagValue = run("trace", "--cwd", "/nonexistent", "check");
  assert.match(flagValue.out, /^sphica$/m, flagValue.out);
  assert.doesNotMatch(flagValue.out, /^sphica.*nonexistent/m, "flag values never go into the title");
  // Closing and status lines start at the line start. Content is indented, so an injected newline cannot forge one
  for (const forged of [run("x\n✓ 直すものは無い"), run("x\n╰─ ✓ 直すものは無い")]) {
    assert.doesNotMatch(forged.out, /^(?:╰─ )?✓ 直すものは無い$/m, forged.out);
    assert.match(forged.out, /^✗ Stopped$/m, forged.out);
  }
});

test("no arguments and --help print usage for that level and succeed", () => {
  for (const args of [[], ["--help"], ["project", "--help"], ["db", "--help"]]) {
    const r = run(...args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.out}`);
    assert.match(r.out, /Usage:/, `${args.join(" ")}: ${r.out}`);
  }
  // Usage is built from the declarations. Check that command names show up there so no hand-copied text drifts.
  assert.match(run("--help").out, /^ {2}init {2}/m);
  assert.match(run("db", "--help").out, /^ {2}migrate {2}/m);
  assert.match(run("project", "--help").out, /^ {2}forget {2}/m);
});

// Usage lists only what people type. Commands for agents, hooks, and maintenance still run, and -H lists them
test("usage lists only init, doctor, and advice, and -H shows the rest", () => {
  const commands = (out: string) =>
    [...(out.split("Commands:")[1] ?? "").matchAll(/^ {2}(\S+) {2}/gm)].map((m) => m[1]);
  assert.deepEqual(commands(run("--help").out).sort(), ["advice", "doctor", "init"]);
  const all = commands(run("-H").out);
  for (const name of ["project", "harvest", "db", "trace", "capture"]) assert.ok(all.includes(name), name);
  // The bulk import and the people directory are gone, without aliases
  for (const name of ["who"]) assert.match(run(name).out, new RegExp(`Unknown command: ${name}`));
  assert.match(run("harvest", "--cwd", ".").out, /Unknown command: --cwd/);
  const db = run("db", "--help").out;
  for (const name of ["reindex", "terms"]) assert.doesNotMatch(db, new RegExp(`^ {2}${name} {2}`, "m"), name);
  assert.match(db, /^ {2}migrate {2}/m);
  assert.equal(run("trace", "--help").code, 0);
  // init registers the project now, so the old command is gone without an alias
  const add = run("project", "add");
  assert.notEqual(add.code, 0);
  assert.match(add.out, /Unknown command: add/, add.out);
});

test("trace check reads only a draft it issued, and validates the record without touching the database", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-cli-trace-"));
  try {
    const issue = () => {
      const out = runIn(home, "trace", "draft").out;
      const id = /^ {2}id: (\S+)$/m.exec(out)?.[1];
      const file = /^ {2}file: (.+)$/m.exec(out)?.[1];
      assert.ok(id && file, out);
      assert.ok(file.startsWith(path.join(home, ".sphica", "drafts")), file);
      return { id, file };
    };
    const bad = issue();
    fs.writeFileSync(
      bad.file,
      JSON.stringify({
        schema: "trace/1",
        session: { host: "claude-code", id: "s" },
        items: [{ key: "x", kind: "finding", at: "2026-09-13", text: "t" }],
      }),
    );
    const r = runIn(home, "trace", "check", bad.id);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /ISO 8601/);
    const ok = issue();
    fs.writeFileSync(
      ok.file,
      JSON.stringify({ schema: "trace/1", session: { host: "claude-code", id: "s" }, items: [] }),
    );
    assert.equal(runIn(home, "trace", "check", ok.id).code, 0);
    // A path, stdin, or an id it never issued is not read
    for (const arg of [ok.file, "-", "../../../etc", "AAAAAAAAAAAA"]) {
      const x = runIn(home, "trace", "check", arg);
      assert.equal(x.code, 1, `${arg}: ${x.out}`);
      assert.match(x.out, /Not a draft id|No draft/, x.out);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// A harvest record points only inside itself: the save command must not reach another pull request's or a session's records
test("harvest check validates the record and refuses references outside it, without touching the database", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-cli-harvest-"));
  try {
    // Writes the record to a fresh draft and returns its id
    const file = (_name: string, v: unknown) => {
      const out = runIn(dir, "harvest", "draft").out;
      const id = /^ {2}id: (\S+)$/m.exec(out)?.[1];
      const f = /^ {2}file: (.+)$/m.exec(out)?.[1];
      assert.ok(id && f, out);
      fs.writeFileSync(f, JSON.stringify(v));
      return id;
    };
    const decision = (over: object) => ({
      key: "d",
      kind: "decision",
      status: "accepted",
      at: "2026-09-13T10:00:00+09:00",
      text: "Keep one SQLite file",
      context: "The review asked why not Postgres",
      options: [{ text: "SQLite", chosen: true }],
      ...over,
    });
    const ok = runIn(
      dir,
      "harvest",
      "check",
      file("ok.json", { schema: "harvest/1", pr: 12, version: "0123456789ab", items: [decision({})] }),
    );
    assert.equal(ok.code, 0, ok.out);
    const outside = runIn(
      dir,
      "harvest",
      "check",
      file("outside.json", {
        schema: "harvest/1",
        pr: 12,
        version: "0123456789ab",
        items: [decision({ supersedes: "claude-code:s1#old" })],
      }),
    );
    assert.equal(outside.code, 1, outside.out);
    assert.match(outside.out, /outside this record/);
    const big = runIn(
      dir,
      "harvest",
      "check",
      file("big.json", {
        schema: "harvest/1",
        pr: 12,
        version: "0123456789ab",
        items: [decision({ text: "x".repeat(1024 * 1024) })],
      }),
    );
    assert.notEqual(big.code, 0);
    assert.match(big.out, /over the \d+-byte limit/);
    assert.doesNotMatch(`${ok.out}${outside.out}${big.out}`, /No database at/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
