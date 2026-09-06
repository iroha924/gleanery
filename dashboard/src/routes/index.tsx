import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api, type Hit } from "../lib/api";

const KINDS = [
  ["decision", "決定"],
  ["option", "検討した案"],
  ["event", "経過・行き止まり"],
  ["boundary", "制約・やらないこと"],
  ["verification", "検証"],
  ["question", "未解決の問い"],
] as const;

type Search = { q?: string; dont?: boolean; kinds?: string[] };

export const Route = createFileRoute("/")({
  // 絞り込みは URL に持つ。共有もブックマークも戻るボタンも、これで全部効く。
  validateSearch: (s: Record<string, unknown>): Search => ({
    q: typeof s.q === "string" && s.q ? s.q : undefined,
    dont: s.dont === true || s.dont === "true" ? true : undefined,
    kinds: Array.isArray(s.kinds) ? (s.kinds as string[]) : undefined,
  }),
  component: Search,
});

function polarityClass(p: Hit["polarity"]): string {
  return p === "dont" ? "text-dont" : p === "do" ? "text-do" : "text-muted";
}

function Search() {
  const nav = useNavigate({ from: "/" });
  const { q, dont, kinds } = Route.useSearch();
  const [draft, setDraft] = useState(q ?? "");

  const { data, isFetching, error } = useQuery({
    queryKey: ["search", q, dont, kinds],
    queryFn: () => api.search({ question: q ?? "", onlyDont: dont, kinds, limit: 15 }),
    enabled: Boolean(q),
    staleTime: 60_000,
  });

  const toggleKind = (k: string) => {
    const next = kinds?.includes(k) ? kinds.filter((x) => x !== k) : [...(kinds ?? []), k];
    nav({ search: (p) => ({ ...p, kinds: next.length ? next : undefined }) });
  };

  return (
    <div className="space-y-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          nav({ search: (p) => ({ ...p, q: draft.trim() || undefined }) });
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="例: 認証まわりで触らないと決めた場所は？"
          className="w-full rounded-lg border border-line bg-transparent px-4 py-3 text-base outline-none focus:border-ink/40"
        />
      </form>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => nav({ search: (p) => ({ ...p, dont: p.dont ? undefined : true }) })}
          className={`rounded-full border px-3 py-1 ${dont ? "border-dont text-dont" : "border-line text-muted"}`}
        >
          やらない・棄却・行き止まりだけ
        </button>
        {KINDS.map(([k, ja]) => (
          <button
            type="button"
            key={k}
            onClick={() => toggleKind(k)}
            className={`rounded-full border px-3 py-1 ${
              kinds?.includes(k) ? "border-ink text-ink" : "border-line text-muted"
            }`}
          >
            {ja}
          </button>
        ))}
      </div>

      {!q && (
        <p className="text-sm text-muted">
          過去の作業で下した決定・棄却した案・試して駄目だったこと・触らないと決めた制約を、意味で引く。
        </p>
      )}
      {isFetching && <p className="text-sm text-muted">検索中…</p>}
      {error && <p className="text-sm text-dont">{String(error)}</p>}
      {data?.length === 0 && <p className="text-sm text-muted">該当なし。</p>}

      <ol className="space-y-3">
        {data?.map((h) => (
          <li key={`${h.record_id}:${h.kind}:${h.key}`} className="rounded-lg border border-line p-4">
            <p className="leading-relaxed">
              <span className={`mr-1 font-medium ${polarityClass(h.polarity)}`}>{h.label}</span>
              {h.text}
            </p>
            {h.ex && <p className="mt-2 text-sm text-muted">理由: {h.ex}</p>}
            <p className="mt-2 text-xs text-muted">
              <Link to="/records/$id" params={{ id: h.record_id }} className="underline underline-offset-2">
                {h.record_title}
              </Link>
              <span> / {h.scope_label}</span>
              {h.at && <span> / {h.at.slice(0, 10)}</span>}
              {h.relevance !== null && (
                <span className="tabular-nums"> / 関連度 {h.relevance.toFixed(2)}</span>
              )}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}
