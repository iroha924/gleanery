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

const RECALL = "mcp__gleanery__recall";
const READ = "mcp__gleanery__read";

/** One recorded tool call with the response the agent received. */
export type Call = {
  tool: "recall" | "read" | "other";
  input: Record<string, unknown>;
  /** The recorded response: its text blocks, and the kinds of all its blocks */
  text: string;
  blocks: string[];
  bytes: number;
  error: boolean;
};

const blocksOf = (e: Event): Block[] => {
  const content = (e.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
};

/** The gleanery tool calls of a trace in the order they were made, each with its recorded result. */
export function callsOf(events: Event[]): Call[] {
  const results = new Map<string, Block>();
  for (const e of events)
    if (e.type === "user")
      for (const b of blocksOf(e))
        if (b.type === "tool_result" && b.tool_use_id) results.set(b.tool_use_id, b);
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
      });
    }
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
      out.push({ ...c, matched: false, why: "not a gleanery tool", items: [] });
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
  /** Matched recall calls that showed no record */
  empty: number;
  bytes: number;
  /** Which tool first showed the answer in full, or null if no matched call did */
  exposed: "recall" | "read" | null;
  /** 1-based index of that call */
  first: number | null;
  /** Where the answer was shown in full at least once: recall's records or documents field, recall's rendered hits, or read */
  via: { records: boolean; documents: boolean; hits: boolean; read: boolean };
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
    if (c.tool === "read") via.read = true;
    else for (const x of hits) via[x.field ?? "hits"] = true;
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
    // resume lists work items, which carry no result refs
    empty: calls.filter(
      (c) =>
        c.tool === "recall" && c.matched && c.input.mode !== "resume" && !c.error && c.items.length === 0,
    ).length,
    bytes: calls.reduce((s, c) => s + c.bytes, 0),
    exposed,
    first,
    via,
    usage,
  };
}
