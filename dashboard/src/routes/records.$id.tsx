import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { Node } from "@/lib/api";
import { api } from "@/lib/api";

export const Route = createFileRoute("/records/$id")({ component: Detail });

// 流れの中に置くもの。制約とやらないことは流れの外（上）に固定する。
const FLOW = [
  { kind: "decision", label: "決めたこと" },
  { kind: "event", label: "分かったこと・行き止まり" },
  { kind: "verification", label: "確かめたこと" },
  { kind: "question", label: "未解決の問い" },
] as const;

/** 縦線に付く印。採用は塗り、やらないは輪郭。**色は極性にだけ使う。** */
function Dot({ polarity }: { polarity: Node["polarity"] }) {
  const cls =
    polarity === "dont"
      ? "border-dont bg-background"
      : polarity === "do"
        ? "border-do bg-do"
        : "border-muted-foreground bg-background";
  // 縦線（ol の border-l）の真上に置く。ol は pl-6 なので、li から見て -1.5rem が線の位置。
  // li の内側に -5px で出すと本文の 1 行目に食い込む（実測: 文字と点が重なった）。
  return (
    <span className={`absolute left-[-1.6rem] top-1.5 size-3 rounded-full border-2 ${cls}`} aria-hidden />
  );
}

function Detail() {
  const { id } = Route.useParams();
  const { data, isPending, error } = useQuery({ queryKey: ["record", id], queryFn: () => api.record(id) });
  if (isPending) return <Skeleton className="h-96 w-full" />;
  if (error) return <p className="text-sm text-dont">{String(error)}</p>;

  const options = data.nodes.filter((n) => n.kind === "option");
  const walls = data.nodes.filter((n) => n.kind === "boundary");
  const flow = FLOW.flatMap(({ kind, label }) => {
    const rows = data.nodes.filter((n) => n.kind === kind);
    return rows.length ? [{ label, rows }] : [];
  });

  return (
    <article className="mx-auto w-full max-w-[83rem] space-y-10">
      <header className="max-w-[110ch] space-y-3">
        <h1 className="text-2xl font-semibold leading-tight">{data.title}</h1>
        <p className="text-xs text-muted-foreground">
          {data.scope_label} · {data.status}
          {data.branch && ` · ${data.branch}`} · 更新 {data.updated_at.slice(0, 10)}
        </p>
        {data.problem && <p className="text-sm leading-relaxed">{data.problem}</p>}
        {data.goal && (
          <p className="text-sm leading-relaxed text-muted-foreground">目指すところ: {data.goal}</p>
        )}
      </header>

      {walls.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-dont">変えてはいけない・やらないと決めたこと</h2>
          <ul className="space-y-1">
            {walls.map((w) => (
              <li key={w.id} className="max-w-[110ch] border-l-2 border-dont pl-3 text-sm leading-relaxed">
                {w.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* **既定で開くのは決定だけ。**127 節を一度に並べると、どれが効いた判断なのか読み取れない
          （実測: この記録は option 47 / event 35 / verification 21）。件数だけ見せて、要るものを開かせる。 */}
      <Accordion type="multiple" defaultValue={["決めたこと"]} className="space-y-2">
        {flow.map(({ label, rows }) => (
          <AccordionItem key={label} value={label} className="border-b">
            <AccordionTrigger className="text-sm font-medium hover:no-underline">
              <span className="flex items-center gap-2">
                {label}
                <Badge variant="secondary" className="font-mono text-[10px]">
                  {rows.length}
                </Badge>
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <ol className="ml-1 space-y-7 border-l pl-6 pt-2">
                {rows.map((n) => (
                  <li key={n.id} className="relative max-w-[110ch] space-y-2">
                    <Dot polarity={n.polarity} />
                    <p className="text-sm leading-relaxed">{n.text}</p>

                    {n.ex && <p className="text-sm leading-relaxed text-muted-foreground">{n.ex}</p>}

                    {/* 決定は「どう確かめるか」と「引き受けた不利な点」まで書いて初めて読める */}
                    {n.attrs.confirmation && (
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        確かめ方: {n.attrs.confirmation}
                      </p>
                    )}
                    {/* consequences は {good, text} の配列。良かった点だけ並べると
                    「都合のいいところだけ書いた記録」になるので、不利な点も同じ重さで出す。 */}
                    {n.attrs.consequences && n.attrs.consequences.length > 0 && (
                      <ul className="space-y-1">
                        {n.attrs.consequences.map((c) => (
                          <li
                            key={c.text}
                            className={`text-sm leading-relaxed ${c.good ? "text-muted-foreground" : "text-dont"}`}
                          >
                            {c.good ? "得たもの: " : "引き受けた不利: "}
                            {c.text}
                          </li>
                        ))}
                      </ul>
                    )}

                    {/* 検証は、何を実行して何が返ったかが本体 */}
                    {n.attrs.cmd && (
                      <pre className="overflow-x-auto rounded bg-muted px-3 py-2 text-xs leading-relaxed">
                        <code>
                          $ {n.attrs.cmd}
                          {n.attrs.output ? `\n${n.attrs.output}` : ""}
                        </code>
                      </pre>
                    )}
                    {n.attrs.whyNotRun && (
                      <p className="text-sm leading-relaxed text-dont">実行していない: {n.attrs.whyNotRun}</p>
                    )}

                    {/* 採った案は、捨てた案と並べないと「なぜそれか」が読めない */}
                    {n.kind === "decision" && (
                      <ul className="space-y-1.5 pt-1">
                        {options
                          .filter((o) => o.parent_id === n.id)
                          .map((o) => (
                            <li
                              key={o.id}
                              className={`border-l-2 pl-3 text-sm leading-relaxed ${
                                o.polarity === "dont" ? "border-dont/40" : "border-do/40"
                              }`}
                            >
                              <span className={o.polarity === "dont" ? "text-muted-foreground" : ""}>
                                {o.text}
                              </span>
                              {o.attrs.whyNot && (
                                <span className="text-muted-foreground"> — {o.attrs.whyNot}</span>
                              )}
                            </li>
                          ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>

      {data.refs.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">関係したファイル・コマンド</h2>
          <ul className="max-w-[110ch] space-y-1 text-sm">
            {data.refs.map((r) => (
              <li key={`${r.kind}:${r.key}`} className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {r.url ? (
                    <a href={r.url} className="underline underline-offset-2">
                      {r.title ?? r.key}
                    </a>
                  ) : (
                    (r.title ?? r.key)
                  )}
                </span>
                {r.roles.includes("evidence") && (
                  <span className="shrink-0 text-xs text-muted-foreground">根拠</span>
                )}
                {r.failed > 0 && <span className="shrink-0 text-xs text-dont">失敗 {r.failed}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
