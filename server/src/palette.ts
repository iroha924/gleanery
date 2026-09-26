// Colors of the marks (✓ △ ✗ ○) in hook and CLI output: muted earth tones (the owner's decision). Hex values appear nowhere else.
// chalk reduces them to the terminal's color depth. The rest of CLI output uses Clack's default colors.

export const PALETTE = {
  /** Passed */
  sage: "#9CAF88",
  /** Caution and needs a look */
  ochre: "#CFA764",
  /** Failures and read errors */
  failure: "#A85D5D",
  /** Neutral: missing, unknown, or just waiting */
  taupe: "#A99C8C",
} as const;
