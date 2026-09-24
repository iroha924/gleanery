---
name: tui
description: Changes gleanery's terminal screen (`gleanery dashboard`, Ink in server/src/tui/) and the look of CLI output (server/src/tui/view.ts). Use when touching screens, key bindings, list and detail views, the shape of CLI output, symbols and icons, Markdown rendering, or the CLI bundle. Also use when changing how sessions and work are read (server/src/sessions.ts) for the screen. Not for changes only to MCP or other CLI commands, or to the DB schema.
---

# Change the terminal screen

`gleanery dashboard` is a terminal screen drawn with Ink, and it **only reads**.

## Triggers

- Changing screens, key bindings, or views in `server/src/tui/`
- Changing what the screen reads (`server/src/sessions.ts`, `server/src/tui/data.ts`)
- Changing the shape of CLI output (`server/src/tui/view.ts`: headings, sections, indentation, the closing line)
- Changing icons (`server/src/tui/icons.ts`), Markdown rendering (`markdown.ts`), or the CLI bundle (`scripts/bundle-cli.ts`)

## Does not trigger

- Changing only MCP, other CLI commands, or ingestion
- Changing the DB schema or connection roles. Use `knowledge-schema` for that
- Bumping the version and shipping. Use `plugin-release` for that (the TUI is part of the CLI, so the release kind is `plugin`)

## What to know about the dependencies

Do not pick APIs from memory. `server/package.json` is the source of truth for versions; read the API in the type definitions (`.d.ts`) in `server/node_modules/<package>`.
The facts below can break when a version goes up, so after bumping one, check them again against the type definitions.

| Dependency | Facts that shape the conventions |
|---|---|
| ink | We use `useWindowSize`, `useInput(handler, { isActive })`, and `render(..., { alternateScreen })`. Only in development does it dynamically import `react-devtools-core` and `ws` (why the bundle replaces them) |
| @inkjs/ui | We use `TextInput` (`onSubmit`, `isDisabled`). Loading uses our own `Twinkle` (`TWINKLE` in `icons.ts`) |
| ink-scroll-view | Move it with the `ScrollView` ref's `scrollTo` (kept within `getBottomOffset`) / `scrollToTop` / `scrollToBottom`. `scrollBy` does not stop at the end of the body |
| ink-link | Its types make `children` a required prop |
| marked | **By the owner's decision, it is installed at a version outside marked-terminal's peer range (`<16`)** |
| marked-terminal | Ships no types. `@types/marked-terminal` pulls in an old marked, so it is not installed; `marked-terminal.d.ts` declares them |
| ink-testing-library | Rendering and `stdin.write` input work with the current Ink. If they stop working, switch to passing a fake stdout to `render` |

## Where things live

| File | What it holds |
|---|---|
| `tui/tui.ts` | The entry. Without a TTY, it prints guidance and exits. Opens and closes the reader connection |
| `tui/app.ts` | Tabs, key bindings, screens, and the action guide |
| `tui/data.ts` | The type of the reads the screen calls (`Data`) and the real implementation. Tests pass a fake `Data` |
| `tui/icons.ts` | The only place holding symbols and the loading spinner (`TWINKLE`), by name |
| `tui/markdown.ts` | Turns AI replies into ANSI |
| `sessions.ts` | Queries for the lists of sessions, projects, and work |

## How to write it

- **Write with `createElement` (`h`), not JSX.** This repository runs `src` directly through Node's type stripping (`node src/cli.ts`,
  `node --test`), and Node cannot read JSX
- Pass children from the third argument on (biome's `noChildrenProp`). Only for parts whose types make children a required prop (`ink-link`),
  pass them as props with a `biome-ignore` that states the reason. For our own parts, make children optional or use a prop with another name (`render`)
- **Do not write SQL in `tui/`.** Call the functions in `sessions.ts` and `search.ts` from `data.ts`. They are the same functions MCP and the CLI use,
  so the same words return the same ranking
- Only the reader connection. Do not import the ingest / capture / owner connections, or modules that write (`capture.ts`, `trace.ts`, and so on),
  from `tui/` (`server/test/tui.test.ts` checks this). **Do not add keys that start ingestion or trace**
- Open only the read-only connection (`openReader`) for the DB (`data.ts`). Do not import the write connection (`db-write.ts`) (`bun run architecture` stops it)

## Screen manners

- A screen that fetches data shows 4 states: loading, empty, failed, and succeeded (`useLoad` and `Pending`). Do not show empty and failure the same way.
  Start the failure text with what could not be read
- While a detail view is open, only hide the list with `display: "none"`. Rebuilding it loses the selected row, page, and
  search words when Esc goes back (hit in practice)
- In list rows, put fixed-width columns such as badges and dates in a Box with `flexShrink: 0`, and shrink only the title column, cut with `truncate-end`.
  Shrinking the others wraps Japanese badges midway and breaks the row (hit in practice)
- When you add a key, add it to the guide at the bottom of the screen too. While typing (the search input), do not fire single-key actions (`q`, `j`, `/`)
- **Use only the muted earth colors in `server/src/palette.ts`** (the owner's decision; do not write hex values elsewhere). The base is terracotta
  (headings, the selected row, tabs, ratio bars). `kindColor` decides a record's badge by kind and status. Paths to avoid and failures are rosewood,
  paths to take are sage, and stalled or unresolved items are ochre. "Decisions to avoid" (`rosewood`) and "failed or could not read" (`failure`) currently have the same
  value, but they mean different things, so they keep separate names. When a color gains a meaning, add a name, not a value
- Replace the colors of @inkjs/ui parts through the theme in `server/src/tui/theme.ts`. Leave falling back to terminals with fewer colors to chalk and Ink

## Icons

Refer to them by name from `icons.ts`, and do not write symbols in screen code. **Use only standard Unicode symbols** (the owner's decision; do not
require a Nerd Font). Nerd Font symbols live in the private use area and show as □ in terminals without that font. Standard symbols are drawn by the OS's
fallback font even when the terminal's font lacks them.

When adding one, pick a symbol that meets these (check with Python's `unicodedata.east_asian_width`).

- East Asian width is neutral (`N`). Ambiguous (`A`) becomes 2 columns under Japanese terminal settings and shifts columns. Wide (`W`) is always 2 columns
- It is not drawn as an emoji (does not match `\p{Emoji_Presentation}`). `test/tui.test.ts` checks for private use characters and emoji

The loading spinner (`TWINKLE`) goes back and forth through similar-looking stars, as Claude Code does. `·` and `✽` have ambiguous width, so the drawing side puts them in a
2-column box so they do not shift the characters beside them.

## Markdown

`renderMarkdown(text, width)` keeps one `Marked` instance per width. marked-terminal's quirks (the `##` of headings stays,
inline syntax inside list items is not drawn) are handled by the heading settings and a text renderer. After rendering, it keeps only colors (SGR) and drops
other control characters and hidden-text codes (Markdown turns character references back into characters). **After bumping marked, always pass the Markdown checks in the tests** (it is installed
outside its peer range, so install will not notice if it breaks).

## Bundle

The CLI draws both its output and the dashboard with Ink, so Ink is bundled into `plugin/dist/cli.js` (not split into another file).
`scripts/bundle-cli.ts` builds `cli.js` with `Bun.build` (called from `scripts/bundle.mjs`) and replaces `react-devtools-core` and `ws` with
empty modules (the path only runs in development, so behavior does not change). Bundling with the `bun build` command cannot do this replacement
and fails. MCP and capture (`mcp.js`, `capture.js`) do not load Ink.

## CLI output

CLI commands print with the parts in `server/src/tui/view.ts` (do not pass raw strings to `console.log`).

| Part | When to use it |
|---|---|
| `document(heading, summary, sections, closing)` | A result printed all at once. Sections are `table` (lists), `cards` (items with a Badge; search records), `fields` (items and values), `meter` (ratios), `note` (notices, empty), and `lines` |
| `failure(heading, reason)` | When it stops. A red Alert in a terminal |
| `steps(heading, steps, caution)` | Steps with commands to run. Commands do not wrap (no box when the width is too narrow) |
| `title`, `section`, `indent`, `closing` | Output that streams progress like harvest, or prints section by section like doctor |

- In a terminal, the heading box carries the summary, with blank lines after the heading, between sections, and before the closing line. Colors and decoration appear only when both stdout and stderr
  are terminals; in a pipe (an AI reading from Bash), print only indented text and do not wrap. The heading is one line, `✦ <text>`
- **Always indent the content, and put only the closing line at the start of the line.** Text from outside (PR titles, error text left in the DB) goes only inside
  boxes, cells, and indentation. Even with newlines, it cannot forge the closing line or status lines at the start of a line (`server/test/view.test.ts`, `cli.test.ts`)
- `search` in a pipe prints the same text as MCP, with the record fence (`framed`) (output an AI reads). In a terminal it prints `cards`
- The capture hooks do not load Ink, so they print in the shape of `server/src/panel.ts`
- The types of `@inkjs/ui` parts make children a required prop, so pass them through `part` in `view.ts`

## Verification

1. `bun run verify`. `server/test/tui.test.ts` draws a fake `Data` with `ink-testing-library`, sends keys, and checks the contents.
   When fixing something, confirm that the test fails on the code before the fix
2. **Unpack the package and run it in a terminal.** `bun run bundle` → `cd plugin && npm pack` → unpack outside the repository and
   start `node package/dist/cli.js dashboard` where there is no `node_modules` (when the AI has no terminal, give it a pseudo-terminal with
   `script -q /dev/null node package/dist/cli.js dashboard` (macOS) / `script -qc 'node package/dist/cli.js dashboard' /dev/null` (Linux) and send input).
   Go through: session list → Enter for details → Esc, Tab to the work list → Enter for details → Esc, Tab to search → type words and
   Enter → Enter on a result for the full text, then `q` and check for exit code 0. Started from a pipe, it prints guidance and exits with 1
3. Look with your own eyes that columns and borders line up with Japanese body text, and that the selected row stays on screen when the terminal is narrow
4. Before a commit that changes the screen, get the screen reviewed (in Claude Code, `review-ui`; it has a section on the terminal screen)
