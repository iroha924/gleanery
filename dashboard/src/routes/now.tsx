import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BotIcon, GitBranchIcon, ShieldAlertIcon, UserIcon } from "lucide-react";
import { Phases } from "@/components/phases";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import type { NextItem, Now } from "@/lib/api";
import { api } from "@/lib/api";
import { useProject } from "@/lib/project";

export const Route = createFileRoute("/now")({ component: Home });

const STATUS: Record<string, string> = {
  planning: "計画中",
  "in-progress": "進行中",
  blocked: "止まっている",
  paused: "中断中",
  done: "完了",
};

/** 次の一手。**担当で列を分ける。**who は記録が持っているので推測ではない。 */
function NextList({ items, mine }: { items: NextItem[]; mine: boolean }) {
  return (
    <div className="space-y-2.5">
      <h3 className="flex items-center gap-1.5 text-sm font-medium">
        {mine ? <UserIcon className="size-3.5" /> : <BotIcon className="size-3.5" />}
        {mine ? "あなたがやること" : "AI に任せること"}
        <span className="text-xs font-normal text-muted-foreground tabular-nums">{items.length}</span>
      </h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">ありません。</p>
      ) : (
        <ul className="space-y-2">
          {items.map((n) => (
            <li
              key={n.text}
              className={`rounded-md border-l-2 py-1.5 pl-3 text-sm leading-relaxed ${
                mine ? "border-l-foreground bg-muted/50" : "border-l-border"
              }`}
            >
              {n.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WorkCard({ w }: { w: Now }) {
  const mine = w.next.filter((n) => n.who === "human");
  const ai = w.next.filter((n) => n.who === "ai");
  const constraints = w.walls.filter((x) => x.subkind === "constraint");
  const nonGoals = w.walls.filter((x) => x.subkind === "non-goal");

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={w.status === "done" ? "secondary" : "default"}>
            {STATUS[w.status] ?? w.status}
          </Badge>
          <span>{w.project}</span>
          {w.branch && (
            <span className="flex items-center gap-1">
              <GitBranchIcon className="size-3" />
              {w.branch}
            </span>
          )}
          <span className="ml-auto tabular-nums">更新 {w.updated_at.slice(0, 10)}</span>
        </div>
        <Link
          to="/records/$id"
          params={{ id: w.id }}
          className="text-lg font-semibold leading-snug underline-offset-4 hover:underline"
        >
          {w.title}
        </Link>
      </CardHeader>

      <CardContent className="space-y-6">
        <Phases phases={w.phases} />

        {w.current_text && (
          <div className="rounded-md border bg-muted/40 p-3">
            <p className="text-sm leading-relaxed">{w.current_text}</p>
            {w.current_at && (
              <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
                {w.current_at.slice(0, 10)} 時点
              </p>
            )}
          </div>
        )}

        {(mine.length > 0 || ai.length > 0) && (
          <>
            <Separator />
            <div className="grid gap-6 sm:grid-cols-2">
              <NextList items={mine} mine />
              <NextList items={ai} mine={false} />
            </div>
          </>
        )}

        {(constraints.length > 0 || nonGoals.length > 0) && (
          <Accordion type="single" collapsible>
            <AccordionItem value="walls" className="border-b-0">
              <AccordionTrigger className="py-2 hover:no-underline">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <ShieldAlertIcon className="size-3.5 text-dont" />
                  触ってはいけない・やらないと決めたこと
                  <span className="text-xs font-normal text-muted-foreground tabular-nums">
                    {constraints.length + nonGoals.length}
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent className="space-y-4 pt-1">
                {[
                  { rows: constraints, label: "変えてはいけないもの" },
                  { rows: nonGoals, label: "やらないと決めたこと" },
                ]
                  .filter((g) => g.rows.length > 0)
                  .map((g) => (
                    <div key={g.label} className="space-y-1.5">
                      <h4 className="text-xs font-medium text-dont">{g.label}</h4>
                      <ul className="space-y-1.5">
                        {g.rows.map((x) => (
                          <li key={x.key} className="border-l-2 border-dont/50 pl-3 text-sm leading-relaxed">
                            {x.text}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        )}
      </CardContent>
    </Card>
  );
}

function Home() {
  const { scopeIds } = useProject();
  const { data, isPending, error } = useQuery({
    queryKey: ["now", scopeIds],
    queryFn: () => api.now(scopeIds),
  });
  if (isPending) return <Skeleton className="h-96 w-full" />;
  if (error) return <p className="text-sm text-dont">{String(error)}</p>;
  if (data.length === 0) {
    return (
      <div className="max-w-[60ch] space-y-2">
        <h1 className="text-lg font-semibold">まだ何も保存されていません</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          作業の途中で <code className="rounded bg-muted px-1.5 py-0.5 text-xs">/mitos:trace</code>{" "}
          を実行すると、そのセッションで決めたことがここに出ます。
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {data.map((w) => (
        <WorkCard key={w.id} w={w} />
      ))}
    </div>
  );
}
