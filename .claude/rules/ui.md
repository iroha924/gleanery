---
paths:
  - "server/src/tui/**/*.ts"
  - "server/src/palette.ts"
---

# Terminal screen and CLI output

Read the `tui` Skill first.

- Write with `createElement`, not JSX (src runs directly through Node's type stripping, and Node cannot read JSX) <!-- invariant: create-element -->
- Refer to colors by name from `server/src/palette.ts` and symbols from `server/src/tui/icons.ts`. Do not write hex values or symbols directly <!-- invariant: palette-icons -->
- Print CLI output with the parts in `server/src/tui/view.ts`. Indent the content and put only the closing line at the start of the line (so text from outside cannot forge lines) <!-- invariant: view-parts -->
