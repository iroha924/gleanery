import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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

  const { data, isFetching, error } = useQuery({
    queryKey: ["search", q, dont, kinds, scopeIds],
    queryFn: () => api.search({ question: q ?? "", onlyDont: dont, kinds, limit: 15, scopeIds }),
    enabled: Boolean(q),
    staleTime: 60_000,
  });

  return (
    <div className="flex h-[calc(100vh-7rem)] gap-4">
      <div className="mx-auto flex w-full max-w-[52rem] min-w-0 flex-1 flex-col gap-5 overflow-y-auto">
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

        {/* **押せるものはトグルにする。**Badge を button で包むと、押せることが読み上げに伝わらない。 */}
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            value={dont ? "dont" : ""}
            onValueChange={(v) => nav({ search: (p) => ({ ...p, dont: v === "dont" ? true : undefined }) })}
            variant="outline"
          >
            <ToggleGroupItem value="dont" className="data-[state=on]:bg-dont data-[state=on]:text-white">
              やらないと決めたことだけ
            </ToggleGroupItem>
          </ToggleGroup>
          <ToggleGroup
            type="multiple"
            value={kinds ?? []}
            onValueChange={(v: string[]) =>
              nav({ search: (p) => ({ ...p, kinds: v.length ? v : undefined }) })
            }
            variant="outline"
          >
            {KINDS.map(([k, ja]) => (
              <ToggleGroupItem key={k} value={k}>
                {ja}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
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
                    {/* PR の本文がまるごと入っている件がある。切らないと 1 件で画面が埋まる。 */}
                    <p className="line-clamp-6 leading-relaxed">
                      <span className={`mr-1 font-medium ${polarityClass(h.polarity)}`}>{h.label}</span>
                      {h.text}
                    </p>
                    {h.ex && <p className="line-clamp-3 text-muted-foreground text-sm">理由: {h.ex}</p>}
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
