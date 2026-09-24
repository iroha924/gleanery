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

/** Every file under dir whose name matches re, as a repository path. New files are checked without being listed. */
const filesUnder = (dir, re) =>
  fs
    .readdirSync(path.join(root, dir), { recursive: true })
    .map((f) => `${dir}/${f.split(path.sep).join("/")}`)
    .filter((f) => re.test(f))
    .sort();

/** Strings, templates, and comments must be English. Grows with each translation stage. */
const ENGLISH = [
  ...filesUnder("server/src", /\.tsx?$/),
  ...filesUnder("scripts", /\.(c?js|mjs|m?ts|tsx)$/),
  "server/evals/cases.ts",
  "server/evals/retrieval.ts",
  "server/test/assets.test.ts",
  "server/test/check-mcp-version.test.ts",
  "server/test/evals-run.test.ts",
  "server/test/migrate.test.ts",
  "server/test/plugin.test.ts",
  "server/test/project.test.ts",
  "server/test/release-gate.test.ts",
  "server/test/release-scope.test.ts",
  "server/test/sbom.test.ts",
  "server/test/tarball.test.ts",
  "server/test/temp-db.ts",
  "server/test/temp-repo.ts",
];

/** Comments must be English. Tests keep Japanese fixtures, and evals keep their measured prompts. */
const COMMENTS = [
  ...[...filesUnder("server/test", /\.ts$/), ...filesUnder("server/evals", /\.ts$/)].filter(
    (f) => !ENGLISH.includes(f),
  ),
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
