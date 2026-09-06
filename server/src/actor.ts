// 発言者が人か、AI か、自動通知かを決める。
//
// **スキーマには最初から actor_kind in ('human','ai','ci','unknown') があるのに、
// 取り込みが全部 'human' で書いていた。**その結果、ナレッジ 34,591 件のうち
// 14,852 件（43%）が Terraform の plan 結果・デプロイプレビューの URL・カバレッジ表で、
// それが人の発言と同じ土俵で検索の上位 12 件を奪い合っていた（実測）。
//
// **AI のレビューは落とさない。**gemini-code-assist と coderabbitai の指摘は
// 中身がある（CI 的な定型は 5,300 件中 252 件しかない）。落とすのは推論を含まない通知だけ。
//
// 名前で決めるのは、本文で判定すると書式が変わるたびに漏れるから。
// 新しい bot が増えたら画面の「まだ決めていない名前」に件数付きで出るので気付ける。
const AI_REVIEWERS = new Set([
  "gemini-code-assist[bot]",
  "coderabbitai[bot]",
  "cursor[bot]",
  "claude[bot]",
  "chatgpt-codex-connector[bot]",
  "Copilot",
]);

export type ActorKind = "human" | "ai" | "ci";

export function actorKind(name: string): ActorKind {
  if (AI_REVIEWERS.has(name)) return "ai";
  // それ以外の bot は状態通知。Terraform の結果、デプロイ URL、カバレッジ表、
  // 依存更新、issue との紐付け通知。どれも「なぜそうしたか」を含まない。
  if (name.endsWith("[bot]")) return "ci";
  return "human";
}

/** 取り込むかどうか。**自動通知はナレッジではないので入れない。** */
export const isNoise = (name: string): boolean => actorKind(name) === "ci";
