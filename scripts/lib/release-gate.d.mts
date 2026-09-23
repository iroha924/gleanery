export function gateProblems(input: {
  tag: string;
  commit: string;
  repo: string;
  versions: Record<string, string | undefined>;
  mainIsAncestor: boolean;
  tagCommit: string | null;
  pulls: unknown[];
  runs: unknown[];
}): { problems: string[]; pull: number | null };
