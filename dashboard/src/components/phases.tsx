import { CheckIcon } from "lucide-react";
import type { Phase } from "@/lib/api";

/**
 * 工程。**線でつないだ点にする。**
 * ただ縦に並べると「どこまで来たか」が読めない（前の版がそうだった）。
 * 済み・いま・これから の 3 状態を、形（塗り／輪郭）と太さで分ける。
 */
export function Phases({ phases }: { phases: Phase[] }) {
  if (!phases?.length) return null;
  const done = phases.filter((p) => p.state === "done").length;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">進みかた</h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {phases.length} 工程中 {done} 完了
        </span>
      </div>

      <ol className="flex">
        {phases.map((p, i) => {
          const isDone = p.state === "done";
          const isNow = p.state === "doing";
          return (
            <li key={p.id} className="relative flex min-w-0 flex-1 flex-col items-center gap-2">
              {/* 点と点をつなぐ線。済んだ区間は濃く、これからは薄く。 */}
              {i > 0 && (
                <span
                  className={`absolute right-1/2 top-[11px] h-0.5 w-full ${isDone || isNow ? "bg-foreground" : "bg-border"}`}
                  aria-hidden
                />
              )}
              <span
                className={[
                  "relative z-10 flex size-6 items-center justify-center rounded-full border-2 text-[10px] font-medium",
                  isDone
                    ? "border-foreground bg-foreground text-background"
                    : isNow
                      ? "border-foreground bg-background text-foreground ring-4 ring-foreground/10"
                      : "border-border bg-background text-muted-foreground",
                ].join(" ")}
              >
                {isDone ? <CheckIcon className="size-3.5" /> : i + 1}
              </span>
              <span
                className={`text-center text-[11px] leading-tight ${isNow ? "font-medium" : "text-muted-foreground"}`}
              >
                {p.label}
              </span>
              {isNow && <span className="text-[10px] text-muted-foreground">いまここ</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
