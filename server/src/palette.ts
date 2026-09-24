// gleanery's colors: muted earth tones (the owner's decision). The CLI, the terminal screen, and hook output use the same values.
// Screen code refers to them by meaning, and hex values appear nowhere else. chalk and Ink reduce them to the terminal's color depth.

export const PALETTE = {
  /** gleanery's base color: titles, the selected row, tabs, and ratio bars (the owner's decision) */
  terracotta: "#C4704B",
  /** Paths to avoid (shifted toward red to tell it apart from terracotta) */
  rosewood: "#A85D5D",
  /** Failures and read errors. Currently the same color as paths to avoid, but a separate name because the meaning differs (so one can change alone) */
  failure: "#A85D5D",
  /** Paths to take, and passed */
  sage: "#9CAF88",
  /** Passed verifications (distinct from the green of paths to take) */
  lichen: "#8FAFA3",
  /** Caution, open questions, and blocked */
  ochre: "#CFA764",
  /** Findings, notices, and your messages */
  slate: "#8E9CB0",
  /** AI replies and recorded messages */
  plum: "#A7899F",
  /** Neutral, documents, and borders */
  taupe: "#A99C8C",
  /** Commands to run */
  sand: "#D6C4A2",
} as const;

/**
 * Colors for record labels. They vary by kind, and states that mean "avoid" lean toward red earth (the take and avoid polarity matches stance).
 * Unknown kinds are taupe (the database CHECK constrains the values, so this is not expected).
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
      // Message labels (mode: said) have no kind
      return c.plum;
  }
}
