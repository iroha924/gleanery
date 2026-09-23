// gleanery の色。くすんだアースカラーに寄せる（持ち主の決定）。CLI・端末の画面・フックの表示が同じ値を使う。
// 画面のコードは意味の名前で参照し、hex をここ以外に書かない。端末の色数に合わせて落とすのは chalk と Ink に任せる。

export const PALETTE = {
  /** gleanery のベースの色。見出し・選んでいる行・タブ・割合の棒（持ち主の決定） */
  terracotta: "#C4704B",
  /** 避ける道（テラコッタと見分けられるよう、赤みへ寄せる） */
  rosewood: "#A85D5D",
  /** 失敗・読めなかった。いまは避ける道と同じ色だが、意味が違うので名前を分けて持つ（片方だけを変えられるように） */
  failure: "#A85D5D",
  /** 採る道・通った */
  sage: "#9CAF88",
  /** 検証が通った（採る道の緑と分ける） */
  lichen: "#8FAFA3",
  /** 注意・未解決の問い・止まっている */
  ochre: "#CFA764",
  /** 分かったこと・お知らせ・持ち主の発言 */
  slate: "#8E9CB0",
  /** AI の応答・発言の記録 */
  plum: "#A7899F",
  /** どちらでもない・文書・枠 */
  taupe: "#A99C8C",
  /** 打つ command */
  sand: "#D6C4A2",
} as const;

export type PaletteName = keyof typeof PALETTE;

/**
 * 記録の札の色。種類で分け、状態で「避ける道」を赤土へ寄せる（採る・避けるの極性は stance と同じ向き）。
 * 知らない種類は taupe（DB の CHECK が値を縛るので、ここへは来ない想定）。
 */
export function kindColor(kind: string, status: string | null): string {
  const c = PALETTE;
  switch (kind) {
    case "decision":
      return status === "accepted" ? c.sage : status === "proposed" ? c.taupe : c.rosewood;
    case "option":
      return status === "chosen" ? c.sage : c.rosewood;
    case "verification":
      return status === "passed" ? c.lichen : status === "failed" ? c.rosewood : c.ochre;
    case "question":
      return status === "resolved" ? c.taupe : c.ochre;
    case "constraint":
    case "non_goal":
    case "debt":
      return status === "retired" ? c.taupe : c.rosewood;
    case "dead_end":
      return c.rosewood;
    case "finding":
      return c.slate;
    case "document":
      return c.taupe;
    default:
      // 発言（mode: said）の札は種類を持たない
      return c.plum;
  }
}
