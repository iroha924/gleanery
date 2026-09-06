import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { api } from "../lib/api";

export const Route = createFileRoute("/records/")({ component: Records });

function Records() {
  const { data, isPending, error } = useQuery({ queryKey: ["records"], queryFn: api.records });
  if (isPending) return <p className="text-muted">読み込み中…</p>;
  if (error) return <p className="text-dont">{String(error)}</p>;
  return (
    <ol className="space-y-3">
      {data.map((r) => (
        <li key={r.id} className="rounded-lg border border-line p-4">
          <Link
            to="/records/$id"
            params={{ id: r.id }}
            className="font-medium underline-offset-2 hover:underline"
          >
            {r.title}
          </Link>
          <p className="mt-1 text-xs text-muted tabular-nums">
            {r.scope_label} / {r.status} / 判断 {r.nodes} 件 / 更新 {r.updated_at.slice(0, 10)}
          </p>
          {r.current_text && <p className="mt-2 text-sm">いま: {r.current_text}</p>}
        </li>
      ))}
    </ol>
  );
}
