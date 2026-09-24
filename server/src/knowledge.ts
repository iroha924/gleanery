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
  "document",
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
  document: null,
} as const satisfies Record<Kind, readonly [string, ...string[]] | null>;

// self is you, assistant is AI (the last response of a coding session and AI reviewers), bot is automated notices without reasoning.
/** @public Read as text by scripts/check-pairs.mjs. */
export const SPEAKERS = ["self", "person", "assistant", "bot"] as const;
export type SpeakerKind = (typeof SPEAKERS)[number];

/** @public Read as text by scripts/check-pairs.mjs. */
export const ORIGINS = ["claude-code", "codex", "github"] as const;
export type Origin = (typeof ORIGINS)[number];

// edit is an edit, review is a file named in a review. read records requirements or design docs read earlier and is no longer written.
/** @public Read as text by scripts/check-pairs.mjs. */
export const FILE_ACTIONS = ["edit", "read", "review"] as const;
export type FileAction = (typeof FILE_ACTIONS)[number];

// Kinds with statuses have a label per status; kinds without have one label (the type catches omissions). Document labels depend on location.
type Labels = {
  [K in Exclude<Kind, "document">]: (typeof STATUSES)[K] extends readonly (infer S extends string)[]
    ? Record<S, string>
    : string;
};
const LABEL: Labels = {
  decision: {
    accepted: "【採用した決定】",
    proposed: "【提案どまり。まだ決まっていない】",
    rejected: "【却下した決定。採用していない】",
    superseded: "【後で覆した決定。もう有効ではない】",
  },
  option: {
    chosen: "【採用した案】",
    rejected: "【棄却した案】",
    was_chosen: "【当時は採った案。その決定はもう有効ではない】",
  },
  constraint: { active: "【変えてはいけない制約】", retired: "【外した制約】" },
  non_goal: { active: "【やらないと決めたこと】", retired: "【やらないことから外したこと】" },
  debt: { active: "【意図して残した負債。直しにいかない】", retired: "【返済した負債】" },
  dead_end: "【試して駄目だった】",
  finding: "【分かったこと】",
  verification: {
    passed: "【検証・通った】",
    failed: "【検証・落ちた。直っていない】",
    not_run: "【検証・未実行。確かめていない】",
  },
  question: { open: "【未解決の問い】", blocking: "【作業を止めている問い】", resolved: "【解決した問い】" },
};

/** English labels for the CLI and dashboard, kept short for narrow terminals. MCP keeps LABEL until it is translated too. */
const LABEL_EN: Labels = {
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

/** Document labels come from the location. ADRs carry different weight from explanatory docs. */
function documentLabel(path: string | null | undefined, lang: "ja" | "en"): string {
  const adr = !!path && (/(^|\/)adrs?\//i.test(path) || /(^|\/)\d{4}-[^/]+\.mdx?$/.test(path));
  if (lang === "en") return adr ? "[decision record]" : "[document]";
  return adr ? "【決定の記録・ADR】" : "【文書】";
}

export function labelOf(
  k: { kind: string; status: string | null; path?: string | null },
  lang: "ja" | "en" = "ja",
): string {
  if (k.kind === "document") return documentLabel(k.path, lang);
  const l = ((lang === "en" ? LABEL_EN : LABEL) as Record<string, string | Record<string, string>>)[k.kind];
  return typeof l === "string" ? l : ((k.status && l?.[k.status]) ?? "");
}

/**
 * Whether a message is searchable. AI responses in coding sessions are stored to read nearby turns but are not indexed,
 * because long AI responses would crowd out candidates for "what did I say?".
 */
export const indexesMessage = (origin: string, speakerKind: string): boolean =>
  speakerKind !== "bot" && !(origin !== "github" && speakerKind === "assistant");

/**
 * The conversation id. GitHub sync, trace, and recording use the same rule, so whichever writes first creates the same row.
 * A session that moved between projects (to another repository midway) becomes a separate conversation per project.
 */
export const conversationId = (projectId: number, origin: Origin, externalId: string): string =>
  uuidFrom(String(projectId), origin, externalId);
