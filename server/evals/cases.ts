// Questions whose answers point to sections of removed Skills (requirements, design, init, winnow). They stay in retrieval.json so the
// indexes (the dev / holdout split) and the question set fingerprint do not change, and are dropped before running.
export const retired = (c: { expect: string[] }): boolean =>
  c.expect.some((e) => /^doc:plugin\/skills\/(requirements|design|init|winnow)\//.test(e));
