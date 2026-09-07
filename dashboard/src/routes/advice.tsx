import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { api } from "@/lib/api";

export const Route = createFileRoute("/advice")({ component: AdvicePage });

/** 割合を 1 本の帯で。**数字だけだと「多いのか少ないのか」が読めない。** */
function Bar({ label, value, note, tone }: { label: string; value: number; note: string; tone: string }) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-3xl tabular-nums">{Math.round(value * 100)}</span>
        <span className="font-mono text-muted-foreground text-sm">%</span>
        <span className="text-sm">{label}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full" style={{ width: `${Math.round(value * 100)}%`, background: tone }} />
      </div>
      <p className="mt-1.5 text-muted-foreground text-xs">{note}</p>
    </div>
  );
}

function AdvicePage() {
  const { data, isPending } = useQuery({ queryKey: ["advice"], queryFn: api.advice });

  if (isPending) return <p className="text-muted-foreground text-sm">読み込んでいます</p>;
  if (!data || data.runs === 0) {
    return (
      <div className="space-y-2">
        <h1 className="font-medium text-lg">先に言う</h1>
        <p className="text-muted-foreground text-sm">
          編集フックがまだ一度も走っていません。Claude Code か Codex でファイルを編集すると、
          そのパスについて過去に言われたことをここに記録します。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="font-medium text-lg">先に言う</h1>
        <p className="text-muted-foreground text-sm">
          編集する前に、そのファイルについて過去に言われたことを出す。ここはその効き目。
        </p>
      </header>

      <section className="grid gap-8 sm:grid-cols-3">
        <Bar
          label="助言を出せた編集"
          value={data.spoke / Math.max(data.runs, 1)}
          note={`走った編集 ${data.runs} 回のうち ${data.spoke} 回`}
          tone="var(--primary)"
        />
        <Bar
          label="同じ助言の再提示"
          value={data.repeat}
          note="低いほどよい。高いなら抑制が効いていない"
          tone="var(--dont)"
        />
        <div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-3xl tabular-nums">{data.candidates.toFixed(1)}</span>
            <span className="text-sm">1 回あたりの候補</span>
          </div>
          <p className="mt-3.5 text-muted-foreground text-xs">
            候補があっても出すとは限らない。近さで足切りしている
          </p>
        </div>
      </section>

      {/* **「役に立ったか」はまだ取れない。**出したことは残るが、採用されたかは分からない。
          ここを埋めないと「賢くなっている」を主張できないので、欠けていることを画面に書く。 */}
      <p className="rounded-md border border-dashed p-3 text-muted-foreground text-xs leading-relaxed">
        役に立ったかどうかは取れていません。出したことは記録していますが、それが採用されたかを
        受け取る手段がまだ無く、上の 3 つは「出したか」までしか測っていません。
      </p>

      <section className="space-y-3">
        <h2 className="font-mono text-[10px] text-muted-foreground tracking-widest">直近の編集</h2>
        <ol className="space-y-2">
          {data.rows.map((r) => (
            <li
              key={`${r.at}:${r.path}`}
              className={`rounded-md border p-3 ${r.shown.length > 0 ? "bg-card" : "border-dashed"}`}
            >
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-[11px] text-muted-foreground">
                  {r.at.slice(0, 16).replace("T", " ")}
                </span>
                <span className="truncate font-mono text-xs">{r.path}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                  候補 {r.candidates}
                </span>
              </div>
              {r.shown.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {r.shown.map((s) => (
                    <li key={s} className="border-primary border-l-2 pl-2.5 text-sm leading-relaxed">
                      {s}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1.5 text-muted-foreground text-xs">黙った</p>
              )}
            </li>
          ))}
        </ol>
      </section>

      {data.byPath.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-mono text-[10px] text-muted-foreground tracking-widest">
            よく出しているファイル
          </h2>
          <ul className="space-y-1.5">
            {data.byPath.map((p) => (
              <li key={p.path} className="flex items-baseline gap-3 text-sm">
                <span className="w-8 shrink-0 text-right font-mono text-muted-foreground tabular-nums">
                  {p.n}
                </span>
                <span className="truncate font-mono text-xs">{p.path}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
