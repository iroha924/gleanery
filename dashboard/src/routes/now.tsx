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
import { RECORD_STATUS } from "@/lib/record";

export const Route = createFileRoute("/now")({ component: Home });

/** 終わったことになっている値。**この画面に出たら、記録の側が古い。** */
const DONEISH = new Set(["done", "abandoned"]);

/** 次の一手。**担当で列を分ける。**who は記録が持っているので推測ではない。 */
function NextList({ items, mine }: { items: NextItem[]; mine: boolean }) {
  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {mine ? <UserIcon className="size-4" /> : <BotIcon className="size-4" />}
        {mine ? "あなたがやること" : "AI に任せること"}
        <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">{items.length}</span>
      </h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">ありません。</p>
      ) : (
        <ul className="space-y-2.5">
          {items.map((n) => (
            <li key={n.text} className="flex gap-2.5 text-[15px] leading-relaxed">
              <span
                className={`mt-[0.55rem] size-1.5 flex-none rounded-full ${mine ? "bg-sidebar-primary" : "bg-muted-foreground/55"}`}
                aria-hidden
              />
              <span>{n.text}</span>
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
    <Card className="gap-0 overflow-hidden border bg-card py-0 shadow-none">
      <CardHeader className="gap-3 border-b bg-muted/20 px-5 py-4 md:px-6">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {/* **この画面に並ぶのは、すべて進行中と判定された記録**（server の IN_PROGRESS）。
              手で書いた status はそれと同期しないので、そのまま出さない。
              `in-progress` は画面の意味と重なるので省き、終わったはずの値が来たら
              「記録が古い」印として目立たせる。 */}
          {w.status !== "in-progress" && (
            <Badge variant={DONEISH.has(w.status) ? "destructive" : "default"}>
              {RECORD_STATUS[w.status] ?? w.status}
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
          <span className="ml-auto tabular-nums">{w.updated_at.slice(0, 10)} 更新</span>
        </div>
        <Link
          to="/records/$id"
          params={{ id: w.id }}
          className="w-fit text-lg font-semibold leading-snug tracking-[-0.01em] underline-offset-4 hover:text-link hover:underline"
        >
          {w.title}
        </Link>
      </CardHeader>

      <CardContent
        className={`grid gap-7 p-5 md:p-6 ${mine.length > 0 || ai.length > 0 ? "lg:grid-cols-[minmax(0,1.35fr)_minmax(19rem,0.8fr)]" : ""}`}
      >
        <div className="min-w-0 space-y-7">
          {w.current_text && (
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">現在</h3>
                {w.current_at && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {w.current_at.slice(0, 10)}
                  </span>
                )}
              </div>
              <p className="max-w-[76ch] text-[15px] leading-7">{w.current_text}</p>
            </section>
          )}
          <Phases phases={w.phases} />
        </div>

        {(mine.length > 0 || ai.length > 0) && (
          <aside className="space-y-6 border-t pt-6 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
            {mine.length > 0 && <NextList items={mine} mine />}
            {mine.length > 0 && ai.length > 0 && <Separator />}
            {ai.length > 0 && <NextList items={ai} mine={false} />}
          </aside>
        )}

        {(constraints.length > 0 || nonGoals.length > 0) && (
          <div className="border-t pt-3 lg:col-span-2">
            <Accordion type="single" collapsible>
              <AccordionItem value="walls" className="border-b-0">
                <AccordionTrigger className="py-2 hover:no-underline">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <ShieldAlertIcon className="size-4 text-dont" />
                    制約と、やらないこと
                    <span className="text-xs font-normal text-muted-foreground tabular-nums">
                      {constraints.length + nonGoals.length}
                    </span>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="grid gap-5 pt-2 sm:grid-cols-2">
                  {[
                    { rows: constraints, label: "変えてはいけないもの" },
                    { rows: nonGoals, label: "やらないと決めたこと" },
                  ]
                    .filter((g) => g.rows.length > 0)
                    .map((g) => (
                      <div key={g.label} className="space-y-2">
                        <h4 className="text-xs font-semibold text-dont">{g.label}</h4>
                        <ul className="space-y-2">
                          {g.rows.map((x) => (
                            <li key={x.key} className="border-l-2 border-dont/45 pl-3 text-[15px] leading-7">
                              {x.text}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
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
      <div className="mx-auto w-full max-w-[80rem] rounded-lg border border-dashed bg-card px-6 py-12 text-center">
        <h1 className="font-semibold text-lg tracking-[-0.01em]">
          {has ? "進行中の作業はありません" : "まだ何も保存されていません"}
        </h1>
        <p className="mx-auto mt-2 max-w-2xl text-[15px] text-muted-foreground leading-7">
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
  const humanNext = data.reduce((sum, w) => sum + w.next.filter((n) => n.who === "human").length, 0);
  const aiNext = data.reduce((sum, w) => sum + w.next.filter((n) => n.who === "ai").length, 0);
  const walls = data.reduce((sum, w) => sum + w.walls.length, 0);

  return (
    <div className="mx-auto w-full max-w-[80rem] space-y-6">
      <header className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.02em]">作業の現在地</h1>
          <p className="mt-1 text-sm text-muted-foreground">進行中の作業と、その次に動く人を確認します。</p>
        </div>
      </header>

      <dl className="grid overflow-hidden rounded-lg border bg-card sm:grid-cols-4 sm:divide-x">
        {[
          ["進行中", data.length],
          ["あなたの次の一手", humanNext],
          ["AI の次の一手", aiNext],
          ["制約", walls],
        ].map(([label, value], index) => (
          <div key={String(label)} className={`px-4 py-3 ${index > 0 ? "border-t sm:border-t-0" : ""}`}>
            <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
            <dd className="mt-1 text-xl font-semibold tracking-[-0.02em] tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      {data.map((w) => (
        <WorkCard key={w.id} w={w} />
      ))}
    </div>
  );
}
