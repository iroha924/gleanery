// Checks commit messages: one Conventional Commits line in English.
// The commit-msg hook sees the message before Git strips comments, so an editor template (a blank line followed only by
// `#` lines) is ignored. Anything else counts; CI checks the stored messages again.

import { JAPANESE } from "./japanese.mjs";

const TYPES = "feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert";
const CONVENTIONAL = new RegExp(`^(?:${TYPES})(?:\\([a-z0-9-]+\\))?!?: \\S`);
const MAX = 100;
const MERGE = /^Merge (?:branch|remote-tracking branch|tag|commit|pull request) \S/;
/** The whole message `git revert` writes. */
const REVERT = /^Revert ".+"\n\nThis reverts commit [0-9a-f]{40}\.$/;
/** `git commit -v` appends the diff below this line; Git drops it and everything after it. */
const SCISSORS = /^# -+ >8 -+$/m;

/**
 * @param {string} text the message file as the hook receives it, or a stored message
 * @param {{ merge?: boolean }} [opts] merge: the commit is a merge (MERGE_HEAD exists, or it has two parents)
 * @returns {string[]} problems, empty when the message is fine
 */
export function commitMessageProblems(text, opts = {}) {
  const normalized = text.replace(/\r\n/g, "\n");
  const cut = normalized.search(SCISSORS);
  const kept = (cut === -1 ? normalized : normalized.slice(0, cut)).replace(/\n+$/, "");
  let lines = kept.split("\n");
  const blank = lines.indexOf("");
  if (blank > 0 && lines.slice(blank + 1).every((l) => l === "" || l.startsWith("#")))
    lines = lines.slice(0, blank);
  const [subject = "", ...rest] = lines;
  const problems = [];
  if (JAPANESE.test(lines.join("\n"))) problems.push("write the message in English");
  if ((opts.merge && MERGE.test(subject)) || REVERT.test(lines.join("\n"))) return problems;
  if (rest.some((l) => l !== "")) problems.push("use a one-line subject with no body");
  if (!CONVENTIONAL.test(subject))
    problems.push(`start with <type>(<scope>)?: where type is one of ${TYPES.replaceAll("|", ", ")}`);
  if (subject.length > MAX)
    problems.push(`keep the subject within ${MAX} characters (it has ${subject.length})`);
  return problems;
}
