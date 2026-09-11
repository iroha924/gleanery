import type { CSSProperties } from "react";
import type { Phase } from "@/lib/api";

/** 済み・いま・これからを、色だけに頼らない 3 種類の面で示す。 */
export function Phases({ phases }: { phases: Phase[] }) {
  if (!phases?.length) return null;
  const done = phases.filter((p) => p.state === "done").length;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-base font-medium">進みかた</h3>
        <span className="text-sm text-muted-foreground tabular-nums">
          {phases.length} 工程中 {done} 完了
        </span>
      </div>

      <div className="overflow-x-auto pb-1">
        <ol
          className="grid min-w-[30rem] grid-cols-[repeat(var(--phase-count),minmax(0,1fr))] gap-1 overflow-hidden rounded-md bg-background/45 p-1 [--phase-count:1] sm:min-w-0"
          style={{ "--phase-count": phases.length } as CSSProperties}
        >
          {phases.map((p, i) => {
            const isDone = p.state === "done";
            const isNow = p.state === "doing";
            return (
              <li key={p.id} className="min-w-0">
                <span
                  className={[
                    "flex h-11 items-center justify-center rounded-md border px-3 text-center text-sm font-medium",
                    isDone
                      ? "border-accent bg-accent text-accent-foreground"
                      : isNow
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-foreground/15 bg-muted text-muted-foreground",
                  ].join(" ")}
                >
                  <span className="truncate">{p.label}</span>
                  <span className="sr-only">
                    {isDone ? "完了" : isNow ? "現在の工程" : `${i + 1} 番目の工程`}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
