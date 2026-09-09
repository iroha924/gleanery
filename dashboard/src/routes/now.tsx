import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BotIcon, GitBranchIcon, OrbitIcon, ShieldAlertIcon, SquareIcon, UserIcon } from "lucide-react";
import { MarkdownText } from "@/components/answer";
import { Phases } from "@/components/phases";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
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
    <Accordion
      type="single"
      collapsible
      className="overflow-hidden rounded-[1.5rem] border border-white/60 bg-card/75"
    >
      <AccordionItem value={mine ? "human-next" : "ai-next"} className="border-b-0">
        <AccordionTrigger className="px-4 py-3.5 hover:no-underline">
          <span className="flex flex-1 items-center gap-2 text-sm font-medium">
            {mine ? <UserIcon className="size-4" /> : <BotIcon className="size-4" />}
            {mine ? "あなたがやること" : "AI に任せること"}
            <span className="text-xs font-normal text-muted-foreground tabular-nums">{items.length}</span>
          </span>
        </AccordionTrigger>
        <AccordionContent className="p-0">
          <ItemGroup className="gap-0 border-t border-foreground/8">
            {items.map((n) => (
              <Item
                key={n.text}
                role="listitem"
                className="items-start rounded-none border-0 border-b border-foreground/8 px-4 py-3.5 last:border-b-0"
              >
                <ItemMedia className="pt-0.5 text-muted-foreground/60">
                  <SquareIcon className="size-4" />
                </ItemMedia>
                <ItemContent>
                  <MarkdownText text={n.text} />
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function WorkCard({ w }: { w: Now }) {
  const mine = w.next.filter((n) => n.who === "human");
  const ai = w.next.filter((n) => n.who === "ai");
  const constraints = w.walls.filter((x) => x.subkind === "constraint");
  const nonGoals = w.walls.filter((x) => x.subkind === "non-goal");

  return (
    <Card className="gap-0 overflow-hidden rounded-[2rem] border border-white/55 bg-card/72 py-0 ring-0 backdrop-blur-sm">
      <CardHeader className="gap-3 px-5 pt-5 pb-3 md:px-7 md:pt-7">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {/* **この画面に並ぶのは、すべて進行中と判定された記録**（server の IN_PROGRESS）。
              手で書いた status はそれと同期しないので、そのまま出さない。
              `in-progress` は画面の意味と重なるので省き、終わったはずの値が来たら
              「記録が古い」印として目立たせる。 */}
          {w.status !== "in-progress" && (
            <Badge variant={DONEISH.has(w.status) ? "destructive" : "secondary"}>
              {RECORD_STATUS[w.status] ?? w.status}
              {DONEISH.has(w.status) ? "（次の一手が残っています）" : ""}
            </Badge>
          )}
          <Badge className="rounded-full bg-accent px-3 text-accent-foreground hover:bg-accent">
            {w.project}
          </Badge>
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
          className="w-fit max-w-[44rem] text-xl leading-snug font-medium tracking-[-0.025em] underline-offset-4 hover:text-link hover:underline md:text-2xl"
        >
          {w.title}
        </Link>
      </CardHeader>

      <CardContent
        className={`grid gap-7 p-5 pt-3 md:p-7 md:pt-4 ${mine.length > 0 || ai.length > 0 ? "lg:grid-cols-[minmax(0,1.35fr)_minmax(19rem,0.8fr)]" : ""}`}
      >
        <div className="min-w-0 space-y-7">
          {w.current_text && (
            <Item variant="muted" className="items-start rounded-[1.5rem] bg-background/42 px-5 py-4">
              <ItemContent>
                <ItemTitle className="text-sm">
                  現在
                  {w.current_at && (
                    <span className="text-xs font-normal text-muted-foreground tabular-nums">
                      {w.current_at.slice(0, 10)}
                    </span>
                  )}
                </ItemTitle>
                <MarkdownText text={w.current_text} className="max-w-[76ch] text-foreground" />
              </ItemContent>
            </Item>
          )}
          <Phases phases={w.phases} />
        </div>

        {(mine.length > 0 || ai.length > 0) && (
          <aside className="space-y-6 border-t border-foreground/10 pt-6 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-7">
            {mine.length > 0 && <NextList items={mine} mine />}
            {ai.length > 0 && <NextList items={ai} mine={false} />}
          </aside>
        )}

        {(constraints.length > 0 || nonGoals.length > 0) && (
          <div className="border-t border-foreground/10 pt-5 lg:col-span-2">
            <Accordion
              type="single"
              collapsible
              className="rounded-[1.5rem] bg-primary px-5 text-primary-foreground"
            >
              <AccordionItem value="walls" className="border-b-0">
                <AccordionTrigger className="py-3 hover:no-underline">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <ShieldAlertIcon className="size-4 text-accent" />
                    制約と、やらないこと
                    <span className="text-xs font-normal text-primary-foreground/65 tabular-nums">
                      {constraints.length + nonGoals.length}
                    </span>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="grid gap-5 pt-2 pb-4 sm:grid-cols-2">
                  {[
                    { rows: constraints, label: "変えてはいけないもの" },
                    { rows: nonGoals, label: "やらないと決めたこと" },
                  ]
                    .filter((g) => g.rows.length > 0)
                    .map((g) => (
                      <div key={g.label} className="space-y-2">
                        <h4 className="text-sm font-medium">{g.label}</h4>
                        <ul className="space-y-2">
                          {g.rows.map((x) => (
                            <li
                              key={x.key}
                              className="border-l-2 border-accent/75 pl-3 text-[15px] leading-7 text-primary-foreground/80"
                            >
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
      <Empty className="mx-auto min-h-80 w-full max-w-[76rem] rounded-[2rem] border border-white/55 bg-card/72">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="size-10 bg-muted text-muted-foreground">
            <OrbitIcon className="size-5" />
          </EmptyMedia>
          <EmptyTitle className="text-lg">
            {has ? "進行中の作業はありません" : "まだ何も保存されていません"}
          </EmptyTitle>
          <EmptyDescription>
            {has ? (
              <>
                このプロジェクトの記録は全工程が終わっています。中身は「ナレッジ検索」から読めます。
                新しく作業を始めて{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">/mitos:trace</code>{" "}
                を実行すると、その途中経過がここに出ます。
              </>
            ) : (
              <>
                作業の途中で <code className="rounded bg-muted px-1.5 py-0.5 text-xs">/mitos:trace</code>{" "}
                を実行すると、そのセッションで決めたことがここに出ます。
              </>
            )}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const humanNext = data.reduce((sum, w) => sum + w.next.filter((n) => n.who === "human").length, 0);
  const aiNext = data.reduce((sum, w) => sum + w.next.filter((n) => n.who === "ai").length, 0);
  const walls = data.reduce((sum, w) => sum + w.walls.length, 0);

  return (
    <div className="mx-auto flex h-full w-full max-w-[76rem] flex-col gap-7">
      <header className="shrink-0">
        <h1 className="text-4xl font-medium tracking-[-0.045em] md:text-5xl">現在地</h1>
        <p className="mt-2 text-sm text-muted-foreground">進行中の作業と、次に動く人を確認します。</p>
      </header>

      <section className="grid shrink-0 grid-cols-4 gap-3">
        {[
          {
            label: "進行中",
            value: data.length,
            className: "border-primary bg-primary text-primary-foreground",
          },
          {
            label: "あなたの次の一手",
            value: humanNext,
            className: "border-accent bg-accent text-accent-foreground",
          },
          {
            label: "AI の次の一手",
            value: aiNext,
            className: "border-foreground/20 bg-white text-[var(--brand-black)]",
          },
          {
            label: "制約",
            value: walls,
            className: "border-foreground/45 bg-card/25 text-foreground",
          },
        ].map((stat) => (
          <div key={stat.label} className="space-y-2">
            <p className="px-1 text-sm text-foreground/70">{stat.label}</p>
            <div
              className={`flex h-14 items-center justify-between rounded-full border px-5 ${stat.className}`}
            >
              <span className="text-2xl font-medium tabular-nums">{stat.value}</span>
              <span className="text-xs opacity-65">件</span>
            </div>
          </div>
        ))}
      </section>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="space-y-7 pb-5">
          {data.map((w) => (
            <WorkCard key={w.id} w={w} />
          ))}
        </div>
      </div>
    </div>
  );
}
