// Session metrics from one question's trace. Each recall / read call is replayed through the product's tool functions on the run's DB.
// A call counts only when the replayed text matches the recorded response (frame tags aside); its refs are then the records the renderer
// showed in full. A call that does not match is unconfirmed, never "the answer did not appear".

import type { Kysely } from "kysely";
import type { DB } from "../../src/db-types.ts";
import { identify, projectId } from "../../src/project.ts";
import { type Shown, WORDS } from "../../src/search.ts";
import { type Here, type ReadArgs, type RecallArgs, type Reply, readTool, recall } from "../../src/tools.ts";

type Event = { type?: string; [k: string]: unknown };
type Block = {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  text?: string;
};

const RECALL = "mcp__sphica__recall";
const READ = "mcp__sphica__read";

/** One recorded tool call with the response the agent received. */
export type Call = {
  tool: "recall" | "read" | "other";
  input: Record<string, unknown>;
  /** The recorded response: its text blocks, and the kinds of all its blocks */
  text: string;
  blocks: string[];
  bytes: number;
  error: boolean;
  /** The trace shows the call was refused before it ran (a permission refusal, or MCP input validation), so it showed nothing */
  rejected: boolean;
  /** A Codex built-in that listed the configured MCP servers' resources and got an empty list: it showed nothing */
  inert?: boolean;
  /** A Codex item that started and never finished: what it did or showed is unknown */
  unfinished?: boolean;
};

/** Codex built-ins allowed only with exactly this empty result. sphica exposes no resources, so a nonempty one is not sphica's */
const EMPTY_LISTS: Record<string, string> = {
  list_mcp_resources: '{"resources":[]}',
  list_mcp_resource_templates: '{"resourceTemplates":[]}',
};

/** MCP rejects arguments that fail the tool's schema before the handler runs, with this code */
const INVALID_PARAMS = "MCP error -32602:";

const blocksOf = (e: Event): Block[] => {
  const content = (e.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
};

/** The sphica tool calls of a trace in the order they were made, each with its recorded result. */
export function callsOf(events: Event[]): Call[] {
  const results = new Map<string, Block>();
  // Claude Code marks a call it refused before running it twice: a permission_denied event and non_execution_kind on the result
  const denied = new Set<string>();
  const refused = new Set<string>();
  for (const e of events) {
    if (e.type === "system" && e.subtype === "permission_denied" && typeof e.tool_use_id === "string")
      denied.add(e.tool_use_id);
    if (e.type === "user") {
      for (const b of blocksOf(e))
        if (b.type === "tool_result" && b.tool_use_id) results.set(b.tool_use_id, b);
      for (const m of Array.isArray(e.tool_result_meta) ? e.tool_result_meta : [])
        if (m?.non_execution_kind === "user-rejected" && typeof m.id === "string") refused.add(m.id);
    }
  }
  const calls: Call[] = [];
  for (const e of events) {
    if (e.type !== "assistant") continue;
    for (const b of blocksOf(e)) {
      if (b.type !== "tool_use" || !b.id) continue;
      const r = results.get(b.id);
      const content = r?.content;
      const parts: Block[] =
        typeof content === "string"
          ? [{ type: "text", text: content }]
          : Array.isArray(content)
            ? content
            : [];
      const text = parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
      calls.push({
        tool: b.name === RECALL ? "recall" : b.name === READ ? "read" : "other",
        input: b.input ?? {},
        text,
        blocks: parts.map((p) => String(p.type)),
        bytes: Buffer.byteLength(text, "utf8"),
        error: r === undefined || r.is_error === true,
        rejected:
          r?.is_error === true &&
          ((denied.has(b.id) && refused.has(b.id)) ||
            (b.name !== undefined && text.startsWith(INVALID_PARAMS))),
      });
    }
  }
  return calls;
}

type CodexItem = {
  type?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown } | null;
  error?: unknown;
  status?: string;
};

/**
 * The tool calls of a `codex exec --json` stream, in the order they finished, then those that started and never finished (outcome
 * unknown, so they count as failed with no response). Every item other than the agent's messages and reasoning is a call; only
 * sphica's recall and read count as sphica tools.
 */
export function codexCallsOf(events: Event[]): Call[] {
  const calls: Call[] = [];
  const finished = new Set<unknown>();
  for (const e of events) if (e.type === "item.completed") finished.add((e.item as { id?: unknown })?.id);
  const unfinished = events
    .filter((e) => e.type === "item.started" && !finished.has((e.item as { id?: unknown })?.id))
    .map((e) => ({
      ...e,
      type: "item.completed",
      item: { ...(e.item as object), result: null, status: "unfinished" },
    }));
  for (const e of [...events, ...unfinished]) {
    if (e.type !== "item.completed") continue;
    const it = (e.item ?? {}) as CodexItem;
    if (it.type === "agent_message" || it.type === "reasoning") continue;
    const content = it.result?.content;
    const parts: Block[] = Array.isArray(content) ? (content as Block[]) : [];
    const text = parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
    const sphica = it.type === "mcp_tool_call" && it.server === "sphica";
    const error = it.status !== "completed" || (it.error !== null && it.error !== undefined);
    calls.push({
      tool: sphica && it.tool === "recall" ? "recall" : sphica && it.tool === "read" ? "read" : "other",
      input:
        it.arguments && typeof it.arguments === "object" ? (it.arguments as Record<string, unknown>) : {},
      text,
      blocks: parts.map((p) => String(p.type)),
      bytes: Buffer.byteLength(text, "utf8"),
      error,
      // Only input validation proves a refusal before running here; Codex reports other refusals like any failure
      rejected: sphica && error && text.startsWith(INVALID_PARAMS),
      unfinished: it.status === "unfinished",
      inert:
        it.type === "mcp_tool_call" &&
        it.server === "codex" &&
        !error &&
        EMPTY_LISTS[String(it.tool)] === text &&
        (it.arguments === undefined || JSON.stringify(it.arguments) === "{}"),
    });
  }
  return calls;
}

/** The frame tag is random per call. Replace a well-formed pair of tags (opening at the start, closing at the end) with a fixed one. */
function unframed(text: string): string | null {
  const m = /^\[record ([0-9a-f]{12}) begins\]/.exec(text);
  if (!m) return text;
  const n = m[1] as string;
  const open = WORDS.frameOpen(n);
  const close = WORDS.frameClose(n);
  if (!text.startsWith(open) || !text.endsWith(close)) return null;
  return `${WORDS.frameOpen("TAG")}${text.slice(open.length, text.length - close.length)}${WORDS.frameClose("TAG")}`;
}

export type Replayed = Call & {
  /** The replayed response equals the recorded one (frame tags aside), so its refs describe what the agent received */
  matched: boolean;
  why?: string;
  items: Shown["items"];
};

/** Replays each call on db with the tool functions the MCP server uses, from the working directory the run used. */
export async function replay(calls: Call[], db: Kysely<DB>, cwd: string): Promise<Replayed[]> {
  // The MCP server resolves the project the same way (mcp.ts here()), without its cache
  const where = async (c?: string): Promise<Here> => {
    const place = identify(c ?? cwd);
    return { place, id: place ? await projectId(db, place.key) : null };
  };
  const out: Replayed[] = [];
  for (const c of calls) {
    if (c.tool === "other") {
      out.push({ ...c, matched: false, why: "not a sphica tool", items: [] });
      continue;
    }
    // Refused before the handler ran, so there is nothing to replay: it showed no record
    if (c.rejected) {
      out.push({ ...c, matched: true, items: [] });
      continue;
    }
    let r: Reply;
    try {
      r =
        c.tool === "recall"
          ? await recall(db, c.input as RecallArgs, where, cwd)
          : await readTool(db, c.input as ReadArgs, where);
    } catch (e) {
      out.push({
        ...c,
        matched: false,
        why: `replay failed: ${e instanceof Error ? e.message : e}`,
        items: [],
      });
      continue;
    }
    const recorded = unframed(c.text);
    const replayed = unframed(r.text);
    const why =
      c.blocks.length !== 1 || c.blocks[0] !== "text"
        ? `recorded blocks ${c.blocks.join(",") || "none"}`
        : c.error !== (r.isError === true)
          ? "error flag differs"
          : recorded === null || replayed === null
            ? "frame tags malformed"
            : recorded !== replayed
              ? "text differs"
              : undefined;
    out.push({ ...c, matched: why === undefined, ...(why ? { why } : {}), items: why ? [] : r.items });
  }
  return out;
}

export type Session = {
  calls: number;
  recalls: number;
  reads: number;
  errors: number;
  /** Calls whose replay did not match the recorded response: what they showed is unknown */
  unconfirmed: number;
  /** Calls to anything but sphica's recall and read that the trace does not show were refused before running. Any makes the run ineligible */
  disallowed: number;
  /** Calls refused before running (they showed nothing) */
  rejected: number;
  /** Codex built-ins that listed no MCP resources (they showed nothing) */
  inert?: number;
  /** Matched recall calls that showed no record */
  empty: number;
  bytes: number;
  /** Which tool first showed the answer in full, or null if no matched call did */
  exposed: "recall" | "read" | null;
  /** 1-based index of that call */
  first: number | null;
  /** Where the answer was shown in full at least once: recall's records or documents field, recall's rendered hits, or read */
  via: { records: boolean; documents: boolean; hits: boolean; read: boolean };
  /** For read: the answer was a ref the read asked for, or only a related option or verification shown inside another record */
  read: { requested: boolean; related: boolean };
  /** How the recall arguments were used: mode:<m>, match:<m>, and the other argument names given */
  usage: Record<string, number>;
};

const PLAIN = new Set(["question", "cwd", "all_projects", "limit", "mode", "match"]);

export function sessionOf(
  calls: Replayed[],
  keyOf: (ref: string) => string | null,
  expect: string[],
): Session {
  const usage: Record<string, number> = {};
  const count = (k: string) => {
    usage[k] = (usage[k] ?? 0) + 1;
  };
  const via = { records: false, documents: false, hits: false, read: false };
  const read = { requested: false, related: false };
  let exposed: Session["exposed"] = null;
  let first: number | null = null;
  for (const [i, c] of calls.entries()) {
    if (c.tool === "recall") {
      count(`mode:${String(c.input.mode ?? "knowledge")}`);
      if (c.input.match !== undefined) count(`match:${String(c.input.match)}`);
      for (const k of Object.keys(c.input)) if (!PLAIN.has(k)) count(k);
    }
    if (c.tool === "other") continue;
    const hits = c.items.filter((x) => expect.includes(keyOf(x.ref) ?? ""));
    if (hits.length === 0) continue;
    if (c.tool === "read") {
      via.read = true;
      const asked = new Set(Array.isArray(c.input.refs) ? c.input.refs.map(String) : []);
      for (const x of hits) read[asked.has(x.ref) ? "requested" : "related"] = true;
    } else for (const x of hits) via[x.field ?? "hits"] = true;
    if (exposed === null) {
      exposed = c.tool;
      first = i + 1;
    }
  }
  return {
    calls: calls.length,
    recalls: calls.filter((c) => c.tool === "recall").length,
    reads: calls.filter((c) => c.tool === "read").length,
    errors: calls.filter((c) => c.error).length,
    unconfirmed: calls.filter((c) => c.tool !== "other" && !c.matched).length,
    disallowed: disallowedOf(calls),
    rejected: calls.filter((c) => c.rejected).length,
    inert: calls.filter((c) => c.inert).length,
    // resume lists work items, which carry no result refs
    empty: calls.filter(
      (c) =>
        c.tool === "recall" && c.matched && c.input.mode !== "resume" && !c.error && c.items.length === 0,
    ).length,
    bytes: calls.reduce((s, c) => s + c.bytes, 0),
    exposed,
    first,
    via,
    read,
    usage,
  };
}

/** Calls to anything but sphica's recall and read that showed something, or may have: neither refused before running nor an empty resource list */
export const disallowedOf = (calls: Call[]) =>
  calls.filter((c) => c.tool === "other" && !c.rejected && !c.inert).length;
