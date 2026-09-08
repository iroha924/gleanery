import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Node, Ref } from "@/lib/api";
import { api } from "@/lib/api";

/** 参照の種別。**外から持ってきたものを先に置く。**URL と コミットは記録の外を指すので、
 *  読み手が確かめに行ける。ファイルとコマンドはリポジトリの中なので後ろでよい。 */
const REF_KINDS: { kind: string; label: string }[] = [
  { kind: "url", label: "URL" },
  { kind: "issue", label: "issue" },
  { kind: "pr", label: "PR" },
  { kind: "commit", label: "コミット" },
  { kind: "file", label: "ファイル" },
  { kind: "command", label: "コマンド" },
];
const ROLE_LABEL: Record<string, string> = { evidence: "根拠", touched: "触った", link: "関連" };

/**
 * 記録が指している外部のもの。
 *
 * **既定は畳む。**1 件の記録で 140 件になるので、開いたまま置くと判断が読めなくなる。
 * **note を必ず出す。**URL は「何を調べて何が分かったか」が note にしかなく、
 * 落とすとリンクの列だけが残って意味を失う。
 */
function Refs({ refs }: { refs: Ref[] }) {
  const groups = REF_KINDS.map((k) => ({ ...k, rows: refs.filter((r) => r.kind === k.kind) })).filter(
    (g) => g.rows.length > 0,
  );
  if (groups.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="font-medium text-muted-foreground text-sm">参照</h2>
      {groups.map((g) => (
        <details key={g.kind} className="border-border/60 border-t py-2">
          <summary className="cursor-pointer list-none text-[13px] marker:content-none">
            {g.label}
            <span className="ml-2 font-mono text-[10px] text-muted-foreground tabular-nums">
              {g.rows.length}
            </span>
          </summary>
          <ul className="mt-2 space-y-2">
            {g.rows.map((r) => (
              <li key={`${r.kind}:${r.key}`} className="max-w-[110ch] text-[13px] leading-[1.85]">
                <span className="text-muted-foreground">
                  {r.roles
                    .split(",")
                    .map((x) => ROLE_LABEL[x] ?? x)
                    .join(" / ")}
                </span>{" "}
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                    {r.title || r.key}
                  </a>
                ) : (
                  <code className="font-mono text-[12px]">{r.key}</code>
                )}
                {r.failed > 0 && <span className="ml-2 text-dont text-[11px]">失敗 {r.failed}</span>}
                {r.note && <div className="text-muted-foreground">{r.note}</div>}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}

export const Route = createFileRoute("/records/$id")({ component: RecordPage });

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
  // 本文の 1 行目に揃える。**行の高さの中心へ**置かないと、文字の上端に付いて浮いて見える。
  return <span className={`mt-[0.45rem] size-2.5 flex-none rounded-full border-2 ${cls}`} aria-hidden />;
}

/** 中身があるか。**無いものをクリックできると、押しても何も起きない。** */
function hasDetail(n: Node, options: Node[]): boolean {
  return Boolean(
    n.ex ||
      n.attrs.confirmation ||
      n.attrs.whyNotRun ||
      n.attrs.cmd ||
      (n.attrs.consequences?.length ?? 0) > 0 ||
      options.some((o) => o.parent_id === n.id),
  );
}

/** 1 件の中身。一覧では畳み、押したときだけ開く。 */
function Detail({ n, options }: { n: Node; options: Node[] }) {
  const taken = options.filter((o) => o.parent_id === n.id);
  if (!hasDetail(n, options)) {
    return (
      <div className="flex items-start gap-3 rounded-md border border-dashed px-4 py-3">
        <Dot polarity={n.polarity} />
        <span className="min-w-0 flex-1 text-[14px] leading-[1.9]">{n.text}</span>
      </div>
    );
  }
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="group flex w-full items-start gap-3 rounded-md border bg-card px-4 py-3 text-left transition-colors hover:border-foreground/25 hover:bg-accent/40"
        >
          <Dot polarity={n.polarity} />
          <span className="min-w-0 flex-1 text-[14px] leading-[1.9]">{n.text}</span>
          <span className="flex flex-none items-center gap-2 pt-0.5">
            {n.at && (
              <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                {n.at.slice(0, 10)}
              </span>
            )}
            <ChevronRightIcon className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="gap-5 p-6 sm:max-w-[46rem]">
        <DialogHeader>
          <DialogTitle className="pr-10 text-[1.05rem] leading-[1.8]">{n.text}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          {n.ex && <p className="text-[13.5px] text-muted-foreground leading-[1.95]">{n.ex}</p>}
          {n.attrs.confirmation && (
            <p className="text-[13.5px] text-muted-foreground leading-[1.95]">
              確かめ方: {n.attrs.confirmation}
            </p>
          )}
          {/* 良かった点だけ並べると「都合のいいところだけ書いた記録」になるので、不利も同じ重さで出す。 */}
          {n.attrs.consequences && n.attrs.consequences.length > 0 && (
            <ul className="space-y-1">
              {n.attrs.consequences.map((c) => (
                <li
                  key={c.text}
                  className={`text-[13.5px] leading-[1.95] ${c.good ? "text-muted-foreground" : "text-dont"}`}
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
            <p className="text-[13.5px] text-dont leading-[1.95]">実行していない: {n.attrs.whyNotRun}</p>
          )}
          {/* 採った案は、捨てた案と並べないと「なぜそれか」が読めない */}
          {taken.length > 0 && (
            <ul className="space-y-1.5 border-t pt-3">
              {taken.map((o) => (
                <li
                  key={o.id}
                  className={`border-l-2 pl-3 text-[13.5px] leading-[1.95] ${
                    o.polarity === "dont" ? "border-dont/40" : "border-do/40"
                  }`}
                >
                  <span className={o.polarity === "dont" ? "text-muted-foreground" : ""}>{o.text}</span>
                  {o.attrs.whyNot && <span className="text-muted-foreground"> — {o.attrs.whyNot}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RecordPage() {
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
        <h1 className="text-2xl font-semibold leading-tight tracking-[-0.01em]">{data.title}</h1>
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
          <h2 className="mb-1 font-medium text-dont text-sm">変えてはいけない・やらないと決めたこと</h2>
          {/* **項目の間を、折り返しの行間より広く取る。**同じだと、2 行に折り返した 1 件と
              1 行ずつの 2 件が見分けられない。 */}
          <ul className="space-y-3.5">
            {walls.map((w) => (
              <li
                key={w.id}
                className="max-w-[110ch] border-dont border-l-2 pl-3.5 text-[14px] leading-[1.95]"
              >
                {w.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* **段ではなくタブ。**畳んだ見出しを 4 つ縦に積むと、開くたびに下が動いて位置を見失う。
          横に並べれば、どれを見ているかが常に見える。 */}
      {flow.length > 0 && (
        <Tabs defaultValue={flow[0]?.label}>
          <TabsList className="mb-5">
            {flow.map(({ label, rows }) => (
              <TabsTrigger key={label} value={label} className="gap-2">
                {label}
                <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                  {rows.length}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
          {flow.map(({ label, rows }) => (
            <TabsContent key={label} value={label}>
              <ol className="space-y-2">
                {rows.map((n) => (
                  <li key={n.id}>
                    {/* **一覧はタイトルだけ。**確かめ方・得たもの・捨てた案まで並べると
                        1 件が 10 行を超え、どれが何なのか一覧として読めなくなる。 */}
                    <Detail n={n} options={options} />
                  </li>
                ))}
              </ol>
            </TabsContent>
          ))}
        </Tabs>
      )}

      <Refs refs={data.refs} />
    </article>
  );
}
