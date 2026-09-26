// The recall and read tools of the MCP server, as functions. mcp.ts sends their text; the eval replays recorded calls through the same
// functions to learn which records a response showed in full (Shown), instead of parsing the text.

import type { Kysely } from "kysely";
import type { DB } from "./db-types.ts";
import type { KINDS } from "./knowledge.ts";
import { inline } from "./panel.ts";
import { type Place, relativeTo } from "./project.ts";
import {
  directory,
  framedShown,
  inFrame,
  openWork,
  read,
  renderHits,
  renderWork,
  type Scope,
  type Shown,
  searchKnowledge,
  searchMessages,
  searchSplit,
  splitJson,
  workDetail,
} from "./search.ts";
import { ftsQuery, head, reason } from "./text.ts";

/**
 * Response limits in bytes. **Codex truncates a response over about 10,000 tokens on the spot, and JSON arrives broken.**
 * Japanese is 3 bytes and roughly 1 token per character, so even 8 KiB stays around 3,000 tokens. Search results are candidates; read gets the full text.
 */
const RECALL_BYTES = 4 * 1024;
const READ_BYTES = 8 * 1024;

export type Here = { place: Place | null; id: number | null };
export type Reply = Shown & { isError?: true };

const reply = (text: string): Reply => ({ text, items: [] });

const unregistered = (h: Here) =>
  h.place
    ? `This project (${head(h.place.name, 200)}) is not registered with Sphica. Register it with \`sphica init\` in the repository.`
    : "This location has no git remote or project name, so Sphica cannot tell which project it is.";

/**
 * A tool failure with its reason. Left thrown, the SDK returns only error.message, which is empty for an AggregateError
 * without a message (reason(), as in the CLI, includes the reasons of inner errors).
 */
const failed = (e: unknown): Reply => ({
  ...reply(`sphica: failed (${head(reason(e), 1000)})`),
  isError: true,
});

export type RecallArgs = {
  question?: string | undefined;
  mode?: "knowledge" | "avoid" | "said" | "resume" | undefined;
  who?: string | undefined;
  kinds?: (typeof KINDS)[number][] | undefined;
  match?: "words" | "exact" | undefined;
  path?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  all_projects?: boolean | undefined;
  cwd?: string | undefined;
  limit?: number | undefined;
};

export async function recall(
  db: Kysely<DB>,
  a: RecallArgs,
  where: (cwd?: string) => Promise<Here>,
  cwd: string,
): Promise<Reply> {
  try {
    const h = await where(a.cwd);
    if (!a.all_projects && h.id === null) return reply(unregistered(h));
    const projects: Scope = a.all_projects ? null : [h.id as number];
    const limit = a.limit ?? 5;
    const mode = a.mode ?? "knowledge";
    const file = a.path && h.place ? (relativeTo(h.place.root, a.path, a.cwd ?? cwd) ?? a.path) : a.path;

    if (mode === "resume") {
      const works = await openWork(db, projects, 10);
      if (works.length === 0) return reply("No work in progress.");
      const only =
        works.length === 1 && works[0] ? await workDetail(db, Number(works[0].ref.slice(2))) : null;
      if (only) return framedShown(renderWork(only, inFrame(RECALL_BYTES)), RECALL_BYTES);
      return framedShown(
        {
          text: `Work in progress (${works.length === 10 ? "up to " : ""}${works.length}, newest first). Pass the ref of the one to continue to read.\n\n${works
            .map(
              (w) =>
                `- ${head(w.title, 200)} (${w.project} / ${w.status} / ${w.ref})\n  Now: ${head(w.current, 300)}`,
            )
            .join("\n")}`,
          items: [],
        },
        RECALL_BYTES,
      );
    }
    if (mode === "said") {
      const hits = await searchMessages(db, {
        question: a.question,
        projects,
        who: a.who ?? "me",
        match: a.match,
        path: file,
        since: a.since,
        until: a.until,
        limit,
      });
      return hits.length
        ? framedShown(renderHits(hits, inFrame(RECALL_BYTES)), RECALL_BYTES)
        : reply("No matching messages.");
    }
    if (!a.question?.trim()) return reply("question is required (mode: knowledge / avoid).");
    const q = {
      question: a.question,
      projects,
      avoid: mode === "avoid",
      match: a.match,
      path: file,
      since: a.since,
      until: a.until,
      limit,
    };
    if (!a.kinds?.length) {
      const split = await searchSplit(db, q);
      if (!split.records.length && !split.documents.length)
        return reply(
          a.match !== "exact" && ftsQuery(a.question) === null
            ? "No searchable terms (only hiragana or symbols). Use kanji, katakana, or English words, or search with match: exact."
            : "No matches. Search again with different words (synonyms, Japanese or English, short words, match: exact).",
        );
      return framedShown(splitJson(split, inFrame(RECALL_BYTES)), RECALL_BYTES);
    }
    const hits = await searchKnowledge(db, { ...q, kinds: a.kinds });
    return hits.length
      ? framedShown(renderHits(hits, inFrame(RECALL_BYTES)), RECALL_BYTES)
      : reply("No matches. Search again with different words.");
  } catch (e) {
    return failed(e);
  }
}

export type ReadArgs = { refs: string[]; all_projects?: boolean | undefined; cwd?: string | undefined };

/** Same scope as recall. Refs to other projects written in records are not readable unless asked for explicitly. */
export async function readTool(
  db: Kysely<DB>,
  a: ReadArgs,
  where: (cwd?: string) => Promise<Here>,
): Promise<Reply> {
  try {
    const h = await where(a.cwd);
    if (!a.all_projects && h.id === null) return reply(unregistered(h));
    const projects: Scope = a.all_projects ? null : [h.id as number];
    return framedShown(await read(db, a.refs, inFrame(READ_BYTES), { projects }), READ_BYTES);
  } catch (e) {
    return failed(e);
  }
}

/** The people tool: everyone in the directory with their GitHub handles (shared by every project). Names come from GitHub, so they go in the frame */
export async function peopleTool(db: Kysely<DB>): Promise<Reply> {
  try {
    const people = await directory(db);
    const body = people.length
      ? people
          .map(
            (p) =>
              `- ${inline(p.display)}${p.isSelf ? " (the owner)" : ""}: ${p.handles.map(inline).join(", ") || "no handles"}`,
          )
          .join("\n")
      : "The directory is empty. The owner links people with `sphica who <name> <handle>...`.";
    return framedShown({ text: body, items: [] }, READ_BYTES);
  } catch (e) {
    return failed(e);
  }
}
