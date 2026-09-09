import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, SearchIcon, SlidersHorizontalIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/lib/api";
import { polarityClass } from "@/lib/polarity";
import { useProject } from "@/lib/project";
import { RECORD_STATUS } from "@/lib/record";

const KINDS = [
  ["decision", "決めたこと"],
  ["option", "検討した案"],
  ["event", "分かったこと・行き止まり"],
  ["boundary", "触らない・やらない"],
  ["verification", "確かめたこと"],
  ["question", "未解決の問い"],
  // **発言は既定では出ない**（サーバー側で外している。DB の 4 割が bot の定型文だった）。
  // 選ぶ手段が無いと二度と引けなくなるので、ここに置く。
  ["utterance", "発言"],
  // リポジトリの Markdown。既定から外れているので、**選べないと「設計文書だけ」に絞れない**。
  ["doc", "文書・ADR"],
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
  const activeFilters = (dont ? 1 : 0) + (kinds?.length ?? 0);

  const { data, isFetching, error } = useQuery({
    queryKey: ["search", q, dont, kinds, scopeIds],
    queryFn: () => api.search({ question: q ?? "", onlyDont: dont, kinds, limit: 15, scopeIds }),
    enabled: Boolean(q),
    staleTime: 60_000,
  });
  const recent = useQuery({
    queryKey: ["records", scopeIds],
    queryFn: () => api.records(scopeIds),
    enabled: !q,
  });

  return (
    <div className="mx-auto flex w-full max-w-[72rem] min-w-0 flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold tracking-[-0.02em]">記録を探す</h1>
        <p className="mt-1 text-sm text-muted-foreground">決定、検証、行き止まりを言葉の意味から探します。</p>
      </header>

      <div className="sticky top-0 z-10 space-y-3 bg-background pb-1">
        <form
          className="flex gap-2 rounded-lg border bg-card p-2 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault();
            nav({ search: (p) => ({ ...p, q: draft.trim() || undefined }) });
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="例: 認証まわりで触らないと決めたのはどこか"
            className="h-10 border-0 bg-transparent shadow-none focus-visible:ring-0"
          />
          <Button type="submit" disabled={!draft.trim()} className="h-10 px-4">
            <SearchIcon /> 引く
          </Button>
        </form>

        <details className="group rounded-lg border bg-card">
          <summary className="flex h-10 list-none items-center gap-2 px-3 text-sm font-medium marker:content-none">
            <SlidersHorizontalIcon className="size-4 text-muted-foreground" />
            絞り込み
            {activeFilters > 0 && (
              <Badge variant="secondary" className="ml-1 min-w-5 justify-center px-1.5 tabular-nums">
                {activeFilters}
              </Badge>
            )}
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              {activeFilters > 0 ? "条件あり" : "すべての種類"}
            </span>
          </summary>
          {/* **押せるものはトグルにする。**Badge を button で包むと、押せることが読み上げに伝わらない。 */}
          <div className="flex flex-wrap items-center gap-2 border-t p-3">
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
              className="flex-wrap justify-start"
            >
              {KINDS.map(([k, ja]) => (
                <ToggleGroupItem key={k} value={k}>
                  {ja}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </details>
      </div>

      {!q && (
        <section className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-medium">最近の記録</h2>
            {recent.data && (
              <span className="text-xs text-muted-foreground tabular-nums">{recent.data.length} 件</span>
            )}
          </div>
          {recent.isPending && (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}
          {recent.isError && (
            <p className="rounded-lg border border-dont/30 bg-card p-4 text-sm text-dont">
              {String(recent.error)}
            </p>
          )}
          {recent.data?.length === 0 && (
            <div className="rounded-lg border border-dashed bg-card py-10">
              <Empty className="min-h-0 border-0 p-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <SearchIcon />
                  </EmptyMedia>
                  <EmptyTitle>記録はまだありません</EmptyTitle>
                  <EmptyDescription>作業を記録すると、ここから一覧で開けるようになります。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          )}
          {recent.data && recent.data.length > 0 && (
            <ol className="divide-y overflow-hidden rounded-lg border bg-card">
              {recent.data.slice(0, 12).map((record) => (
                <li key={record.id}>
                  <Link
                    to="/records/$id"
                    params={{ id: record.id }}
                    className="group block p-4 transition-colors hover:bg-muted/35 md:px-5"
                  >
                    <div className="flex items-start gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span>{RECORD_STATUS[record.status] ?? record.status}</span>
                          <span>{record.scope_label}</span>
                          <span className="tabular-nums">{record.updated_at.slice(0, 10)}</span>
                        </div>
                        <h3 className="mt-1.5 font-medium leading-snug group-hover:text-link">
                          {record.title}
                        </h3>
                        {(record.current_text || record.goal || record.problem) && (
                          <p className="mt-1.5 line-clamp-2 max-w-[86ch] text-sm text-muted-foreground leading-6">
                            {record.current_text || record.goal || record.problem}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-none items-center gap-3 pt-0.5 text-xs text-muted-foreground">
                        <span className="tabular-nums">{record.nodes} 項目</span>
                        <ChevronRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ol>
          )}
          {recent.data && recent.data.length > 12 && (
            <p className="px-1 text-xs text-muted-foreground">最新の 12 件を表示しています。</p>
          )}
        </section>
      )}

      {isFetching && (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      )}
      {error && (
        <p className="rounded-lg border border-dont/30 bg-card p-4 text-sm text-dont">{String(error)}</p>
      )}
      {q && !isFetching && data?.length === 0 && (
        <Empty className="rounded-lg border border-dashed bg-card py-10">
          <EmptyHeader>
            <EmptyTitle>該当なし</EmptyTitle>
            <EmptyDescription>言い方を変えるか、種類の絞り込みを外してみてください。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {!isFetching && data && data.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-medium">検索結果</h2>
            <span className="text-xs text-muted-foreground tabular-nums">{data.length} 件</span>
          </div>
          <ol className="divide-y overflow-hidden rounded-lg border bg-card">
            {data.map((h) => (
              <li
                key={`${h.record_id}:${h.kind}:${h.key}`}
                className="p-4 transition-colors hover:bg-muted/35 md:p-5"
              >
                <article className="space-y-3">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span className={`font-medium ${polarityClass(h.polarity)}`}>{h.label}</span>
                    {/* **誰が言ったかを本文から読ませない。**bot か人かで重みが違う。 */}
                    {h.actor_name && <span className="font-mono">@{h.actor_name}</span>}
                    <span>{h.scope_label}</span>
                    {h.at && <span className="tabular-nums">{h.at.slice(0, 10)}</span>}
                  </div>
                  {/* PR の本文がまるごと入っている件がある。切らないと 1 件で画面が埋まる。 */}
                  <p className="line-clamp-6 max-w-[86ch] text-[15px] leading-7">
                    {/* 取り込みが本文の頭にも `@名前:` を入れている。札の隣に出す以上、二重になる。 */}
                    {h.actor_name ? h.text.replace(/^@[^\s:]+:\s*/, "") : h.text}
                  </p>
                  {h.ex && (
                    <p className="line-clamp-3 max-w-[86ch] border-l-2 pl-3 text-sm text-muted-foreground leading-6">
                      {h.ex}
                    </p>
                  )}
                  <div>
                    <Link
                      to="/records/$id"
                      params={{ id: h.record_id }}
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-link underline-offset-4 hover:underline"
                    >
                      {h.record_title}
                      <ChevronRightIcon className="size-3.5" />
                    </Link>
                  </div>
                </article>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
