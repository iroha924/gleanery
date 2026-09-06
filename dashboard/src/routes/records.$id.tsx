import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { polarityClass } from "@/lib/polarity";

export const Route = createFileRoute("/records/$id")({ component: Detail });

// 表示の順。**ジュニアが上から読んで分かる順にする。**
// 何をしようとしているか → いまどこ → 何を決めた → 何が駄目だった → 何が未解決。
const SECTIONS = [
  { kind: "boundary", title: "境界", note: "やらないと決めたこと・変えてはいけない制約" },
  { kind: "decision", title: "決定", note: "採用した案と、そのとき棄却した案" },
  { kind: "event", title: "経過と行き止まり", note: "" },
  { kind: "verification", title: "検証", note: "" },
  { kind: "question", title: "未解決の問い", note: "" },
] as const;

function Detail() {
  const { id } = Route.useParams();
  const { data, isPending, error } = useQuery({ queryKey: ["record", id], queryFn: () => api.record(id) });
  if (isPending) return <Skeleton className="h-64 w-full" />;
  if (error) return <p className="text-sm text-dont">{String(error)}</p>;

  const options = data.nodes.filter((n) => n.kind === "option");

  return (
    <article className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold">{data.title}</h1>
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary">{data.status}</Badge>
          <span>{data.scope_label}</span>
          {data.branch && <span>/ {data.branch}</span>}
          <span>/ 更新 {data.updated_at.slice(0, 10)}</span>
        </p>
        {data.problem && (
          <p className="text-sm leading-relaxed">
            <span className="text-muted-foreground">解こうとしている問題: </span>
            {data.problem}
          </p>
        )}
        {data.goal && (
          <p className="text-sm leading-relaxed">
            <span className="text-muted-foreground">ゴール: </span>
            {data.goal}
          </p>
        )}
        {data.current_text && (
          <Card>
            <CardContent className="py-4 text-sm">
              <span className="text-muted-foreground">いまここ: </span>
              {data.current_text}
            </CardContent>
          </Card>
        )}
      </header>

      {SECTIONS.map(({ kind, title, note }) => {
        const rows = data.nodes.filter((n) => n.kind === kind);
        if (rows.length === 0) return null;
        return (
          <section key={kind} className="space-y-2">
            <h2 className="text-sm font-medium">
              {title} <span className="text-muted-foreground tabular-nums">{rows.length}</span>
            </h2>
            {note && <p className="text-xs text-muted-foreground">{note}</p>}
            <ul className="space-y-3">
              {rows.map((n) => (
                <li key={n.id}>
                  <Card>
                    <CardContent className="space-y-2 py-4">
                      <p className="leading-relaxed">
                        <span className={`mr-1 text-sm font-medium ${polarityClass(n.polarity)}`}>
                          {n.label}
                        </span>
                        {n.text}
                      </p>
                      {n.ex && <p className="text-sm text-muted-foreground">{n.ex}</p>}
                      {kind === "decision" && (
                        // 決定は、棄却した案と一緒でないと「なぜそれか」が読めない
                        <ul className="space-y-1 border-l pl-3">
                          {options
                            .filter((o) => o.parent_id === n.id)
                            .map((o) => (
                              <li key={o.id} className="text-sm">
                                <span className={`mr-1 ${polarityClass(o.polarity)}`}>{o.label}</span>
                                {o.text}
                                {o.ex && <span className="text-muted-foreground"> — {o.ex}</span>}
                              </li>
                            ))}
                        </ul>
                      )}
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {data.refs.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">
            関連 <span className="text-muted-foreground tabular-nums">{data.refs.length}</span>
          </h2>
          <ul className="flex flex-wrap gap-1.5">
            {data.refs.map((r) => (
              <li key={`${r.kind}:${r.key}`}>
                <Badge variant="outline" className="font-normal">
                  {r.kind}:{" "}
                  {r.url ? (
                    <a href={r.url} className="underline underline-offset-2">
                      {r.title ?? r.key}
                    </a>
                  ) : (
                    (r.title ?? r.key)
                  )}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
