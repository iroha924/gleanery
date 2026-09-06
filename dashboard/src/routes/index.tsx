import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Skeleton } from "@/components/ui/skeleton";
import type { Now, Phase } from "@/lib/api";
import { api } from "@/lib/api";

export const Route = createFileRoute("/")({ component: Home });

/** 工程。いまどこかが一目で分かればいいので、線と点だけで出す。 */
function Phases({ phases }: { phases: Phase[] }) {
  if (!phases?.length) return null;
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 text-sm">
      {phases.map((p, i) => (
        <li key={p.id} className="flex items-center gap-1">
          {i > 0 && <span className="mr-1 h-px w-4 bg-border" aria-hidden />}
          <span
            className={
              p.state === "doing"
                ? "rounded-full bg-foreground px-2.5 py-0.5 text-background"
                : p.state === "done"
                  ? "text-muted-foreground line-through decoration-border"
                  : "text-muted-foreground"
            }
          >
            {p.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Card({ w }: { w: Now }) {
  const mine = w.next.filter((n) => n.who === "human");
  const ai = w.next.filter((n) => n.who === "ai");
  const constraints = w.walls.filter((x) => x.subkind === "constraint");
  const nonGoals = w.walls.filter((x) => x.subkind === "non-goal");

  return (
    <section className="space-y-6 border-b pb-8 last:border-b-0">
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link
            to="/records/$id"
            params={{ id: w.id }}
            className="text-lg font-semibold underline-offset-4 hover:underline"
          >
            {w.title}
          </Link>
          <span className="text-xs text-muted-foreground">
            {w.project}
            {w.branch && ` / ${w.branch}`}
          </span>
        </div>
        <Phases phases={w.phases} />
        {w.current_text && (
          <p className="max-w-[68ch] text-sm leading-relaxed text-muted-foreground">{w.current_text}</p>
        )}
      </div>

      {(mine.length > 0 || ai.length > 0) && (
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <h3 className="text-sm font-medium">あなたがやること</h3>
            {mine.length === 0 ? (
              <p className="text-sm text-muted-foreground">ありません。</p>
            ) : (
              <ul className="space-y-2">
                {mine.map((n) => (
                  <li key={n.text} className="border-l-2 border-foreground pl-3 text-sm leading-relaxed">
                    {n.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground">AI に任せること</h3>
            {ai.length === 0 ? (
              <p className="text-sm text-muted-foreground">ありません。</p>
            ) : (
              <ul className="space-y-2">
                {ai.map((n) => (
                  <li key={n.text} className="border-l-2 pl-3 text-sm leading-relaxed text-muted-foreground">
                    {n.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {(constraints.length > 0 || nonGoals.length > 0) && (
        <div className="space-y-3">
          {constraints.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-sm font-medium text-dont">変えてはいけないもの</h3>
              <ul className="space-y-1">
                {constraints.map((x) => (
                  <li
                    key={x.key}
                    className="max-w-[68ch] border-l-2 border-dont pl-3 text-sm leading-relaxed"
                  >
                    {x.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {nonGoals.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-sm font-medium text-dont">やらないと決めたこと</h3>
              <ul className="space-y-1">
                {nonGoals.map((x) => (
                  <li
                    key={x.key}
                    className="max-w-[68ch] border-l-2 border-dont pl-3 text-sm leading-relaxed"
                  >
                    {x.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Home() {
  const { data, isPending, error } = useQuery({ queryKey: ["now"], queryFn: api.now });
  if (isPending) return <Skeleton className="h-72 w-full" />;
  if (error) return <p className="text-sm text-dont">{String(error)}</p>;
  if (data.length === 0) {
    return (
      <div className="max-w-[60ch] space-y-2">
        <h1 className="text-lg font-semibold">まだ何も保存されていません</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          作業の途中で <code className="rounded bg-muted px-1 py-0.5">/mitos:trace</code> を実行すると、
          そのセッションで決めたことがここに出ます。
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-10">
      {data.map((w) => (
        <Card key={w.id} w={w} />
      ))}
    </div>
  );
}
