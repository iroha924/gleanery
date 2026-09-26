// Adopt or reject a setup against the base by the rule fixed before measuring (the thresholds are listed in .claude/rules/evals.md).
// A question counts as solved when more than half of the runs put the answer first. The rule is a preset bar, not a statistical test.

export type Run = {
  /** Answer rank per question (0 is first, -1 missed) */
  ranks: Map<number, number>;
  top1: number;
  /** Share of questions whose top hit the judge graded direct (percent) */
  direct: number;
  turns: number;
  toolKib: number | null;
  errors: number;
};

export type Verdict = {
  gained: number[];
  lost: number[];
  net: number;
  top1: [base: number, setup: number];
  direct: [base: number, setup: number];
  turns: [base: number, setup: number];
  toolKib: [base: number | null, setup: number | null];
  adopt: boolean;
  /** Why it was not adopted, or "equivalent" for a net of -1..+1 */
  reasons: string[];
};

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
const round = (x: number) => Math.round(x * 10) / 10;
const meanOrNull = (xs: (number | null)[]) => (xs.some((x) => x === null) ? null : mean(xs as number[]));
const shown = (x: number | null) => (x === null ? null : round(x));

export function solved(runs: Run[]): Set<number> {
  const count = new Map<number, number>();
  for (const r of runs)
    for (const [i, rank] of r.ranks) if (rank === 0) count.set(i, (count.get(i) ?? 0) + 1);
  return new Set([...count].filter(([, n]) => n * 2 > runs.length).map(([i]) => i));
}

export function verdict(base: Run[], setup: Run[]): Verdict {
  const b = solved(base);
  const s = solved(setup);
  const gained = [...s].filter((i) => !b.has(i)).sort((x, y) => x - y);
  const lost = [...b].filter((i) => !s.has(i)).sort((x, y) => x - y);
  const net = gained.length - lost.length;
  // Compare unrounded means; round only what is returned for display
  const pair = (f: (r: Run) => number): [number, number] => [mean(base.map(f)), mean(setup.map(f))];
  const top1 = pair((r) => r.top1);
  const direct = pair((r) => r.direct);
  const turns = pair((r) => r.turns);
  const toolKib: [number | null, number | null] = [
    meanOrNull(base.map((r) => r.toolKib)),
    meanOrNull(setup.map((r) => r.toolKib)),
  ];
  const reasons: string[] = [];
  if (net < 2) reasons.push(net >= -1 ? "equivalent (net -1..+1)" : `net ${net}`);
  if (top1[1] < top1[0]) reasons.push("mean top1 fell");
  if (direct[1] < direct[0]) reasons.push("mean direct fell");
  if (turns[1] > turns[0] * 1.2) reasons.push("turns rose over 20%");
  if (toolKib[0] !== null && toolKib[1] !== null && toolKib[1] > toolKib[0] * 1.3)
    reasons.push("returned bytes rose over 30%");
  if (setup.reduce((a, r) => a + r.errors, 0) > base.reduce((a, r) => a + r.errors, 0))
    reasons.push("more errors");
  const two = (p: [number, number]): [number, number] => [round(p[0]), round(p[1])];
  return {
    gained,
    lost,
    net,
    top1: two(top1),
    direct: two(direct),
    turns: two(turns),
    toolKib: [shown(toolKib[0]), shown(toolKib[1])],
    adopt: reasons.length === 0,
    reasons,
  };
}

/** What must match for two setups to be compared (from each run's summary). */
export type Conditions = {
  cases: string;
  prompt: number | null;
  models: string;
  claude: string;
  effort: string;
  db: string | null;
  /** The snapshot the DB copy was made or migrated from */
  source: string | null;
  bundle: string | null;
  /** Hash of the memo each run placed as CLAUDE.md (null without one). Base and setup may differ; runs of one side may not */
  memo: string | null;
  /** claude or codex. Results of two hosts are never compared or averaged */
  host: string;
  /** Questions that used another tool or had an unconfirmed call, counted from the traces (null: not counted) */
  violations: number | null;
  /** false for a pilot or a run the budget stopped early */
  complete: boolean;
  /** Top hits the judge should have graded but did not (a failed grading call) */
  ungraded: number;
};

/** Why base and setup cannot be compared (empty when they can). A migrated copy compares only with copies of the same source snapshot. */
export function ineligible(base: Conditions[], setup: Conditions[], snapshot?: string): string[] {
  const out: string[] = [];
  // The solved rule is "2 of 3"; other counts would change it
  if (base.length !== 3 || setup.length !== 3) out.push("not exactly 3 runs each");
  if ([...base, ...setup].some((c) => !c.complete)) out.push("incomplete run");
  const all = [...base, ...setup];
  for (const k of ["host", "cases", "prompt", "models", "claude", "effort"] as const)
    if (new Set(all.map((c) => c[k])).size > 1) out.push(`${k} differ`);
  for (const k of ["prompt", "models", "claude", "bundle"] as const)
    if (all.some((c) => c[k] === null || c[k] === "")) out.push(`${k} not recorded`);
  for (const [side, cs] of [
    ["base", base],
    ["setup", setup],
  ] as const) {
    if (new Set(cs.map((c) => c.db)).size > 1) out.push(`${side} runs used different DB copies`);
    if (new Set(cs.map((c) => c.bundle)).size > 1) out.push(`${side} runs used different bundles`);
    if (new Set(cs.map((c) => c.memo)).size > 1) out.push(`${side} runs used different memos`);
  }
  if (all.some((c) => c.ungraded > 0)) out.push("the judge left top hits ungraded");
  // A run whose answers may have come from outside sphica's recall and read measures something else, however few such questions it has
  if (all.some((c) => c.violations === null)) out.push("tool use not counted from the traces");
  else if (all.some((c) => (c.violations ?? 0) > 0))
    out.push("a run used another tool or had calls whose replay did not match");
  if (all.some((c) => c.db === null || c.source === null)) out.push("DB not recorded");
  else if (snapshot !== undefined && all.some((c) => c.source !== snapshot))
    out.push("DB copies do not come from the question set's snapshot");
  else if (new Set(all.map((c) => c.source)).size > 1) out.push("DB copies come from different snapshots");
  return out;
}
