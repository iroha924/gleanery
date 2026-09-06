import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { Node } from "../lib/api";
import { api } from "../lib/api";

export const Route = createFileRoute("/records/$id")({ component: Detail });

// 表示の順。**ジュニアが上から読んで分かる順にする。**
// 何をしようとしているか → いまどこ → 何を決めた → 何が駄目だった → 何が未解決。
const SECTIONS: { kind: string; title: string; note?: string }[] = [
  { kind: "boundary", title: "境界", note: "やらないと決めたこと・変えてはいけない制約" },
  { kind: "decision", title: "決定", note: "採用した案と、そのとき棄却した案" },
  { kind: "event", title: "経過と行き止まり" },
  { kind: "verification", title: "検証" },
  { kind: "question", title: "未解決の問い" },
];

function polarityClass(p: Node["polarity"]): string {
  return p === "dont" ? "text-dont" : p === "do" ? "text-do" : "text-muted";
}

function Detail() {
  const { id } = Route.useParams();
  const { data, isPending, error } = useQuery({ queryKey: ["record", id], queryFn: () => api.record(id) });
  if (isPending) return <p className="text-muted">読み込み中…</p>;
  if (error) return <p className="text-dont">{String(error)}</p>;

  const options = data.nodes.filter((n) => n.kind === "option");
  return (
    <article className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold">{data.title}</h1>
        <p className="mt-1 text-xs text-muted">
          {data.scope_label} / {data.status}
          {data.branch && ` / ${data.branch}`} / 更新 {data.updated_at.slice(0, 10)}
        </p>
        {data.problem && (
          <p className="mt-3 text-sm leading-relaxed">
            <span className="text-muted">解こうとしている問題: </span>
            {data.problem}
          </p>
        )}
        {data.goal && (
          <p className="mt-1 text-sm leading-relaxed">
            <span className="text-muted">ゴール: </span>
            {data.goal}
          </p>
        )}
        {data.current_text && (
          <p className="mt-3 rounded-lg border border-line p-3 text-sm">
            <span className="text-muted">いまここ: </span>
            {data.current_text}
          </p>
        )}
      </header>

      {SECTIONS.map(({ kind, title, note }) => {
        const rows = data.nodes.filter((n) => n.kind === kind);
        if (rows.length === 0) return null;
        return (
          <section key={kind}>
            <h2 className="text-sm font-medium">
              {title} <span className="text-muted tabular-nums">{rows.length}</span>
            </h2>
            {note && <p className="mb-2 text-xs text-muted">{note}</p>}
            <ul className="space-y-3">
              {rows.map((n) => (
                <li key={n.id} className="rounded-lg border border-line p-3">
                  <p className="leading-relaxed">
                    <span className={`mr-1 text-sm font-medium ${polarityClass(n.polarity)}`}>{n.label}</span>
                    {n.text}
                  </p>
                  {n.ex && <p className="mt-1 text-sm text-muted">{n.ex}</p>}
                  {/* 決定は、棄却した案と一緒でないと「なぜそれか」が読めない */}
                  {kind === "decision" && (
                    <ul className="mt-2 space-y-1 border-l border-line pl-3">
                      {options
                        .filter((o) => o.parent_id === n.id)
                        .map((o) => (
                          <li key={o.id} className="text-sm">
                            <span className={`mr-1 ${polarityClass(o.polarity)}`}>{o.label}</span>
                            {o.text}
                            {o.ex && <span className="text-muted"> — {o.ex}</span>}
                          </li>
                        ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {data.refs.length > 0 && (
        <section>
          <h2 className="text-sm font-medium">
            関連 <span className="text-muted tabular-nums">{data.refs.length}</span>
          </h2>
          <ul className="mt-2 flex flex-wrap gap-2 text-xs">
            {data.refs.map((r) => (
              <li key={`${r.kind}:${r.key}`} className="rounded border border-line px-2 py-1 text-muted">
                {r.kind}:{" "}
                {r.url ? (
                  <a href={r.url} className="underline">
                    {r.title ?? r.key}
                  </a>
                ) : (
                  (r.title ?? r.key)
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
