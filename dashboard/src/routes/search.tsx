import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Focus } from "@/components/focus";
import { Graph } from "@/components/graph";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { polarityClass } from "@/lib/polarity";
import { useProject } from "@/lib/project";

const KINDS = [
  ["decision", "決めたこと"],
  ["option", "検討した案"],
  ["event", "分かったこと・行き止まり"],
  ["boundary", "触らない・やらない"],
  ["verification", "確かめたこと"],
  ["question", "未解決の問い"],
] as const;

type Search = { q?: string; dont?: boolean; kinds?: string[] };

export const Route = createFileRoute("/search")({
  // 絞り込みは URL に持つ。共有もブックマークも戻るボタンも、これで全部効く。
  validateSearch: (s: Record<string, unknown>): Search => ({
    q: typeof s.q === "string" && s.q ? s.q : undefined,
    dont: s.dont === true || s.dont === "true" ? true : undefined,
    kinds: Array.isArray(s.kinds) ? (s.kinds as string[]) : undefined,
  }),
  component: SearchPage,
});

function SearchPage() {
  const nav = useNavigate({ from: "/search" });
  const { q, dont, kinds } = Route.useSearch();
  const [draft, setDraft] = useState(q ?? "");
  const { scopeIds } = useProject();
  const [selected, setSelected] = useState<number | null>(null);
  // 地図は「聞く」と同じものを出す。**探した結果がそのまま地図で光る。**
  const graph = useQuery({ queryKey: ["graph", scopeIds], queryFn: () => api.graph(scopeIds, "all") });

  const { data, isFetching, error } = useQuery({
    queryKey: ["search", q, dont, kinds, scopeIds],
    queryFn: () => api.search({ question: q ?? "", onlyDont: dont, kinds, limit: 15, scopeIds }),
    enabled: Boolean(q),
    staleTime: 60_000,
  });

  const gnodes = graph.data?.nodes ?? [];
  const gedges = graph.data?.edges ?? [];
  const highlighted = useMemo(() => (data ?? []).map((h) => h.id), [data]);
  const focus = gnodes.find((n) => n.id === selected) ?? null;
  const links = focus ? gedges.filter((e) => e.src === focus.id || e.dst === focus.id).length : 0;

  const toggleKind = (k: string) => {
    const next = kinds?.includes(k) ? kinds.filter((x) => x !== k) : [...(kinds ?? []), k];
    nav({ search: (p) => ({ ...p, kinds: next.length ? next : undefined }) });
  };

  return (
    <div className="flex h-[calc(100vh-7rem)] gap-4">
      <div className="relative min-w-0 flex-[6] overflow-hidden rounded-md border">
        {gnodes.length === 0 ? (
          <p className="p-4 text-muted-foreground text-sm">この範囲には判断の記録がありません。</p>
        ) : (
          <>
            <Graph
              nodes={gnodes}
              edges={gedges}
              highlighted={highlighted}
              selected={selected}
              onSelect={setSelected}
            />
            <div className="pointer-events-none absolute top-4 left-4 font-mono text-[10px] text-muted-foreground tracking-widest">
              {highlighted.length > 0 ? `引いた ${highlighted.length} 件を強調中` : "全体を表示中"}
            </div>
            {focus && <Focus node={focus} links={links} onClose={() => setSelected(null)} />}
          </>
        )}
      </div>
      <div className="flex min-w-0 flex-[4] flex-col gap-5 overflow-y-auto pr-1">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            nav({ search: (p) => ({ ...p, q: draft.trim() || undefined }) });
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="例: 認証まわりで触らないと決めたのはどこか"
          />
          <Button type="submit" disabled={!draft.trim()}>
            <SearchIcon /> 引く
          </Button>
        </form>

        {/* 絞り込みは押せる要素にする。Badge は span なので、asChild で button を渡さないと
          キーボードで操作できず、押せることも読み上げに伝わらない。 */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            asChild
            variant={dont ? "default" : "outline"}
            className={dont ? "bg-dont hover:bg-dont/90" : ""}
          >
            <button
              type="button"
              aria-pressed={Boolean(dont)}
              onClick={() => nav({ search: (p) => ({ ...p, dont: p.dont ? undefined : true }) })}
            >
              やらないと決めたことだけ
            </button>
          </Badge>
          {KINDS.map(([k, ja]) => (
            <Badge key={k} asChild variant={kinds?.includes(k) ? "secondary" : "outline"}>
              <button type="button" aria-pressed={Boolean(kinds?.includes(k))} onClick={() => toggleKind(k)}>
                {ja}
              </button>
            </Badge>
          ))}
        </div>

        {!q && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchIcon />
              </EmptyMedia>
              <EmptyTitle>過去に決めたことを探す</EmptyTitle>
              <EmptyDescription>
                決めたこと・採らなかった案・試して駄目だったこと・触らないと決めたことを、
                言葉の意味で探します。いま開いているプロジェクトと、まとめた相手だけが対象です。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {isFetching && (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
        {error && <p className="text-sm text-dont">{String(error)}</p>}
        {q && !isFetching && data?.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>該当なし</EmptyTitle>
              <EmptyDescription>言い方を変えるか、種類の絞り込みを外してみてください。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        <ol className="space-y-3">
          {!isFetching &&
            data?.map((h) => (
              <li key={`${h.record_id}:${h.kind}:${h.key}`}>
                <Card>
                  <CardContent className="space-y-2">
                    <p className="leading-relaxed">
                      <span className={`mr-1 font-medium ${polarityClass(h.polarity)}`}>{h.label}</span>
                      {h.text}
                    </p>
                    {h.ex && <p className="text-sm text-muted-foreground">理由: {h.ex}</p>}
                    <p className="text-xs text-muted-foreground">
                      <Link
                        to="/records/$id"
                        params={{ id: h.record_id }}
                        className="underline underline-offset-2"
                      >
                        {h.record_title}
                      </Link>
                      <span> / {h.scope_label}</span>
                      {h.at && <span> / {h.at.slice(0, 10)}</span>}
                    </p>
                  </CardContent>
                </Card>
              </li>
            ))}
        </ol>
      </div>
    </div>
  );
}
