#!/usr/bin/env node
// The sphica CLI. Imports, trace, and directory writes use the ingest connection; searches use the reader connection (sqlite.ts, db-write.ts).
//
// Argument parsing is left to @stricli/core. **Each command declares the flags and positional arguments it accepts**, so
// another command's flag (`sphica doctor --yes`) or an extra positional argument (`sphica project list garbage`)
// fails at parse time. Usage text is built from these declarations and never written separately.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ApplicationText,
  ArgumentScannerError,
  buildApplication,
  buildCommand,
  buildRouteMap,
  type CommandInfo,
  formatMessageForArgumentScannerError,
  help,
  run,
  text_en,
  version,
} from "@stricli/core";
import { type Kysely, sql } from "kysely";
import { jsonArrayFrom } from "kysely/helpers/sqlite";
import { dbInit, importTerms, inspect, listTerms, migrate, reindex } from "./admin.ts";
import { flush, readState, rejectedDir, unregisteredDir } from "./capture.ts";
import {
  type Block,
  type Card,
  closing,
  document,
  failure,
  indent,
  panel,
  section,
  steps,
  title,
} from "./cli/view.ts";
import { dbFile, inTransaction, openReader, type Role, SCHEMA_REVISION } from "./db.ts";
import type { DB } from "./db-types.ts";
import { openWriter } from "./db-write.ts";
import { syncDocs } from "./docs.ts";
import { syncGithub } from "./github.ts";
import { conversationId } from "./knowledge.ts";
import { moveProject } from "./move.ts";
import { inline, type Mark, mark, pad, plain, width } from "./panel.ts";
import { observe, packageVersionAt, ROOT, report, UPDATE_NOTE } from "./plugin.ts";
import {
  connectorOf,
  identify,
  localRoots,
  nameLocal,
  type Place,
  projectId,
  relativeTo,
} from "./project.ts";
import {
  directory,
  framed,
  type Hit,
  openWork,
  renderHits,
  renderWork,
  searchMessages,
  searchSplit,
  workDetail,
} from "./search.ts";
import { requireRuntime } from "./sqlite.ts";
import { ftsQuery, head, plural, reason } from "./text.ts";
import { checkTrace, saveTrace } from "./trace.ts";

/**
 * Heading of the error box. **Built only from the route name routing chose** (never from the typed arguments).
 * It is decided before argument parsing, so even a misspelled flag reports the subcommand.
 */
let heading = "sphica";

/** The block printed on failure. The body is indented, so newlines smuggled into arguments cannot forge a closing line at column 0 (cli/view.ts). */
const failed = (body: string): string => failure(heading, plain(body));

/** Messages for argument parsing failures. Names what is wrong for each kind of stricli error. */
const describeScannerError = (e: ArgumentScannerError): string =>
  formatMessageForArgumentScannerError(e, {
    FlagNotFoundError: (x) =>
      `Unknown flag: --${inline(x.input)}${x.corrections.length ? ` (did you mean ${x.corrections.map((c) => `--${c}`).join(" / ")}?)` : ""}`,
    AliasNotFoundError: (x) => `Unknown short flag: -${inline(x.input)}`,
    // This cannot tell flags from positional arguments, so **the message thrown by parse names itself**.
    ArgumentParseError: (x) => reason(x.exception),
    EnumValidationError: (x) =>
      `--${x.externalFlagName} must be ${x.values.join(" or ")}: ${inline(x.input)}`,
    UnexpectedFlagError: (x) => `--${x.externalFlagName} can be given only once: ${inline(x.input)}`,
    UnexpectedPositionalError: (x) =>
      `Extra argument: ${inline(x.input)} (this command takes ${x.expectedCount})`,
    UnsatisfiedFlagError: (x) => `--${x.externalFlagName} needs a value`,
    UnsatisfiedPositionalError: (x) => `Specify ${x.placeholder}`,
    InvalidNegatedFlagSyntaxError: (x) => `--no-${x.externalFlagName} takes no value`,
  });

/** Usage and failure text. Only stricli's text is overridden here; its layout is not rebuilt. */
const TEXT: ApplicationText = {
  ...text_en,
  headers: {
    usage: "Usage:",
    aliases: "Aliases:",
    commands: "Commands:",
    flags: "Flags:",
    arguments: "Arguments:",
  },
  keywords: { default: "default =", separator: "separator =" },
  briefs: {
    help: "Show usage",
    helpAll: "Show usage including hidden commands and flags",
    version: "Show this CLI's version and location",
    argumentEscapeSequence: "Treat everything after this as arguments",
  },
  noCommandRegisteredForInput: ({ input, corrections }) =>
    failed(
      `Unknown command: ${inline(input)}${corrections.length ? ` (did you mean ${corrections.join(" / ")}?)` : ""}\n\nRun --help for usage`,
    ),
  exceptionWhileParsingArguments: (e) =>
    failed(e instanceof ArgumentScannerError ? describeScannerError(e) : reason(e)),
  exceptionWhileRunningCommand: (e) => failed(reason(e)),
  commandErrorResult: (e) => failed(e.message),
};

async function withDb<T>(role: Exclude<Role, "owner">, fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const db = role === "reader" ? openReader() : openWriter(role);
  try {
    return await fn(db);
  } finally {
    await db.destroy().catch(() => {});
  }
}

function placeOf(cwd: string): Place {
  const place = identify(cwd);
  if (!place) {
    throw new Error(
      `${cwd} has no git remote and no name. Name it with \`sphica project add --name <name>\``,
    );
  }
  return place;
}

async function registered(db: Kysely<DB>, place: Place): Promise<number> {
  const id = await projectId(db, place.key);
  if (id === null)
    throw new Error(`${place.name} is not registered with Sphica. Register it with \`sphica project add\``);
  return id;
}

/**
 * Turns one search hit into an item a person reads in a terminal: a Badge colored by kind, the start of the text, and sources dimmed on two uncut lines.
 * When scoped to one project, the heading shows it, so the project is left out of the sources
 */
function hitCard(x: Hit, scoped: boolean): Card {
  // A document section's title is its heading (path and section). A decision record's heading is the work title, same as its source, so the first line of the text is the title
  const [first = "", ...rest] = plain(x.text).split("\n");
  const doc = x.kind === "document" && x.heading !== null;
  const title = doc ? plain(x.heading ?? "") : first;
  const body = [
    head((doc ? [first, ...rest] : rest).join("\n").trim(), 600),
    x.reason ? `Reason: ${plain(x.reason)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    badge: x.label.replace(/^\[|\]$/g, ""),
    title,
    ...(body ? { body } : {}),
    // Line 1: the reference (for read), the time, and the speaker. Line 2: the source title (work, PR, issue)
    meta: [
      [x.ref, x.at.toLocaleString("sv-SE").slice(0, 16), x.speaker, scoped ? null : x.project]
        .filter(Boolean)
        .map((v) => plain(String(v)))
        .join(" · "),
      ...(x.context ? [plain(x.context)] : []),
    ],
  };
}

/** Reads a trace record. `-` is stdin (the Skill passes it without creating a file). */
const readTrace = (file: string): unknown => JSON.parse(fs.readFileSync(file === "-" ? 0 : file, "utf8"));

const githubRepo = (key: string): string | null =>
  key.match(/^git:github\.com\/([^/]+\/[^/]+)$/)?.[1] ?? null;

/**
 * Syncs one project. **GitHub and documents are independent**, so one failing does not stop the other.
 * Failures are stored in the source's last_error (doctor shows it) and thrown together at the end.
 */
async function syncOne(db: Kysely<DB>, id: number, place: Place, resetDocs = false): Promise<string[]> {
  const out: string[] = [];
  const failures: string[] = [];
  const one = async (provider: "github" | "docs", label: string, fn: () => Promise<string>) => {
    try {
      out.push(`${label}: ${await fn()}`);
    } catch (e) {
      const message = reason(e);
      await db
        .updateTable("connector")
        .set({ last_error: message.slice(0, 500) })
        .where("project_id", "=", id)
        .where("provider", "=", provider)
        .execute()
        .catch(() => {});
      failures.push(`${place.name} ${provider}: ${message}`);
    }
  };
  const repo = githubRepo(place.key);
  if (repo) await one("github", "GitHub", () => syncGithub(db, id, repo));
  if (fs.existsSync(path.join(place.root, ".git")))
    await one("docs", "Docs", () =>
      syncDocs(db, id, place.root, { remote: place.key.startsWith("git:"), reset: resetDocs }),
    );
  if (failures.length) throw new Error([...out, ...failures].join("\n  "));
  return out;
}

type Host = "claude-code" | "codex";
const HOSTS: Host[] = ["claude-code", "codex"];
const SESSION_ENV: Record<Host, string[]> = {
  "claude-code": ["CLAUDE_CODE_SESSION_ID"],
  codex: ["CODEX_THREAD_ID", "CODEX_SESSION_ID"],
};

/**
 * The current session. **When both hosts' ids are in the environment, it does not choose** (Codex started from Claude Code's Bash
 * inherits CLAUDE_CODE_SESSION_ID. Taking whichever comes first would read and write another host's session).
 */
function hostSession(host?: Host): { host: Host; id: string } {
  const found = HOSTS.flatMap((h) => {
    const id = SESSION_ENV[h].map((k) => process.env[k]).find(Boolean);
    return id && (!host || h === host) ? [{ host: h, id }] : [];
  });
  if (found.length === 1 && found[0]) return found[0];
  if (found.length > 1)
    throw new Error(
      "Both Claude Code and Codex sessions are in the environment. Name your host with --host claude-code or --host codex",
    );
  throw new Error(
    host
      ? `No ${host} session id in the environment (${SESSION_ENV[host].join(" / ")})`
      : "Cannot tell the current session id (run this inside Claude Code or Codex)",
  );
}

async function traceContext(cwd: string, host?: Host): Promise<string> {
  const session = hostSession(host);
  // Send what is left in the queue first. Continue even if it cannot be sent (the conversation can be written from your own context).
  await flush().catch(() => {});
  const place = placeOf(cwd);
  return withDb("reader", async (db) => {
    const id = await registered(db, place);
    const conversation = conversationId(id, session.host, session.id);
    const messages = await db
      .selectFrom("message as m")
      .select((eb) => [
        "m.speaker_kind",
        "m.body",
        "m.sent_at",
        "m.truncated",
        jsonArrayFrom(
          eb
            .selectFrom("message_file as f")
            .select("f.path")
            .whereRef("f.message_id", "=", "m.id")
            .orderBy("f.path"),
        ).as("paths"),
      ])
      .where("m.conversation_id", "=", conversation)
      .orderBy("m.sent_at")
      .orderBy("m.seq")
      .execute();
    const mine = await db
      .selectFrom("knowledge")
      .select(["source_key", "kind", "status", "body"])
      .where("conversation_id", "=", conversation)
      .where("kind", "<>", "option")
      .orderBy("occurred_at")
      .orderBy("id")
      .execute();
    const works = await openWork(db, [id], 5);
    const detail =
      works.length === 1 && works[0] ? await workDetail(db, Number(works[0].ref.slice(2)), null) : null;
    const workKeys = await db
      .selectFrom("work_item")
      .select(["source_key", "title", "status"])
      .where("project_id", "=", id)
      .where("status", "in", ["active", "blocked", "paused"])
      .orderBy("updated_at", "desc")
      .execute();
    const decisions = await db
      .selectFrom("knowledge as k")
      .innerJoin("work_item as w", "w.id", "k.work_item_id")
      .select(["k.source_key", "k.status", "k.body"])
      .where("k.project_id", "=", id)
      .where("k.kind", "=", "decision")
      .where("w.status", "in", ["active", "blocked", "paused"])
      .orderBy("k.occurred_at", "desc")
      .orderBy("k.id", "desc")
      .limit(30)
      .execute();
    // The owner's messages are shown longer and AI responses only in brief (decisions are in the owner's messages; AI responses surround them).
    // The agent reads this, so the owner is "Owner", never "You".
    const said = messages.map(
      (m) =>
        `## ${m.speaker_kind === "self" ? "Owner" : "AI"} (${m.sent_at})${m.truncated ? " (partly saved)" : ""}\n` +
        `${head(m.body, m.speaker_kind === "self" ? 4000 : 800)}${m.paths.length ? `\nFiles touched after this message: ${m.paths.map((p) => p.path).join(" / ")}` : ""}`,
    );
    const edited = [...new Set(messages.flatMap((m) => m.paths.map((p) => p.path)))];
    return [
      `session: ${session.host} ${session.id} (project ${place.name})`,
      messages.length
        ? `\n# Conversation in this session (recorded)\n\n${said.join("\n\n")}`
        : "\n# Conversation in this session\n\nNot recorded yet. Write from your own context.",
      edited.length ? `\n# Files touched in this session\n\n${edited.map((p) => `- ${p}`).join("\n")}` : null,
      mine.length
        ? `\n# Elements already recorded in this session (the same key overwrites)\n\n${mine.map((k) => `- ${k.source_key.split("#")[1]} (${k.kind}${k.status ? ` / ${k.status}` : ""}) ${head(k.body, 200)}`).join("\n")}`
        : null,
      workKeys.length
        ? `\n# Work in progress (the same key in work.key updates it)\n\n${workKeys.map((w) => `- ${w.source_key}: ${w.title} (${w.status})`).join("\n")}`
        : "\n# Work in progress\n\nNone.",
      detail ? `\n${renderWork(detail, 6000).text}` : null,
      decisions.length
        ? `\n# Decisions of work in progress (to supersede one, put its key in supersedes)\n\n${decisions.map((d) => `- ${d.source_key} (${d.status}) ${head(d.body, 200)}`).join("\n")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
  });
}

async function doctor(cwd: string): Promise<void> {
  const issues: string[] = [];
  const count = (m: Mark, label: string) => {
    if (m === "warn" || m === "fail") issues.push(label);
    if (m === "fail") process.exitCode = 1;
  };
  const say = (m: Mark, label: string, text: string) => {
    count(m, label);
    console.log(indent(`  ${mark(m)} ${pad(label, 26)}${text}`));
  };
  console.log(title("sphica doctor"));
  // Print before the database. Version drift should be visible regardless of the database.
  const plugin = report(observe(identify(cwd)?.root ?? cwd));
  issues.push(...plugin.issues);
  // Lines at column 0 are section headings; indented lines are their contents (the shape plugin.ts report builds)
  for (const line of plugin.lines) console.log(/^\S/.test(line) ? section(line) : indent(line));
  if (plugin.updates.length) console.log(steps("To update", plugin.updates, UPDATE_NOTE));
  console.log(section("DB", true));
  let runtime = true;
  try {
    requireRuntime();
    say("ok", "Node", process.version);
  } catch (e) {
    runtime = false;
    say("fail", "Node", plain(reason(e)));
  }
  const file = dbFile();
  let usable = false;
  if (!runtime) say("none", "DB", "cannot check until Node is upgraded");
  else if (!fs.existsSync(file)) say("fail", "DB", `missing (${file}). Create it with sphica init`);
  else {
    try {
      const x = inspect(file);
      usable = x.revision === SCHEMA_REVISION;
      say("ok", "DB", `${file} (${(x.bytes / 1024 / 1024).toFixed(1)} MB)`);
      say(
        usable ? "ok" : "fail",
        "Schema version",
        usable
          ? `revision ${x.revision}`
          : `revision ${x.revision}, this Sphica expects ${SCHEMA_REVISION} (${x.revision < SCHEMA_REVISION ? "run sphica db migrate" : "update sphica"})`,
      );
      const broken = Object.entries(x.fts).filter(([, v]) => v !== null);
      say(
        broken.length ? "fail" : "ok",
        "Full-text index",
        broken.length
          ? `broken: ${broken.map(([k, v]) => `${k} (${plain(v ?? "")})`).join(" / ")}. Rebuild it with sphica db reindex`
          : "healthy",
      );
    } catch (e) {
      say("fail", "DB", `cannot read: ${plain(reason(e))}`);
    }
  }
  const s = readState();
  say(
    s.stuck ? "fail" : s.rejected ? "warn" : "ok",
    "Recording",
    `${s.pending} pending${s.flushedAt ? ` / last sent ${new Date(s.flushedAt).toLocaleString("sv-SE")}` : ""}${
      s.stuck ? ` / failed: ${plain(s.stuck)}` : ""
    }${s.unregistered ? ` / ${s.unregistered} set aside for unregistered projects (${unregisteredDir()})` : ""}${
      s.rejected ? ` / ${s.rejected} rejected by the database (${rejectedDir()})` : ""
    }`,
  );
  if (usable) {
    try {
      await withDb("reader", async (db) => {
        const { found } = localRoots();
        const rows = await db
          .selectFrom("project as p")
          .leftJoin("connector as cn", "cn.project_id", "p.id")
          .select(["p.key", "p.name", "cn.provider", "cn.last_success_at", "cn.last_error"])
          .orderBy("p.name")
          .orderBy("cn.provider")
          .execute();
        if (rows.length) console.log(section("Projects", true));
        const label = (x: (typeof rows)[number]) => `${inline(x.name)} ${x.provider ?? "not synced"}`;
        const column = Math.max(...rows.map((x) => width(label(x)))) + 2;
        for (const x of rows) {
          // Imports run only when sphica harvest is run. Gaps are normal, so only failures count as things to fix.
          const m: Mark = x.last_error ? "fail" : x.provider === null || !x.last_success_at ? "none" : "ok";
          count(m, `project ${label(x)}`);
          const where = found.get(x.key) ? "" : " (not on this machine)";
          console.log(
            indent(
              `  ${mark(m)} ${pad(label(x), column)}${
                x.last_success_at
                  ? `last import ${new Date(x.last_success_at).toLocaleString("sv-SE")}`
                  : "not imported yet"
              }${x.last_error ? ` / failed: ${plain(x.last_error)}` : ""}${where}`,
            ),
          );
        }
      });
    } catch (e) {
      say("fail", "DB", `cannot read: ${plain(reason(e))}`);
    }
  }
  // Count by rows, not unique names (multiple Codex caches or projects with the same name still count separately).
  console.log(
    `${closing(
      `${mark(issues.length ? "warn" : "ok")} ${
        issues.length
          ? `${issues.length} to fix: ${[...new Set(issues)]
              .map((name) => {
                const n = issues.filter((x) => x === name).length;
                return n > 1 ? `${name} ×${n}` : name;
              })
              .join(" / ")}`
          : "nothing to fix"
      }`,
    )}`,
  );
}

/** `--cwd` means the same in every command. Defaults to the current directory. */
const CWD = {
  kind: "parsed",
  parse: String,
  brief: "The project directory (defaults to the current directory)",
  placeholder: "dir",
  optional: true,
} as const;

// MCP limits it to 1-10. The CLI people read allows up to 20. Negative values and 0 never reach the SQL limit.
function limitOf(input: string): number {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1 || n > 20)
    throw new Error(`--limit must be an integer from 1 to 20: ${input}`);
  return n;
}

/** A path to exclude, and whether it is a file or directory. A path not in the working tree is rejected as a typo. */
function excludeTarget(
  cwd: string,
  target: string,
): { place: Place; kind: "file" | "directory"; rel: string } {
  const place = placeOf(cwd);
  const rel = relativeTo(place.root, target, cwd);
  if (!rel) throw new Error(`${target} is not inside ${place.name} (${place.root})`);
  // Symlinks are not followed. In the commit tree they are one entry and are not read as text even when they point to a directory.
  const st = fs.lstatSync(path.join(place.root, rel), { throwIfNoEntry: false });
  if (!st) throw new Error(`${rel} is not in the working tree`);
  return { place, kind: st.isDirectory() ? "directory" : "file", rel };
}

const excludeRoutes = buildRouteMap({
  docs: {
    brief: "Paths the document sync does not import",
    fullDescription:
      "Not every tracked Markdown file states facts (audit fixtures, fill-in templates). Excluded files and their sections are removed on the next sync.",
  },
  routes: {
    add: buildCommand({
      docs: { brief: "Exclude a path (file or directory)" },
      parameters: {
        flags: { cwd: CWD },
        positional: {
          kind: "tuple",
          parameters: [{ parse: String, brief: "Path to exclude", placeholder: "path" }],
        },
      },
      func: async (flags: { cwd?: string }, target: string) => {
        const { place, kind, rel } = excludeTarget(flags.cwd ?? process.cwd(), target);
        await withDb("ingest", async (db) => {
          const id = await registered(db, place);
          const connector = await connectorOf(db, id, "docs");
          await db
            .insertInto("docs_exclude")
            .values({ connector_id: connector.id, kind, path: rel })
            .onConflict((oc) => oc.doNothing())
            .execute();
          console.log(
            document(
              "sphica project exclude add",
              inline(place.name),
              [
                {
                  kind: "fields",
                  rows: [
                    ["path", inline(rel)],
                    ["type", kind],
                  ],
                },
              ],
              `${mark("ok")} not imported from the next sync`,
            ),
          );
        });
      },
    }),
    list: buildCommand({
      docs: { brief: "Paths excluded in the project" },
      parameters: { flags: { cwd: CWD } },
      func: async (flags: { cwd?: string }) => {
        const place = placeOf(flags.cwd ?? process.cwd());
        await withDb("reader", async (db) => {
          const id = await registered(db, place);
          const rows = await db
            .selectFrom("docs_exclude as x")
            .innerJoin("connector as c", (j) =>
              j.onRef("c.id", "=", "x.connector_id").on("c.provider", "=", "docs"),
            )
            .select(["x.kind", "x.path"])
            .where("c.project_id", "=", id)
            .orderBy("x.path")
            .execute();
          console.log(
            document(
              "sphica project exclude list",
              inline(place.name),
              rows.length
                ? [
                    {
                      kind: "table",
                      head: ["path", "type"],
                      rows: rows.map((r) => [plain(r.path), r.kind]),
                    },
                  ]
                : [
                    {
                      kind: "note",
                      tone: "info",
                      text: "No excluded paths (every document is imported)",
                    },
                  ],
              rows.length ? `${plural(rows.length, "path")} excluded` : "none excluded",
            ),
          );
        });
      },
    }),
    remove: buildCommand({
      docs: { brief: "Stop excluding a path (it is imported again on the next sync)" },
      parameters: {
        flags: { cwd: CWD },
        positional: {
          kind: "tuple",
          parameters: [{ parse: String, brief: "Path to include again", placeholder: "path" }],
        },
      },
      func: async (flags: { cwd?: string }, target: string) => {
        const cwd = flags.cwd ?? process.cwd();
        const place = placeOf(cwd);
        // Removing does not check the working tree. Even if the path is gone after excluding it, the setting can still be removed.
        const rel = relativeTo(place.root, target, cwd);
        if (!rel) throw new Error(`${target} is not inside ${place.name} (${place.root})`);
        await withDb("ingest", async (db) => {
          const id = await registered(db, place);
          const gone = await db
            .deleteFrom("docs_exclude")
            .where("path", "=", rel)
            .where("connector_id", "in", (eb) =>
              eb
                .selectFrom("connector")
                .select("id")
                .where("project_id", "=", id)
                .where("provider", "=", "docs"),
            )
            .executeTakeFirst();
          console.log(
            document(
              "sphica project exclude remove",
              inline(place.name),
              [{ kind: "fields", rows: [["path", inline(rel)]] }],
              Number(gone.numDeletedRows)
                ? `${mark("ok")} imported again from the next sync`
                : `${mark("none")} was not excluded`,
            ),
          );
        });
      },
    }),
  },
});

const projectRoutes = buildRouteMap({
  docs: { brief: "Register and remove recorded projects" },
  routes: {
    add: buildCommand({
      docs: { brief: "Register a project (without a remote, name it on this machine with --name)" },
      parameters: {
        flags: {
          cwd: CWD,
          name: {
            kind: "parsed",
            parse: String,
            brief: "Name a project without a remote on this machine",
            placeholder: "name",
            optional: true,
          },
        },
      },
      func: async (flags: { cwd?: string; name?: string }) => {
        const cwd = flags.cwd ?? process.cwd();
        const place = flags.name ? nameLocal(cwd, flags.name) : placeOf(cwd);
        await withDb("ingest", async (db) => {
          const added = await db
            .insertInto("project")
            .values({ key: place.key, name: place.name })
            .onConflict((oc) => oc.column("key").doNothing())
            .returning("id")
            .executeTakeFirst();
          console.log(
            document(
              "sphica project add",
              undefined,
              [
                {
                  kind: "fields",
                  rows: [
                    ["project", inline(place.name)],
                    ["key", inline(place.key)],
                    ["location", inline(place.root)],
                  ],
                },
              ],
              added ? `${mark("ok")} registered` : `${mark("none")} already registered`,
            ),
          );
        });
      },
    }),
    list: buildCommand({
      docs: { brief: "Registered projects and their last sync" },
      parameters: {},
      func: async () => {
        const { found, ambiguous } = localRoots();
        await withDb("reader", async (db) => {
          const listed = await db
            .selectFrom("project as p")
            .leftJoin("connector as cn", "cn.project_id", "p.id")
            .select(["p.key", "p.name", (eb) => eb.fn.max("cn.last_success_at").as("last")])
            .groupBy("p.id")
            .orderBy("p.name")
            .execute();
          const home = os.homedir();
          const cards = listed.map((x) => {
            const root = found.get(x.key);
            const where = root
              ? root.startsWith(`${home}${path.sep}`)
                ? `~${root.slice(home.length)}`
                : root
              : ambiguous.has(x.key)
                ? "multiple locations (not synced)"
                : "not on this machine";
            return {
              title: inline(x.name),
              body: inline(where),
              meta: [
                inline(x.key),
                x.last
                  ? `last sync ${new Date(x.last).toLocaleString("sv-SE").slice(0, 16)}`
                  : "not synced yet",
              ],
            };
          });
          console.log(
            document(
              "sphica project list",
              undefined,
              cards.length
                ? [{ kind: "cards", items: cards }]
                : [
                    {
                      kind: "note",
                      tone: "info",
                      text: "No registered projects. Register one with sphica project add",
                    },
                  ],
              cards.length ? plural(cards.length, "project") : "none registered",
            ),
          );
        });
      },
    }),
    exclude: excludeRoutes,
    move: buildCommand({
      docs: {
        brief:
          "Move a project to its current remote after the repository was renamed (without --yes it only checks)",
      },
      parameters: {
        flags: {
          cwd: CWD,
          from: {
            kind: "parsed",
            parse: String,
            brief: "The project's key before the rename",
            placeholder: "key",
          },
          yes: { kind: "boolean", brief: "Really move", optional: true },
        },
      },
      func: async (flags: { cwd?: string; from: string; yes?: boolean }) => {
        const cwd = flags.cwd ?? process.cwd();
        const place = identify(cwd);
        // A named project has no remote to move to, and naming one here would register the key the move needs
        if (!place?.key.startsWith("git:"))
          throw new Error(
            `${cwd} has no git remote. Point origin at the renamed repository (git remote set-url origin <url>), then move again`,
          );
        await withDb("ingest", async (db) => {
          const x = await moveProject(db, flags.from, place, flags.yes === true);
          const rows: Block = {
            kind: "fields",
            rows: [
              ["from", inline(x.from)],
              ["to", inline(x.to)],
              ["knowledge from GitHub", `${x.knowledge} (${x.terms} with search words)`],
              ["conversations from GitHub", `${x.conversations}`],
              ["pending", `${x.spooled.pending}`],
              ["set aside for unregistered projects", `${x.spooled.held}`],
              ["rejected by the database", `${x.spooled.rejected}`],
            ],
          };
          console.log(
            document(
              "sphica project move",
              undefined,
              x.applied
                ? [rows]
                : [
                    rows,
                    {
                      kind: "note",
                      tone: "warning",
                      text: "Add --yes to move. Stop recording sessions first",
                    },
                  ],
              x.applied ? `${mark("ok")} moved` : `${mark("none")} nothing moved`,
            ),
          );
        });
      },
    }),
    forget: buildCommand({
      docs: { brief: "Delete a project's data (without --yes it only counts)" },
      parameters: {
        flags: { yes: { kind: "boolean", brief: "Really delete (cannot be undone)", optional: true } },
        positional: {
          kind: "tuple",
          parameters: [
            { parse: String, brief: "Key or name of the project to delete", placeholder: "key|name" },
          ],
        },
      },
      func: async (flags: { yes?: boolean }, target: string) => {
        await withDb("ingest", async (db) => {
          const hit = await db
            .selectFrom("project")
            .select(["id", "key", "name"])
            .where((eb) => eb.or([eb("key", "=", target), eb("name", "=", target)]))
            .execute();
          const p = hit[0];
          if (hit.length !== 1 || !p)
            throw new Error(`${plural(hit.length, "project")} match ${target}. Specify it by key`);
          const x = await db
            .selectFrom("project")
            .select([
              sql<number>`(select count(*) from conversation where project_id = ${p.id})`.as("conversations"),
              sql<number>`(select count(*) from message m
                join conversation c on c.id = m.conversation_id where c.project_id = ${p.id})`.as("messages"),
              sql<number>`(select count(*) from knowledge where project_id = ${p.id})`.as("knowledge"),
              sql<number>`(select count(*) from source_item s
                join connector cn on cn.id = s.connector_id where cn.project_id = ${p.id})`.as("items"),
            ])
            .where("id", "=", p.id)
            .executeTakeFirst();
          const counts: Block = {
            kind: "fields",
            rows: [
              ["project", inline(p.name)],
              ["key", inline(p.key)],
              ["conversations", `${x?.conversations}`],
              ["messages", `${x?.messages}`],
              ["knowledge", `${x?.knowledge}`],
              ["source items", `${x?.items}`],
            ],
          };
          if (flags.yes !== true) {
            console.log(
              document(
                "sphica project forget",
                undefined,
                [
                  counts,
                  { kind: "note", tone: "warning", text: "Add --yes to delete. This cannot be undone" },
                ],
                `${mark("none")} nothing deleted`,
              ),
            );
            return;
          }
          await db.deleteFrom("project").where("id", "=", p.id).execute();
          console.log(document("sphica project forget", undefined, [counts], `${mark("ok")} deleted`));
        });
      },
    }),
  },
});

const traceRoutes = buildRouteMap({
  docs: { brief: "Read, validate, and store decision records (trace)" },
  routes: {
    context: buildCommand({
      docs: { brief: "Print the current session's conversation and work in progress (material for trace)" },
      parameters: {
        flags: {
          host: {
            kind: "enum",
            values: HOSTS,
            brief: "Your host (needed when both sessions are in the environment)",
            optional: true,
          },
        },
      },
      func: async (flags: { host?: Host }) => {
        console.log(plain(framed(await traceContext(process.cwd(), flags.host))));
      },
    }),
    check: buildCommand({
      docs: { brief: "Validate a trace record (does not touch the database)" },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [
            { parse: String, brief: "The trace record (- for stdin)", placeholder: "trace.json|-" },
          ],
        },
      },
      func: (_flags: Record<never, never>, file: string) => {
        const r = checkTrace(readTrace(file));
        if (r.problems.length) {
          console.error(
            panel(
              "sphica trace check",
              r.problems.map((p) => `${mark("fail")} ${p}`),
              plural(r.problems.length, "problem"),
            ),
          );
          process.exitCode = 1;
          return;
        }
        console.log(
          panel(
            "sphica trace check",
            [],
            `${mark("ok")} valid: ${plural(r.trace?.items.length ?? 0, "item")}`,
          ),
        );
      },
    }),
    save: buildCommand({
      docs: { brief: "Store a trace record (the same key overwrites)" },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [
            { parse: String, brief: "The trace record (- for stdin)", placeholder: "trace.json|-" },
          ],
        },
      },
      func: async (_flags: Record<never, never>, file: string) => {
        const r = checkTrace(readTrace(file));
        if (!r.trace)
          throw new Error(`The record is not valid:\n${r.problems.map((p) => `  ${p}`).join("\n")}`);
        const trace = r.trace;
        // Only the current session's record can be written. Trusting the file's session would let it overwrite another session's decisions and constraints.
        const now = hostSession(trace.session.host);
        if (now.id !== trace.session.id)
          throw new Error(
            `The record's session (${trace.session.id}) differs from the current ${now.host} session (${now.id}). Use the session id that trace context printed`,
          );
        const place = placeOf(process.cwd());
        await withDb("ingest", async (db) => {
          const id = await registered(db, place);
          const saved = await saveTrace(db, id, trace);
          console.log(
            panel(
              "sphica trace save",
              [],
              `stored: ${plural(saved.written, "item")} rewritten${saved.superseded ? `, ${plural(saved.superseded, "decision")} superseded` : ""}${saved.terms ? `, search words changed on ${plural(saved.terms, "item")}` : ""}`,
            ),
          );
        });
      },
    }),
  },
});

const captureRoutes = buildRouteMap({
  docs: { brief: "Conversation recording" },
  routes: {
    flush: buildCommand({
      docs: { brief: "Send the recording queue to the database" },
      parameters: {},
      func: async () => {
        const r = await flush();
        if (r.busy) {
          console.log(
            panel(
              "sphica capture flush",
              [],
              "Another send is running, so nothing was done (the queue empties when it finishes)",
            ),
          );
          return;
        }
        console.log(
          document(
            "sphica capture flush",
            undefined,
            [
              {
                kind: "fields",
                rows: [
                  ["new messages", `${r.sent}`],
                  ...(r.deferred
                    ? ([["set aside for unregistered projects", `${r.deferred}`]] as [string, string][])
                    : []),
                  ...(r.rejected
                    ? ([["rejected by the database", `${r.rejected} (kept in ${rejectedDir()})`]] as [
                        string,
                        string,
                      ][])
                    : []),
                ],
              },
            ],
            `${mark(r.rejected ? "warn" : "ok")} sent`,
          ),
        );
      },
    }),
  },
});

/** Adds a heading and closing to admin.ts output lines. Failures become a block through stricli exceptionWhileRunningCommand */
async function boxed(head: string, fn: () => unknown): Promise<void> {
  console.log(title(head));
  if ((await fn()) === "cancelled") {
    console.log(closing(`${mark("fail")} Stopped`));
    process.exitCode = 1;
    return;
  }
  console.log(closing(`${mark("ok")} done`));
}

const dbRoutes = buildRouteMap({
  docs: { brief: "This machine's database (~/.sphica/sphica.db) and schema" },
  routes: {
    migrate: buildCommand({
      docs: { brief: "Apply db/migrations newer than the database version" },
      parameters: {
        flags: {
          yes: {
            kind: "boolean",
            brief: "Skip the confirmation before applying (required outside a terminal)",
            optional: true,
          },
        },
      },
      func: (flags: { yes?: boolean }) => boxed("sphica db migrate", () => migrate(flags.yes === true)),
    }),
    reindex: buildCommand({
      docs: { brief: "Rebuild the full-text index (run after changing how search splits words)" },
      parameters: {},
      func: () => boxed("sphica db reindex", () => reindex()),
    }),
    terms: buildRouteMap({
      docs: { brief: "Search words of records (indexed, never shown in search results or read)" },
      routes: {
        import: buildCommand({
          docs: {
            brief: "Import reviewed search words once, only for records unchanged since the draft",
          },
          parameters: {
            flags: { cwd: CWD },
            positional: {
              kind: "tuple",
              parameters: [{ parse: String, brief: "Draft JSON file", placeholder: "file" }],
            },
          },
          func: (flags: { cwd?: string }, draft: string) =>
            boxed("sphica db terms import", () => {
              importTerms(draft, placeOf(flags.cwd ?? process.cwd()));
            }),
        }),
        list: buildCommand({
          docs: { brief: "Show the search words of this project's records" },
          parameters: {
            flags: {
              cwd: CWD,
              ref: {
                kind: "parsed",
                parse: String,
                brief: "Only this record (k:<id>)",
                placeholder: "ref",
                optional: true,
              },
            },
          },
          func: (flags: { cwd?: string; ref?: string }) =>
            boxed("sphica db terms list", () => {
              listTerms(placeOf(flags.cwd ?? process.cwd()), flags.ref);
            }),
        }),
      },
    }),
  },
});

const root = buildRouteMap({
  docs: {
    brief: "Keep and search past decisions, conversations, and documents",
    fullDescription: "Database: ~/.sphica/sphica.db (created by sphica init). No credentials are needed",
  },
  routes: {
    project: projectRoutes,
    harvest: buildCommand({
      docs: {
        brief: "Sync GitHub and documents for the projects on this machine",
        fullDescription:
          "Documents come from the remote's default branch and stop when it is not a fast-forward (--reset-docs brings a project to its current state).",
      },
      parameters: {
        flags: {
          cwd: CWD,
          "reset-docs": {
            kind: "boolean",
            brief: "Bring the project's documents to its current state (only with --cwd)",
            optional: true,
          },
        },
      },
      func: async (flags: { cwd?: string; "reset-docs"?: boolean }) => {
        const resetDocs = flags["reset-docs"] === true;
        // Resetting only when one project is named (a sync of everything never overwrites every project that cannot be compared).
        if (resetDocs && !flags.cwd) throw new Error("--reset-docs works only when --cwd names one project");
        // The log is appended to, so the heading always shows when it ran.
        const startedAt = new Date();
        console.log(title(`sphica harvest ${startedAt.toLocaleString("sv-SE")}`));
        await flush().catch((e: unknown) =>
          console.error(indent(`${mark("fail")} failed to send recordings: ${plain(reason(e))}`)),
        );
        const failures: string[] = [];
        let done = 0;
        try {
          await withDb("ingest", async (db) => {
            const only = flags.cwd ? placeOf(flags.cwd) : null;
            if (only) await registered(db, only);
            const { found, ambiguous } = localRoots();
            const projects = await db
              .selectFrom("project")
              .select(["id", "key", "name"])
              .orderBy("name")
              .execute();
            for (const p of projects) {
              if (only && only.key !== p.key) continue;
              const root = only?.root ?? found.get(p.key);
              if (!root) {
                console.log(
                  indent(
                    `${mark("none")} ${inline(p.name)}: skipped (${ambiguous.has(p.key) ? "multiple locations on this machine" : "not on this machine"})`,
                  ),
                );
                continue;
              }
              try {
                const place = { key: p.key, root, name: p.name };
                for (const line of await syncOne(db, p.id, place, resetDocs)) {
                  console.log(indent(`${mark("ok")} ${inline(p.name)} / ${inline(line)}`));
                }
                done++;
              } catch (e) {
                // One failure does not stop the rest. Failures go to the exit code (visible in launchd LastExitStatus).
                failures.push(inline(p.name));
                const lines = plain(reason(e)).split("\n");
                console.error(
                  indent(
                    [
                      `${mark("fail")} ${inline(p.name)}`,
                      ...lines.map((l) => (l.trim() ? `  ${l.trim()}` : "")),
                    ].join("\n"),
                  ),
                );
              }
            }
          });
        } catch (e) {
          // Even when stopping after the heading was printed, close the box before ending (the log is appended across days).
          console.error(indent(`${mark("fail")} ${plain(reason(e))}`));
          console.log(closing(`${mark("fail")} stopped ${new Date().toLocaleString("sv-SE")}`));
          process.exitCode = 1;
          return;
        }
        console.log(
          closing(
            `finished ${new Date().toLocaleString("sv-SE")} / ${Math.round((Date.now() - startedAt.getTime()) / 1000)} s / succeeded ${done}${
              failures.length ? ` / failed ${failures.join(" / ")}` : ""
            }`,
          ),
        );
        if (failures.length) process.exitCode = 1;
      },
    }),
    search: buildCommand({
      docs: { brief: "Check what can be found (--said searches messages)" },
      parameters: {
        flags: {
          avoid: { kind: "boolean", brief: "Search only rejected options and dead ends", optional: true },
          said: {
            kind: "parsed",
            parse: String,
            brief: "Search messages (me / others / a name)",
            placeholder: "me|others|name",
            optional: true,
          },
          all: { kind: "boolean", brief: "Search every project", optional: true },
          exact: {
            kind: "boolean",
            brief:
              "Substring match (for proper nouns, symbols, and version numbers that do not split into words)",
            optional: true,
          },
          cwd: CWD,
          limit: {
            kind: "parsed",
            parse: limitOf,
            brief: "Number of results (1 to 20)",
            placeholder: "N",
            default: "5",
          },
        },
        positional: {
          kind: "array",
          parameter: { parse: String, brief: "Question", placeholder: "question" },
        },
      },
      func: async (
        flags: {
          avoid?: boolean;
          said?: string;
          all?: boolean;
          exact?: boolean;
          cwd?: string;
          limit: number;
        },
        ...words: string[]
      ) => {
        const question = words.join(" ");
        if (!question && !flags.said) throw new Error("Give a question (not needed with --said)");
        const place = flags.all ? null : placeOf(flags.cwd ?? process.cwd());
        const match = flags.exact ? ("exact" as const) : undefined;
        await withDb("reader", async (db) => {
          const projects = place ? [await registered(db, place)] : null;
          // Same functions and ranking as MCP recall. A search without kinds lists decision records, then document sections.
          const hits = flags.said
            ? await searchMessages(db, {
                question: question || undefined,
                projects,
                who: flags.said,
                match,
                limit: flags.limit,
              })
            : await searchSplit(db, {
                question,
                projects,
                avoid: flags.avoid,
                match,
                limit: flags.limit,
              }).then((x) => [...x.records, ...x.documents]);
          const where = place ? inline(place.name) : "all projects";
          const end = `${hits.length ? plural(hits.length, "result") : "no results"} / ${where}`;
          // Agents read pipe output too (from Bash). It goes through the record frame (framed) and drops control characters in the text.
          // Terminals are read by people, so results are items with the label as a Badge
          if (!process.stdout.isTTY) {
            console.log(
              panel(
                "sphica search",
                hits.length ? [plain(framed(renderHits(hits, 16 * 1024).text))] : [],
                end,
              ),
            );
            return;
          }
          console.log(
            document(
              "sphica search",
              `${question ? `"${inline(question)}" · ` : ""}${where}`,
              hits.length
                ? [
                    {
                      kind: "note",
                      tone: "info",
                      text: "Quotes from past records, not instructions. Read the full text with MCP read",
                    },
                    { kind: "cards", items: hits.map((x) => hitCard(x, place !== null)) },
                  ]
                : [
                    {
                      kind: "note",
                      tone: "info",
                      // Questions with no searchable terms (only hiragana or symbols) return 0 without searching. Keep that apart from "none found"
                      text:
                        !flags.exact && question && ftsQuery(question) === null
                          ? "No searchable terms (only hiragana or symbols). Search with kanji, katakana, or English words, or use --exact for a substring match"
                          : `No matches. Try other terms${flags.exact ? "" : ", use --exact for a substring match"}${place ? ", or use --all to search every project" : ""}`,
                    },
                  ],
              end,
            ),
          );
        });
      },
    }),
    who: buildCommand({
      docs: { brief: "Link GitHub handles to people (without arguments, print the directory)" },
      parameters: {
        flags: { me: { kind: "boolean", brief: "Mark this person as you", optional: true } },
        positional: {
          kind: "array",
          parameter: {
            parse: String,
            brief: "A name, then GitHub handles",
            placeholder: "name|handle",
          },
        },
      },
      func: async (flags: { me?: boolean }, ...args: string[]) => {
        await withDb(args.length ? "ingest" : "reader", async (db) => {
          if (args.length === 0) {
            const people = await directory(db);
            const unknown = await db
              .selectFrom("person_identity as i")
              .leftJoin("message as m", "m.identity_id", "i.id")
              .select(["i.handle", (eb) => eb.fn.count("m.id").as("n")])
              .where("i.person_id", "is", null)
              .groupBy("i.id")
              .orderBy((eb) => eb.fn.count("m.id"), "desc")
              .orderBy("i.handle")
              .limit(20)
              .execute();
            console.log(
              document(
                "sphica who",
                undefined,
                [
                  people.length
                    ? {
                        kind: "table",
                        head: ["name", "GitHub handles"],
                        rows: people.map((p) => [
                          `${p.isSelf ? "→ " : ""}${inline(p.display)}${p.isSelf ? " (you)" : ""}`,
                          p.handles.map(inline).join(" / "),
                        ]),
                      }
                    : {
                        kind: "note",
                        tone: "info",
                        text: "The directory is empty. Add people with sphica who <name> <handle>...",
                      },
                  ...(unknown.length
                    ? ([
                        {
                          kind: "table",
                          head: ["handles not linked to anyone yet", "messages"],
                          rows: unknown.map((u) => [inline(u.handle), `${u.n}`]),
                        },
                      ] as Block[])
                    : []),
                ],
                people.length ? plural(people.length, "person", "people") : "directory is empty",
              ),
            );
            return;
          }
          const [display, ...handles] = args;
          if (!display || handles.length === 0) throw new Error("Give a name and at least one GitHub handle");
          // Moving "you" happens in one transaction. Failing midway would leave nobody marked as you.
          const linked = await inTransaction(db, async (trx) => {
            if (flags.me)
              await trx.updateTable("person").set({ is_self: 0 }).where("is_self", "=", 1).execute();
            const pe = await trx
              .insertInto("person")
              .values({ display_name: display, is_self: flags.me === true ? 1 : 0 })
              .onConflict((oc) =>
                oc
                  .column("display_name")
                  .doUpdateSet({ is_self: sql<number>`max(person.is_self, excluded.is_self)` }),
              )
              .returning("id")
              .executeTakeFirst();
            return await trx
              .updateTable("person_identity")
              .set({ person_id: pe?.id ?? null })
              .where("provider", "=", "github")
              .where(
                (eb) => eb.fn("lower", ["handle"]),
                "in",
                handles.map((h) => h.replace(/^@/, "").toLowerCase()),
              )
              .returning("handle")
              .execute();
          });
          const missing = handles.filter(
            (h) => !linked.some((l) => l.handle.toLowerCase() === h.replace(/^@/, "").toLowerCase()),
          );
          console.log(
            panel(
              "sphica who",
              missing.length
                ? [
                    `Handles not imported yet: ${missing.map(inline).join(" / ")} (link them again after a sync)`,
                  ]
                : [],
              `Added to the directory: ${inline(display)}${flags.me ? " (you)" : ""} = ${linked.map((l) => inline(l.handle)).join(" / ") || "(no handles linked)"}`,
            ),
          );
        });
      },
    }),
    trace: traceRoutes,
    capture: captureRoutes,
    db: dbRoutes,
    init: buildCommand({
      docs: {
        brief:
          "Create this machine's database (~/.sphica/sphica.db). An existing one is left alone; safe to run again",
      },
      parameters: {},
      func: () => boxed("sphica init", () => dbInit()),
    }),
    doctor: buildCommand({
      docs: {
        brief:
          "npm package and plugin versions, Node, the database and schema, and sync and recording status",
      },
      parameters: {},
      func: () => doctor(process.cwd()),
    }),
    advice: buildCommand({
      docs: { brief: "How often the edit hook showed constraints" },
      parameters: {},
      func: () => {
        // Measures whether the edit hook helps. After a month, if it rarely shows anything, remove the hook.
        const log = path.join(os.homedir(), ".sphica", "advice.jsonl");
        if (!fs.existsSync(log)) {
          console.log(panel("sphica advice", [], "No records yet (the edit hook has never run)"));
          return;
        }
        // Skip lines cut midway (a process stopped while writing). One line does not make the whole unreadable.
        const rows = fs
          .readFileSync(log, "utf8")
          .split("\n")
          .flatMap((l) => {
            try {
              const r = JSON.parse(l) as { at?: unknown; shown?: unknown };
              return typeof r.at === "string" && typeof r.shown === "number"
                ? [{ at: r.at, shown: r.shown }]
                : [];
            } catch {
              return [];
            }
          });
        const shown = rows.filter((r) => r.shown > 0);
        const since = rows[0]?.at;
        const ratio = shown.length / Math.max(rows.length, 1);
        console.log(
          document(
            "sphica advice",
            since ? `since ${new Date(since).toLocaleString("sv-SE").slice(0, 16)}` : undefined,
            [
              {
                kind: "fields",
                rows: [
                  ["edits with the hook", `${rows.length}`],
                  ["constraints shown", `${shown.length}`],
                  ...(since
                    ? ([["records since", new Date(since).toLocaleString("sv-SE")]] as [string, string][])
                    : []),
                ],
              },
              { kind: "meter", label: "share with constraints", ratio, text: `${(ratio * 100).toFixed(1)}%` },
            ],
            `${mark("ok")} constraints shown on ${shown.length} of ${plural(rows.length, "edit")}`,
          ),
        );
      },
    }),
  },
});

const FORMATTING = {
  useAliasInUsageLine: false,
  onlyRequiredInUsageLine: false,
  caseStyle: "original",
} as const;

const app = buildApplication(
  root,
  {
    name: "sphica",
    localization: { text: TEXT },
    // panel.ts decides box and mark colors (only when both stdout and stderr are terminals).
    documentation: { disableAnsiColor: true },
  },
  {
    help: help({
      brief: TEXT.briefs.help,
      alias: "h",
      defaultForRouteMap: true,
      includeHidden: false,
      formatting: FORMATTING,
    }),
    helpAll: help({
      brief: TEXT.briefs.helpAll,
      alias: "H",
      hidden: true,
      includeHidden: true,
      formatting: FORMATTING,
    }),
    version: version({
      brief: TEXT.briefs.version,
      alias: "v",
      info: { getCurrentVersion: async () => `${packageVersionAt(ROOT) ?? "unknown"}  ${ROOT}` },
    }),
  },
);

await run(app, process.argv.slice(2), {
  process,
  forCommand: ({ prefix }: CommandInfo) => {
    heading = prefix.join(" ");
    return { process };
  },
});
// stricli's internal exit codes are negative (argument parse failure is -4). Shells see only the low 8 bits, so map them to 1.
if (typeof process.exitCode === "number" && process.exitCode < 0) process.exitCode = 1;
