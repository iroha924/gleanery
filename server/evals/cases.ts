/** Splits off questions whose answer is not in the measured DB. Scored, they would count as search misses. */
export function splitStale<C extends { expect: string[] }>(cases: C[], known: Set<string>) {
  const live: C[] = [];
  const stale: C[] = [];
  for (const c of cases) (c.expect.some((e) => known.has(e)) ? live : stale).push(c);
  return { live, stale };
}

// Numbers are the case indexes in retrieval.json and never change. Tune on even indexes (dev) and run odd ones (holdout) only for the
// gate decision (tuning against them would make the gate measure work in progress). Message questions (answers are message ids) split the same way.
type SplitCase = { source: string };
export const SPLITS = {
  dev: (c: SplitCase, i: number) => c.source !== "message" && i % 2 === 0,
  holdout: (c: SplitCase, i: number) => c.source !== "message" && i % 2 === 1,
  "message-dev": (c: SplitCase, i: number) => c.source === "message" && i % 2 === 0,
  "message-holdout": (c: SplitCase, i: number) => c.source === "message" && i % 2 === 1,
} as const;
export type Split = keyof typeof SPLITS;
