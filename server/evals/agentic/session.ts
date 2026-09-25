// Session metrics from one question's trace: what each recall / read call returned, and when the answer first appeared.
// Refs are taken from the structured parts of each response (the split JSON, the Source line of each rendered hit, the refs read asked for),
// never from the body text, which can quote other refs.

import { WORDS } from "../../src/search.ts";

type Event = { type?: string; [k: string]: unknown };
type Block = {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

const RECALL = "mcp__gleanery__recall";
const READ = "mcp__gleanery__read";
const REF = /^[kmsw]:[0-9a-f-]+$/;

export type Call = {
  tool: "recall" | "read" | "other";
  input: Record<string, unknown>;
  /** Refs the response presented as results (recall) or returned readable (read), in order */
  refs: string[];
  bytes: number;
  error: boolean;
};

const blocks = (e: Event): Block[] => {
  const content = (e.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
};

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("")
      : "";

/** Refs a recall response presented: the split JSON when present, otherwise the Source line of each rendered hit. */
function recallRefs(text: string): string[] {
  const at = text.indexOf('{"records"');
  if (at >= 0) {
    try {
      const json = JSON.parse(text.slice(at, text.lastIndexOf("}") + 1)) as {
        records?: { ref?: unknown }[];
        documents?: { ref?: unknown }[];
      };
      return [...(json.records ?? []), ...(json.documents ?? [])]
        .map((r) => r.ref)
        .filter((r): r is string => typeof r === "string");
    } catch {
      return [];
    }
  }
  const source = `  ${WORDS.source}: `;
  return text
    .split("\n")
    .filter((l) => l.startsWith(source))
    .map((l) => l.split(" / ").pop()?.trim() ?? "")
    .filter((r) => REF.test(r));
}

/** Refs read asked for, minus those it reported unreadable or missing. */
function readRefs(input: Record<string, unknown>, text: string): string[] {
  const asked = Array.isArray(input.refs) ? input.refs.filter((r): r is string => typeof r === "string") : [];
  return asked.filter((r) => REF.test(r) && !text.includes(`${r}: ${WORDS.missing}`));
}

/** The gleanery tool calls of a trace in the order they were made, each with its result. */
export function callsOf(events: Event[]): Call[] {
  const results = new Map<string, Block>();
  for (const e of events)
    if (e.type === "user")
      for (const b of blocks(e)) if (b.type === "tool_result" && b.tool_use_id) results.set(b.tool_use_id, b);
  const calls: Call[] = [];
  for (const e of events) {
    if (e.type !== "assistant") continue;
    for (const b of blocks(e)) {
      if (b.type !== "tool_use" || !b.id) continue;
      const tool = b.name === RECALL ? "recall" : b.name === READ ? "read" : "other";
      const input = b.input ?? {};
      const r = results.get(b.id);
      const text = textOf(r?.content);
      const error = r === undefined || r.is_error === true;
      calls.push({
        tool,
        input,
        refs: error
          ? []
          : tool === "recall"
            ? recallRefs(text)
            : tool === "read"
              ? readRefs(input, text)
              : [],
        bytes: Buffer.byteLength(text, "utf8"),
        error,
      });
    }
  }
  return calls;
}

export type Session = {
  calls: number;
  recalls: number;
  reads: number;
  errors: number;
  /** recall calls that returned no results */
  empty: number;
  bytes: number;
  /** Which tool first returned the answer, or null if no call did */
  exposed: "recall" | "read" | null;
  /** 1-based index of that call */
  first: number | null;
  /** How the recall arguments were used: mode:<m>, match:<m>, and the other argument names given */
  usage: Record<string, number>;
};

const PLAIN = new Set(["question", "cwd", "all_projects", "limit", "mode", "match"]);

export function sessionOf(calls: Call[], keyOf: (ref: string) => string | null, expect: string[]): Session {
  const usage: Record<string, number> = {};
  const count = (k: string) => {
    usage[k] = (usage[k] ?? 0) + 1;
  };
  let exposed: Session["exposed"] = null;
  let first: number | null = null;
  for (const [i, c] of calls.entries()) {
    if (c.tool === "recall") {
      count(`mode:${String(c.input.mode ?? "knowledge")}`);
      if (c.input.match !== undefined) count(`match:${String(c.input.match)}`);
      for (const k of Object.keys(c.input)) if (!PLAIN.has(k)) count(k);
    }
    if (exposed === null && c.tool !== "other" && c.refs.some((r) => expect.includes(keyOf(r) ?? ""))) {
      exposed = c.tool;
      first = i + 1;
    }
  }
  return {
    calls: calls.length,
    recalls: calls.filter((c) => c.tool === "recall").length,
    reads: calls.filter((c) => c.tool === "read").length,
    errors: calls.filter((c) => c.error).length,
    // resume lists work items, which carry no result refs
    empty: calls.filter(
      (c) => c.tool === "recall" && c.input.mode !== "resume" && !c.error && c.refs.length === 0,
    ).length,
    bytes: calls.reduce((s, c) => s + c.bytes, 0),
    exposed,
    first,
    usage,
  };
}
