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
  abandoned: "取りやめ",
};

/** 終わったことになっている値。**この画面に出たら、記録の側が古い。** */
const DONEISH = new Set(["done", "abandoned"]);

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
          {/* **この画面に並ぶのは、すべて進行中と判定された記録**（server の IN_PROGRESS）。
              手で書いた status はそれと同期しないので、そのまま出さない。
              `in-progress` は画面の意味と重なるので省き、終わったはずの値が来たら
              「記録が古い」印として目立たせる。 */}
          {w.status !== "in-progress" && (
            <Badge variant={DONEISH.has(w.status) ? "destructive" : "default"}>
              {STATUS[w.status] ?? w.status}
              {DONEISH.has(w.status) ? "（次の一手が残っています）" : ""}
            </Badge>
          )}
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
  // 0 件の理由を分けるために要る。記録そのものが無いのか、全部終わったのか。
  const { data: records } = useQuery({
    queryKey: ["records", scopeIds],
    queryFn: () => api.records(scopeIds),
  });
  if (isPending) return <Skeleton className="h-96 w-full" />;
  if (error) return <p className="text-sm text-dont">{String(error)}</p>;
  if (data.length === 0) {
    // **「無い」と「終わった」を混ぜない。**全工程が done の記録はここに出さないので、
    // 記録があっても 0 件になる。「まだ何も保存されていません」と書くと嘘になる。
    const has = (records?.length ?? 0) > 0;
    return (
      <div className="mx-auto w-full max-w-[83rem] space-y-2">
        <h1 className="font-semibold text-lg">
          {has ? "進行中の作業はありません" : "まだ何も保存されていません"}
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {has ? (
            <>
              このプロジェクトの記録は全工程が終わっています。中身は左の「記録」から読めます。
              新しく作業を始めて <code className="rounded bg-muted px-1.5 py-0.5 text-xs">/mitos:trace</code>{" "}
              を実行すると、その途中経過がここに出ます。
            </>
          ) : (
            <>
              作業の途中で <code className="rounded bg-muted px-1.5 py-0.5 text-xs">/mitos:trace</code>{" "}
              を実行すると、そのセッションで決めたことがここに出ます。
            </>
          )}
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-[83rem] space-y-6">
      {data.map((w) => (
        <WorkCard key={w.id} w={w} />
      ))}
    </div>
  );
}
