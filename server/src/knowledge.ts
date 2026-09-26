// Knowledge kinds, and the labels passed to readers.
//
// Kind and status pairs, speakers, conversation origins, and file relations are defined by the CHECKs in db/schema.sql; this
// is a copy (scripts/check-pairs.mjs compares them). Code refers only to this copy.
// Labels are how an AI tells records apart. With bare text alone, a rejected option can rank first
// by wording (measured: asking "does it fire automatically?" returned the rejected "also let it fire automatically").

import { uuidFrom } from "./text.ts";

export const KINDS = [
  "decision",
  "option",
  "constraint",
  "non_goal",
  "dead_end",
  "finding",
  "debt",
  "verification",
  "question",
] as const;
export type Kind = (typeof KINDS)[number];

export const STATUSES = {
  decision: ["proposed", "accepted", "rejected", "superseded"],
  option: ["chosen", "rejected", "was_chosen"],
  constraint: ["active", "retired"],
  non_goal: ["active", "retired"],
  debt: ["active", "retired"],
  verification: ["passed", "failed", "not_run"],
  question: ["open", "blocking", "resolved"],
  dead_end: null,
  finding: null,
} as const satisfies Record<Kind, readonly [string, ...string[]] | null>;

// self is what the owner typed, assistant is the AI's last response in a coding session.
/** @public Read as text by scripts/check-pairs.mjs. */
export const SPEAKERS = ["self", "assistant"] as const;

/** @public Read as text by scripts/check-pairs.mjs. */
export const ORIGINS = ["claude-code", "codex"] as const;
export type Origin = (typeof ORIGINS)[number];

// edit is an edit. read records requirements or design docs read earlier and is no longer written.
/** @public Read as text by scripts/check-pairs.mjs. */
export const FILE_ACTIONS = ["edit", "read"] as const;
export type FileAction = (typeof FILE_ACTIONS)[number];

// Kinds with statuses have a label per status; kinds without have one label (the type catches omissions).
type Labels = {
  [K in Kind]: (typeof STATUSES)[K] extends readonly (infer S extends string)[] ? Record<S, string> : string;
};
const LABEL: Labels = {
  decision: {
    accepted: "[decision]",
    proposed: "[proposed decision]",
    rejected: "[rejected decision]",
    superseded: "[superseded decision]",
  },
  option: { chosen: "[chosen option]", rejected: "[rejected option]", was_chosen: "[former choice]" },
  constraint: { active: "[constraint]", retired: "[retired constraint]" },
  non_goal: { active: "[non-goal]", retired: "[former non-goal]" },
  debt: { active: "[intentional debt]", retired: "[repaid debt]" },
  dead_end: "[dead end]",
  finding: "[finding]",
  verification: { passed: "[verified]", failed: "[failed check]", not_run: "[not verified]" },
  question: { open: "[open question]", blocking: "[blocking question]", resolved: "[resolved question]" },
};

export function labelOf(k: { kind: string; status: string | null }): string {
  const l = (LABEL as Record<string, string | Record<string, string>>)[k.kind];
  return typeof l === "string" ? l : ((k.status && l?.[k.status]) ?? "");
}

/**
 * Whether a message is searchable. AI responses are stored to read nearby turns but are not indexed,
 * because long AI responses would crowd out candidates for "what did I say?".
 */
export const indexesMessage = (speakerKind: string): boolean => speakerKind === "self";

/**
 * The conversation id. trace and recording use the same rule, so whichever writes first creates the same row.
 * A session that moved between projects (to another repository midway) becomes a separate conversation per project.
 */
export const conversationId = (projectId: number, origin: Origin, externalId: string): string =>
  uuidFrom(String(projectId), origin, externalId);
