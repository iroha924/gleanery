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
  closing,
  document,
  failure,
  indent,
  panel,
  section,
  steps,
  stopped,
  title,
} from "./cli/view.ts";
import { dbFile, openReader, type Role, SCHEMA_REVISION } from "./db.ts";
import type { DB } from "./db-types.ts";
import { openWriter } from "./db-write.ts";
import { type DraftKind, draftId, newDraft, readDraft, removeDraft } from "./draft.ts";
import { parts, readPull, recentPulls, repoOf } from "./github.ts";
import { conversationId } from "./knowledge.ts";
import { moveProject } from "./move.ts";
import { inline, type Mark, mark, pad, plain, width } from "./panel.ts";
import { observe, packageVersionAt, ROOT, report, UPDATE_NOTE } from "./plugin.ts";
import {
  checkLocalName,
  identify,
  localRoots,
  nameLocal,
  type Place,
  projectId,
  repositoryRoot,
} from "./project.ts";
import { framed, openWork, renderWork, workDetail } from "./search.ts";
import { requireRuntime } from "./sqlite.ts";
import { bytes, head, plural, reason, sha256 } from "./text.ts";
import { checkHarvest, checkTrace, type PullRequest, saveHarvest, saveTrace } from "./trace.ts";

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
    throw new Error(`${cwd} has no git remote and no name. Name it with \`sphica init --name <name>\``);
  }
  return place;
}

async function registered(db: Kysely<DB>, place: Place): Promise<number> {
  const id = await projectId(db, place.key);
  if (id === null)
    throw new Error(`${place.name} is not registered with Sphica. Register it with \`sphica init\``);
  return id;
}

/** The draft id a Skill passes to check and save (see draft.ts). */
const DRAFT = { parse: draftId, brief: "The id draft printed", placeholder: "id" } as const;

/** Prints where the agent writes the record. */
function draftCommand(kind: DraftKind) {
  return buildCommand({
    docs: { brief: `Issue a draft: the file to write a ${kind} record to, and its id for check and save` },
    parameters: {},
    func: () => {
      const d = newDraft(kind);
      console.log(
        panel(
          `sphica ${kind} draft`,
          [`id: ${d.id}`, `file: ${d.file}`],
          `write the record to the file, then run ${kind} check ${d.id}`,
        ),
      );
    },
  });
}

/** The closing line of save, and whether the draft could be removed (a failed removal must not read as a failed save). */
function saved(line: string, id: string): string {
  const left = removeDraft(id);
  return left ? `${line}. Saved; draft cleanup failed (${left}), do not save again` : line;
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
        "m.id",
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
    const said = messages.map((m) => {
      const shown = head(m.body, m.speaker_kind === "self" ? 4000 : 800);
      // Say where a long message was cut, so the rest can still be read (read m:<id> over MCP)
      const cut =
        shown.length < m.body.length
          ? `\n(cut: ${bytes(shown)} of ${bytes(m.body)} bytes shown; read m:${m.id} for the rest)`
          : "";
      return (
        `## ${m.speaker_kind === "self" ? "Owner" : "AI"} (${m.sent_at})${m.truncated ? " (partly saved)" : ""}\n` +
        `${shown}${cut}${m.paths.length ? `\nFiles touched after this message: ${m.paths.map((p) => p.path).join(" / ")}` : ""}`
      );
    });
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
      s.stuck ? ` / failed: ${plain(s.stuck)} (send again with sphica capture flush)` : ""
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
          .select((eb) => [
            "p.key",
            "p.name",
            eb
              .selectFrom("knowledge as k")
              .select((k) => k.fn.countAll<number>().as("n"))
              .whereRef("k.project_id", "=", "p.id")
              .as("records"),
            eb
              .selectFrom("pull_request as r")
              .select((r) => r.fn.max("r.harvested_at").as("at"))
              .whereRef("r.project_id", "=", "p.id")
              .as("harvested"),
          ])
          .orderBy("p.name")
          .execute();
        if (rows.length) console.log(section("Projects", true));
        const column = Math.max(...rows.map((x) => width(inline(x.name)))) + 2;
        for (const x of rows) {
          const where = found.get(x.key) ? "" : " (not on this machine)";
          console.log(
            indent(
              `  ${mark("none")} ${pad(inline(x.name), column)}${plural(Number(x.records ?? 0), "record")}${
                x.harvested ? ` / last harvest ${new Date(x.harvested).toLocaleString("sv-SE")}` : ""
              }${where}`,
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

const projectRoutes = buildRouteMap({
  docs: { brief: "List, move, and remove recorded projects (sphica init registers one)" },
  routes: {
    list: buildCommand({
      docs: { brief: "Registered projects and their last harvest" },
      parameters: {},
      func: async () => {
        const { found, ambiguous } = localRoots();
        await withDb("reader", async (db) => {
          const listed = await db
            .selectFrom("project as p")
            .leftJoin("pull_request as r", "r.project_id", "p.id")
            .select(["p.key", "p.name", (eb) => eb.fn.max("r.harvested_at").as("last")])
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
                ? "multiple locations"
                : "not on this machine";
            return {
              title: inline(x.name),
              body: inline(where),
              meta: [
                inline(x.key),
                x.last
                  ? `last harvest ${new Date(x.last).toLocaleString("sv-SE").slice(0, 16)}`
                  : "nothing harvested yet",
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
                      text: "No registered projects. Register one with sphica init in the repository",
                    },
                  ],
              cards.length ? plural(cards.length, "project") : "none registered",
            ),
          );
        });
      },
    }),
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
              ["harvested pull requests", `${x.pullRequests}`],
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
              sql<number>`(select count(*) from pull_request where project_id = ${p.id})`.as("pullRequests"),
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
              ["harvested pull requests", `${x?.pullRequests}`],
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
    draft: draftCommand("trace"),
    check: buildCommand({
      docs: { brief: "Validate a trace record (does not touch the database)" },
      parameters: { positional: { kind: "tuple", parameters: [DRAFT] } },
      func: (_flags: Record<never, never>, id: string) => {
        const r = checkTrace(readDraft(id, "trace"));
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
      docs: { brief: "Store a trace record (the same key overwrites) and remove its draft" },
      parameters: { positional: { kind: "tuple", parameters: [DRAFT] } },
      func: async (_flags: Record<never, never>, draft: string) => {
        const r = checkTrace(readDraft(draft, "trace"));
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
          const done = await saveTrace(db, id, trace);
          console.log(
            panel(
              "sphica trace save",
              [],
              saved(
                `stored: ${plural(done.written, "item")} rewritten${done.superseded ? `, ${plural(done.superseded, "decision")} superseded` : ""}${done.terms ? `, search words changed on ${plural(done.terms, "item")}` : ""}`,
                draft,
              ),
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

/**
 * First-time setup: the database, then the project dir belongs to (a repository without a remote needs --name). Safe to run again.
 * A bad --name and a name that differs from the one already given stop before anything is written.
 */
async function init(flags: { cwd?: string; name?: string }): Promise<void> {
  const cwd = flags.cwd ?? process.cwd();
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`${cwd} is not a directory`);
  const found = identify(cwd);
  if (flags.name !== undefined) {
    checkLocalName(flags.name);
    if (found?.key.startsWith("git:"))
      throw new Error(
        `${found.root} has a git remote, so its key is ${found.key}. Run sphica init without --name`,
      );
    if (found && found.key !== `local:${flags.name}`)
      throw new Error(
        `${found.root} is already named ${found.name}. Its records stay under that name, so keep it`,
      );
  }
  await boxed("sphica init", async () => {
    dbInit();
    // A place already under this name (the named directory or one below it) is used as is, so the name table never gains a second place
    const place = flags.name !== undefined && !found ? nameLocal(cwd, flags.name) : found;
    if (!place) {
      const root = repositoryRoot(cwd);
      if (root)
        console.log(
          indent(`${mark("warn")} ${root} has no git remote. Register it with \`sphica init --name <name>\``),
        );
      return;
    }
    await withDb("ingest", async (db) => {
      const added = await db
        .insertInto("project")
        .values({ key: place.key, name: place.name })
        .onConflict((oc) => oc.column("key").doNothing())
        .returning("id")
        .executeTakeFirst();
      console.log(
        indent(
          `${mark(added ? "ok" : "none")} ${inline(place.name)} ${added ? "registered" : "already registered"} (${inline(place.key)}, ${inline(place.root)})`,
        ),
      );
    });
  });
}

/** Adds a heading and closing to admin.ts output lines. A failure closes the heading already printed (not a second block from stricli) */
async function boxed(head: string, fn: () => unknown): Promise<void> {
  console.log(title(head));
  let outcome: unknown;
  try {
    outcome = await fn();
  } catch (e) {
    console.log(stopped(plain(reason(e))));
    process.exitCode = 1;
    return;
  }
  if (outcome === "cancelled") {
    console.log(closing(`${mark("fail")} Stopped`));
    process.exitCode = 1;
    return;
  }
  console.log(closing(`${mark("ok")} done`));
}

const dbRoutes = buildRouteMap({
  docs: {
    brief: "This machine's database (~/.sphica/sphica.db) and schema",
    // Maintainer steps (a release that changes search terms, reviewing search words). -H lists them
    hideRoute: { reindex: true, terms: true },
  },
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

/** The GitHub repository of the project at cwd (harvest reads only GitHub). */
function repositoryOf(place: Place): string {
  const repo = repoOf(place.key);
  if (!repo) throw new Error(`${place.name} has no GitHub remote, so there is no pull request to harvest`);
  return repo;
}

/**
 * What harvest read prints, and its version: the items an earlier harvest stored (so a rerun reuses their keys), then the pull request.
 * Each part and save fetch it again, so the version shows whether the pull request changed since it was read.
 */
async function material(
  place: Place,
  n: number,
): Promise<{ pr: PullRequest; whole: string; version: string }> {
  const { pr, text } = await readPull(repositoryOf(place), n);
  const earlier = await withDb("reader", async (db) =>
    db
      .selectFrom("knowledge as k")
      .innerJoin("pull_request as r", "r.id", "k.pull_request_id")
      .select(["k.source_key", "k.kind", "k.status", "k.body"])
      .where("r.project_id", "=", await registered(db, place))
      .where("r.number", "=", n)
      .where("k.kind", "<>", "option")
      .orderBy("k.occurred_at")
      .orderBy("k.id")
      .execute(),
  );
  const saved = earlier.length
    ? `# Already harvested from #${n} (the same key overwrites; keys left out stay)\n\n${earlier.map((x) => `- ${x.source_key.split("#")[1]} (${x.kind}${x.status ? ` / ${x.status}` : ""}) ${head(x.body, 200)}`).join("\n")}\n\n`
    : "";
  const whole = saved + text;
  return { pr, whole, version: sha256(whole).toString("hex").slice(0, 12) };
}

const PR = { parse: prNumber, brief: "The pull request number", placeholder: "number" } as const;
function prNumber(input: string): number {
  const n = Number(input.replace(/^#/, ""));
  if (!Number.isInteger(n) || n < 1) throw new Error(`Not a pull request number: ${input}`);
  return n;
}
function partNumber(input: string): number {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Not a part number: ${input}`);
  return n;
}

/**
 * Run by the harvest Skill. list and read open no database; read prints someone else's text inside the record frame.
 * save is the only write, and it stores only knowledge of the named pull request of the project at cwd (trace.ts saveHarvest).
 */
const harvestRoutes = buildRouteMap({
  docs: { brief: "Read a pull request and store what it decided (run by the harvest Skill)" },
  routes: {
    list: buildCommand({
      docs: { brief: "Recent pull requests of this project's repository" },
      parameters: { flags: { cwd: CWD } },
      func: async (flags: { cwd?: string }) => {
        const repo = repositoryOf(placeOf(flags.cwd ?? process.cwd()));
        const prs = await recentPulls(repo);
        console.log(
          document(
            "sphica harvest list",
            inline(repo),
            prs.length
              ? [
                  {
                    kind: "table",
                    head: ["number", "state", "updated", "title"],
                    rows: prs.map((x) => [`#${x.number}`, x.state, x.updated.slice(0, 10), inline(x.title)]),
                  },
                ]
              : [{ kind: "note", tone: "info", text: "No pull requests yet" }],
            plural(prs.length, "pull request"),
          ),
        );
      },
    }),
    read: buildCommand({
      docs: { brief: "Print one pull request in time order, inside the record frame, one part at a time" },
      parameters: {
        flags: {
          cwd: CWD,
          part: {
            kind: "parsed",
            parse: partNumber,
            brief: "Which part to print (from 1)",
            placeholder: "n",
            optional: true,
          },
        },
        positional: { kind: "tuple", parameters: [PR] },
      },
      func: async (flags: { cwd?: string; part?: number }, n: number) => {
        const { whole, version } = await material(placeOf(flags.cwd ?? process.cwd()), n);
        const all = parts(whole);
        const k = flags.part ?? 1;
        const part = all[k - 1];
        if (part === undefined)
          throw new Error(`#${n} has ${plural(all.length, "part")}; there is no part ${k}`);
        console.log(plain(framed(part)));
        console.log(
          all.length > k
            ? `part ${k} of ${all.length}, version ${version}. Read the next with: harvest read ${n} --part ${k + 1}`
            : `part ${k} of ${all.length} (the last), version ${version}`,
        );
      },
    }),
    draft: draftCommand("harvest"),
    check: buildCommand({
      docs: { brief: "Validate a harvest record (does not touch the database)" },
      parameters: { positional: { kind: "tuple", parameters: [DRAFT] } },
      func: (_flags: Record<never, never>, id: string) => {
        const r = checkHarvest(readDraft(id, "harvest"));
        if (r.problems.length) {
          console.error(
            panel(
              "sphica harvest check",
              r.problems.map((p) => `${mark("fail")} ${p}`),
              plural(r.problems.length, "problem"),
            ),
          );
          process.exitCode = 1;
          return;
        }
        console.log(
          panel(
            "sphica harvest check",
            [],
            `${mark("ok")} valid: ${plural(r.harvest?.items.length ?? 0, "item")}`,
          ),
        );
      },
    }),
    save: buildCommand({
      docs: {
        brief:
          "Store a harvest record for a pull request of this project (the same key overwrites) and remove its draft",
      },
      parameters: { flags: { cwd: CWD }, positional: { kind: "tuple", parameters: [DRAFT] } },
      func: async (flags: { cwd?: string }, draft: string) => {
        const r = checkHarvest(readDraft(draft, "harvest"));
        if (!r.harvest)
          throw new Error(`The record is not valid:\n${r.problems.map((p) => `  ${p}`).join("\n")}`);
        const record = r.harvest;
        const place = placeOf(flags.cwd ?? process.cwd());
        // The pull request is read from GitHub again, never taken from the record, and must be what the record was written from
        const { pr, version } = await material(place, record.pr);
        if (version !== record.version)
          throw new Error(
            `#${record.pr} changed since it was read (now version ${version}, the record has ${record.version}). Read it again with harvest read ${record.pr}`,
          );
        await withDb("ingest", async (db) => {
          const id = await registered(db, place);
          const done = await saveHarvest(db, id, pr, record);
          console.log(
            panel(
              "sphica harvest save",
              done.kept.length
                ? [
                    `Kept from an earlier harvest (not picked this time): ${done.kept.map(inline).join(" / ")}`,
                  ]
                : [],
              saved(
                `stored #${pr.number}: ${plural(done.written, "item")} rewritten${done.superseded ? `, ${plural(done.superseded, "decision")} superseded` : ""}${done.terms ? `, search words changed on ${plural(done.terms, "item")}` : ""}`,
                draft,
              ),
            ),
          );
        });
      },
    }),
  },
});

const root = buildRouteMap({
  docs: {
    brief: "Keep and search past decisions and conversations",
    fullDescription: "Database: ~/.sphica/sphica.db (created by sphica init). No credentials are needed",
    // Usage shows only what people type. The rest are run by the trace Skill, the capture hooks, maintenance, or on doctor's advice; -H lists them
    hideRoute: { project: true, harvest: true, trace: true, capture: true, db: true },
  },
  routes: {
    project: projectRoutes,
    harvest: harvestRoutes,
    trace: traceRoutes,
    capture: captureRoutes,
    db: dbRoutes,
    init: buildCommand({
      docs: {
        brief:
          "Set up: create this machine's database and register the current repository (safe to run again)",
      },
      parameters: {
        flags: {
          cwd: CWD,
          name: {
            kind: "parsed",
            parse: String,
            brief: "Name a project without a git remote on this machine",
            placeholder: "name",
            optional: true,
          },
        },
      },
      func: (flags: { cwd?: string; name?: string }) => init(flags),
    }),
    doctor: buildCommand({
      docs: {
        brief:
          "npm package and plugin versions, Node, the database and schema, and harvest and recording status",
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
