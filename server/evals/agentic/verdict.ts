// Adopt or reject a setup against the base by the rule fixed before measuring (.claude/plans/2026/09/25-agentic-search.md).
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
const meanOrNull = (xs: (number | null)[]) =>
  xs.some((x) => x === null) ? null : round(mean(xs as number[]));

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
  const pair = (f: (r: Run) => number): [number, number] => [
    round(mean(base.map(f))),
    round(mean(setup.map(f))),
  ];
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
  return { gained, lost, net, top1, direct, turns, toolKib, adopt: reasons.length === 0, reasons };
}
