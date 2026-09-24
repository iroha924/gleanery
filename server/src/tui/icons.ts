// Symbols used by the dashboard and the CLI. Screens refer to them by name and never write a symbol anywhere else.
// **Only standard Unicode symbols** (owner's decision, 2026-09-23: Nerd Fonts are not required). Private-use symbols render
// as □ in terminals without that font. Standard symbols fall back to an OS font. Pick symbols whose East Asian width is
// neutral (1 column); ambiguous ones take 2 columns in Japanese terminal settings and break alignment (test/tui.test.ts checks).

export const ICONS = {
  /** Headings in CLI output and screens */
  brand: "✦",
  /** Sessions (conversations) tab */
  sessions: "❝",
  /** Traced work tab */
  work: "✎",
  /** Search tab */
  search: "⌕",
  /** Your messages (a different symbol from the selected-row marker ❯) */
  self: "✐",
  /** AI responses */
  assistant: "✻",
  /** Messages from other people */
  person: "❖",
  /** Bot messages */
  bot: "⌬",
  /** Touched files */
  file: "❐",
  /** branch */
  branch: "⎇",
  /** Projects */
  project: "⌂",
  /** Traced decisions */
  decision: "✧",
  /** Paths to avoid */
  avoid: "✕",
  /** Open questions */
  question: "?",
  /** Goal */
  goal: "✪",
  /** Next steps */
  next: "➜",
  /** Status: in progress */
  active: "➤",
  /** Status: blocked */
  blocked: "✕",
  /** Status: on hold */
  paused: "❙",
  /** Status: done */
  done: "✓",
  /** Status: dropped */
  abandoned: "✗",
  /** Failures */
  error: "✘",
  /** Links to PRs and issues */
  link: "➚",
} as const;

type IconName = keyof typeof ICONS;

/**
 * Loading spinner. Cycles through similar stars and bounces back at the ends (the same look as Claude Code's spinner).
 * `·` and `✽` have ambiguous width and take 2 columns in some terminals, so callers draw them in a 2-column box.
 */
export const TWINKLE = ["·", "✢", "✳", "✶", "✻", "✽"] as const;

/** Symbol for a work status. Unknown statuses use the goal symbol (the database CHECK constrains values, so this is not expected). */
export function statusIcon(status: string): string {
  return status in ICONS ? ICONS[status as IconName] : ICONS.goal;
}
