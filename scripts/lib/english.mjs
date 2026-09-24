// Finds Japanese text in the source of files that must be written in English.
// Tokens come from js-tokens, so a `//` inside a string or a multi-line template is read correctly.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// js-tokens is a devDependency of server. Resolve it from there instead of adding a root dependency.
const require = createRequire(path.join(root, "server/package.json"));
// biome-ignore lint/correctness/noUndeclaredDependencies: resolved from server/package.json devDependencies
const jsTokens = require("js-tokens");

/** Kana (with the shared middle dot U+30FB and long vowel mark U+30FC), kanji, CJK punctuation (U+3000-U+303F), and full-width forms (U+FF00-U+FFEF). */
export const JAPANESE =
  /[\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u;

/** A comment that allows Japanese in the tokens on the next line. The reason after the colon is required. */
const EXEMPT = /^\/\/\s*english-exempt:\s*(\S.*)$/;

const isComment = (t) => t.type === "SingleLineComment" || t.type === "MultiLineComment";

/**
 * @param {string} source
 * @param {"all" | "comments"} mode "all" checks strings, templates, and comments. "comments" checks comments only.
 * @returns {{ line: number, text: string, reason: string }[]}
 */
export function englishProblems(source, mode) {
  const problems = [];
  /** @type {Map<number, number>} exempted line -> line of the marker */
  const exempt = new Map();
  const used = new Set();
  const tokens = [];
  let line = 1;
  for (const t of jsTokens(source)) {
    tokens.push({ ...t, line });
    line += (t.value.match(/\r\n|[\n\r\u2028\u2029]/g) ?? []).length;
  }
  for (const t of tokens) {
    if (t.type === "SingleLineComment" && EXEMPT.test(t.value)) exempt.set(t.line + 1, t.line);
  }
  for (const t of tokens) {
    if (t.type === "WhiteSpace" || t.type === "LineTerminatorSequence") continue;
    if (mode === "comments" && !isComment(t)) continue;
    if (!JAPANESE.test(t.value)) continue;
    const marker = exempt.get(t.line);
    if (marker !== undefined && !isComment(t)) {
      used.add(marker);
      continue;
    }
    problems.push({ line: t.line, text: t.value.split(/\r?\n/)[0].slice(0, 80), reason: "Japanese text" });
  }
  for (const [, marker] of exempt) {
    if (!used.has(marker)) {
      problems.push({
        line: marker,
        text: "english-exempt",
        reason: "exemption with no Japanese on the next line",
      });
    }
  }
  return problems.sort((a, b) => a.line - b.line);
}
