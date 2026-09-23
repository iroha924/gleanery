// 知識の種類と、それを読む側へ渡す札。
//
// 種類と状態の組、発言の主、会話の出どころ、ファイルとの関係は db/schema.sql の CHECK が正本で、ここはその写し
// （scripts/check-pairs.mjs が突き合わせる）。コードはこの写しだけを参照する。
// 札は AI が意味を見分ける手がかりになる。素の本文だけを渡すと、棄却した案が
// 文字面の近さで 1 位に来る（「自動発火する？」に『自動発火もさせる』を返した実測がある）。

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

// self は持ち主、assistant は AI（coding session の最後の応答と AI レビュアー）、bot は推論を含まない自動通知。
export const SPEAKERS = ["self", "person", "assistant", "bot"] as const;
export type SpeakerKind = (typeof SPEAKERS)[number];

export const ORIGINS = ["claude-code", "codex", "github"] as const;
export type Origin = (typeof ORIGINS)[number];

// edit は編集、review はレビューで指されたファイル。read は以前に読んだ要件定義・設計書の記録で、新しくは書かない。
export const FILE_ACTIONS = ["edit", "read", "review"] as const;
export type FileAction = (typeof FILE_ACTIONS)[number];

// 状態を持つ種類は全部の状態に、持たない種類は 1 つの札を持つ（型が漏れを止める）。文書の札は置き場所で決める。
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

/** 文書の札は、置き場所から決める。ADR は、説明文と重みが違う。 */
function documentLabel(path: string | null | undefined): string {
  if (path && (/(^|\/)adrs?\//i.test(path) || /(^|\/)\d{4}-[^/]+\.mdx?$/.test(path)))
    return "【決定の記録・ADR】";
  return "【文書】";
}

export function labelOf(k: { kind: string; status: string | null; path?: string | null }): string {
  if (k.kind === "document") return documentLabel(k.path);
  const l = (LABEL as Record<string, string | Record<string, string>>)[k.kind];
  return typeof l === "string" ? l : ((k.status && l?.[k.status]) ?? "");
}

/**
 * 検索の対象にする発言か。coding session の AI の応答は、前後の turn を読むために保存するが索引しない。
 * 「私はなんて言った？」の候補を AI の長い応答が押し出すため。
 */
export const indexesMessage = (origin: string, speakerKind: string): boolean =>
  speakerKind !== "bot" && !(origin !== "github" && speakerKind === "assistant");

/**
 * 会話の id。GitHub の同期・trace・自動記録が同じ規則で作るので、どれが先に書いても同じ行になる。
 * プロジェクトをまたいだ session（途中で別のリポジトリへ移った）は、プロジェクトごとに別の会話になる。
 */
export const conversationId = (projectId: number, origin: Origin, externalId: string): string =>
  uuidFrom(String(projectId), origin, externalId);
