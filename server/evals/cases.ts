// Questions whose answers point to sections of removed Skills (requirements, design, init, winnow). They stay in retrieval.json so the
// indexes (the dev / holdout split) and the question set fingerprint do not change, and are dropped before running.
export const retired = (c: { expect: string[] }): boolean =>
  c.expect.some((e) => /^doc:plugin\/skills\/(requirements|design|init|winnow)\//.test(e));

/** Splits off questions whose answer is not in the measured DB. Scored, they would count as search misses. */
export function splitStale<C extends { expect: string[] }>(cases: C[], known: Set<string>) {
  const live: C[] = [];
  const stale: C[] = [];
  for (const c of cases) (c.expect.some((e) => known.has(e)) ? live : stale).push(c);
  return { live, stale };
}

// Numbers are the case indexes in retrieval.json and never change. Tune the tools on dev (even knowledge indexes) and run holdout (odd)
// only for the gate decision (tuning against it would make the gate measure work in progress). message answers are message ids.
type SplitCase = { source: string; expect: string[] };
export const SPLITS = {
  dev: (c: SplitCase, i: number) => c.source !== "message" && i % 2 === 0 && !retired(c),
  holdout: (c: SplitCase, i: number) => c.source !== "message" && i % 2 === 1 && !retired(c),
  message: (c: SplitCase) => c.source === "message" && !retired(c),
} as const;
export type Split = keyof typeof SPLITS;
