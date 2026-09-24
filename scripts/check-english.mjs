#!/usr/bin/env node
// Keeps English-only files free of Japanese. gleanery is moving to English one area at a time,
// and a file that was translated drifts back unless something stops it.
//
// Records that users write stay in their own language. Only the text gleanery itself writes is checked.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { englishProblems } from "./lib/english.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Strings, templates, and comments must be English. Grows with each translation stage. */
const ENGLISH = [
  "server/src/cli.ts",
  "server/src/tui/app.ts",
  "server/src/tui/data.ts",
  "server/src/tui/icons.ts",
  "server/src/tui/markdown.ts",
  "server/src/tui/marked-terminal.d.ts",
  "server/src/tui/theme.ts",
  "server/src/tui/tui.ts",
  "server/src/tui/view.ts",
  "server/src/admin.ts",
  "server/src/plugin.ts",
  "server/src/sqlite.ts",
  "server/src/project.ts",
  "server/src/assets.ts",
  "server/src/trace.ts",
  "server/src/sessions.ts",
  "server/src/db.ts",
  "server/src/db-write.ts",
  "server/src/text.ts",
  "server/src/docs.ts",
  "scripts/check-english.mjs",
  "scripts/check-commit-msg.mjs",
  "scripts/lib/commit-msg.mjs",
  "scripts/lib/japanese.mjs",
  "scripts/lib/english.mjs",
];

/** Comments must be English. Strings still hold Japanese that MCP or the database relies on. */
const COMMENTS = [
  "server/src/knowledge.ts",
  "server/src/search.ts",
  "server/src/github.ts",
  "server/src/capture.ts",
];

let count = 0;
for (const [files, mode] of [
  [ENGLISH, "all"],
  [COMMENTS, "comments"],
]) {
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const p of englishProblems(source, mode)) {
      console.error(`${file}:${p.line}: ${p.reason}: ${p.text}`);
      count++;
    }
  }
}
if (count) {
  console.error(
    `\n${count} problem(s). Write these in English, or mark a required Japanese literal with // english-exempt: <reason>.`,
  );
  process.exit(1);
}
console.log(`english: ${ENGLISH.length} English-only files, ${COMMENTS.length} files with English comments`);
