import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useProject } from "@/lib/project";

export const Route = createFileRoute("/records/")({ component: Records });

function Records() {
  const { scopeIds } = useProject();
  const { data, isPending, error } = useQuery({
    queryKey: ["records", scopeIds],
    queryFn: () => api.records(scopeIds),
  });
  if (isPending) return <Skeleton className="h-32 w-full" />;
  if (error) return <p className="text-sm text-dont">{String(error)}</p>;
  return (
    <ol className="space-y-3">
      {data.map((r) => (
        <li key={r.id}>
          <Item variant="outline" asChild>
            <Link to="/records/$id" params={{ id: r.id }}>
              <ItemContent>
                <ItemTitle className="flex items-center gap-2">
                  {r.title}
                  <Badge variant="secondary">{r.status}</Badge>
                </ItemTitle>
                <ItemDescription className="tabular-nums">
                  {r.scope_label} · 記録 {r.nodes} 件 · 更新 {r.updated_at.slice(0, 10)}
                </ItemDescription>
                {r.current_text && <ItemDescription>いま: {r.current_text}</ItemDescription>}
              </ItemContent>
            </Link>
          </Item>
        </li>
      ))}
    </ol>
  );
}
