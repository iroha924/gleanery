import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { api } from "../lib/api";

export const Route = createFileRoute("/scopes")({ component: Scopes });

function Scopes() {
  const { data, isPending, error } = useQuery({ queryKey: ["scopes"], queryFn: api.scopes });
  if (isPending) return <p className="text-muted">読み込み中…</p>;
  if (error) return <p className="text-dont">{String(error)}</p>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        検索は既定でいまの作業場所とその束に絞られる。束ねられていない場所どうしは互いに引かれない。
      </p>
      {data.map((s) => (
        <div key={s.id} className="rounded-lg border border-line p-4">
          <div className="flex items-baseline gap-3">
            <h2 className="font-medium">{s.label}</h2>
            <span className="text-xs text-muted tabular-nums">
              記録 {s.records} / 判断 {s.nodes}
            </span>
            <span className="ml-auto text-xs text-muted">{s.groups ?? "束なし"}</span>
          </div>
          {s.role && <p className="mt-1 text-sm text-muted">{s.role}</p>}
        </div>
      ))}
    </div>
  );
}
