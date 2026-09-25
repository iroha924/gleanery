// Extra search words for a record (knowledge_terms): the one check every writer goes through (trace, PR Terms lines, owner import).
// They are indexed but never shown, so the check bounds size and rejects characters that cannot be read, not wording.

const MAX_TERMS = 16;
const MAX_TERM = 40;
/** Counted in code points, the same unit as SQLite length() in the table CHECK. */
const MAX_TOTAL = 400;
// Control characters, and format characters other than the joiners some scripts need to render
const UNREADABLE = /[\p{Cc}\p{Cf}]/u;
const JOINERS = /[‌‍]/gu;

/**
 * Normalizes terms given as a list or a comma-separated string: NFKC, whitespace collapsed, blanks and repeats dropped.
 * Returns them joined by ", ", or "" when none remain. Throws a RangeError naming the rule a term breaks.
 */
export function searchTerms(input: string | string[]): string {
  const raw = typeof input === "string" ? input.split(",") : input;
  const terms: string[] = [];
  for (const r of raw) {
    const t = r.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!t || terms.includes(t)) continue;
    if (UNREADABLE.test(t.replace(JOINERS, "")))
      throw new RangeError(`search term has a control or invisible character: ${JSON.stringify(t)}`);
    if ([...t].length > MAX_TERM)
      throw new RangeError(`search term longer than ${MAX_TERM} characters: ${t}`);
    terms.push(t);
  }
  if (terms.length > MAX_TERMS) throw new RangeError(`more than ${MAX_TERMS} search terms (${terms.length})`);
  const joined = terms.join(", ");
  if ([...joined].length > MAX_TOTAL)
    throw new RangeError(`search terms longer than ${MAX_TOTAL} characters in all`);
  return joined;
}
