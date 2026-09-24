// Checks commit messages: one Conventional Commits line in English.
// The commit-msg hook sees the message before Git strips comments, so an editor template (a blank line followed only by
// `#` lines) is ignored. Anything else counts; CI checks the stored messages again.

import { JAPANESE } from "./english.mjs";

const TYPES = "feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert";
const CONVENTIONAL = new RegExp(`^(?:${TYPES})(?:\\([a-z0-9-]+\\))?!?: \\S`);
const MAX = 100;
/** Messages Git writes itself. Their bodies are checked for Japanese only. */
const GENERATED = [/^Merge (?:branch|remote-tracking branch|tag|commit|pull request) \S/, /^Revert "/];

/**
 * @param {string} text the message file as the hook receives it, or a stored message
 * @returns {string[]} problems, empty when the message is fine
 */
export function commitMessageProblems(text) {
  let lines = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  const blank = lines.indexOf("");
  if (blank > 0 && lines.slice(blank + 1).every((l) => l === "" || l.startsWith("#")))
    lines = lines.slice(0, blank);
  const [subject = "", ...rest] = lines;
  const problems = [];
  if (JAPANESE.test(lines.join("\n"))) problems.push("write the message in English");
  if (GENERATED.some((re) => re.test(subject))) return problems;
  if (rest.some((l) => l !== "")) problems.push("use a one-line subject with no body");
  if (!CONVENTIONAL.test(subject))
    problems.push(`start with <type>(<scope>)?: where type is one of ${TYPES.replaceAll("|", ", ")}`);
  if (subject.length > MAX)
    problems.push(`keep the subject within ${MAX} characters (it has ${subject.length})`);
  return problems;
}
