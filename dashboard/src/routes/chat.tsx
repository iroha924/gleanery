import { createFileRoute, Link } from "@tanstack/react-router";
import { CornerDownLeftIcon, MessageSquareIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { askStream, type ChatSource } from "@/lib/api";
import { polarityClass } from "@/lib/polarity";

export const Route = createFileRoute("/chat")({ component: Chat });

type Turn = {
  /** 本文は流れながら伸びるので、内容はキーにできない。追加時に固定の id を振る。 */
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  error?: string;
};

const EXAMPLES = [
  "記録をどこに置くと決めたか",
  "認証まわりで触らないと決めたのはどこか",
  "自動発火させると決めたか、させないと決めたか",
];

function Sources({ sources }: { sources: ChatSource[] }) {
  if (sources.length === 0) return null;
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground">
        根拠にした記録 {sources.length} 件
        <span className="ml-1 inline-block transition-transform group-open:rotate-90">›</span>
      </summary>
      <ol className="mt-2 space-y-2 border-l pl-3">
        {sources.map((s) => (
          <li key={s.n} className="text-xs leading-relaxed">
            <span className="mr-1 font-medium tabular-nums text-muted-foreground">[{s.n}]</span>
            <span className={`mr-1 ${polarityClass(s.polarity)}`}>{s.label}</span>
            {s.text}
            <span className="ml-1 text-muted-foreground">
              （
              <Link to="/records/$id" params={{ id: s.recordId }} className="underline underline-offset-2">
                {s.recordTitle}
              </Link>
              {s.at && ` / ${s.at}`}）
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function Chat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [allScopes, setAllScopes] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setDraft("");
    setBusy(true);
    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    const id = crypto.randomUUID();
    setTurns((t) => [
      ...t,
      { id: `${id}-q`, role: "user", content: question },
      { id: `${id}-a`, role: "assistant", content: "" },
    ]);

    abort.current = new AbortController();
    const patch = (fn: (t: Turn) => Turn) =>
      setTurns((prev) => prev.map((t, i) => (i === prev.length - 1 ? fn(t) : t)));

    try {
      await askStream(
        { question, history, allScopes },
        {
          sources: (s) => patch((t) => ({ ...t, sources: s })),
          text: (x) => patch((t) => ({ ...t, content: t.content + x })),
          error: (m) => patch((t) => ({ ...t, error: m })),
        },
        abort.current.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        patch((t) => ({ ...t, error: e instanceof Error ? e.message : String(e) }));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-4">
      <div className="flex-1 space-y-6 overflow-y-auto pr-1">
        {turns.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessageSquareIcon />
              </EmptyMedia>
              <EmptyTitle>記録に基づいて答えます</EmptyTitle>
              <EmptyDescription>
                答えには必ず根拠の記録が付きます。記録に無いことは「無い」と答えます。
              </EmptyDescription>
            </EmptyHeader>
            <div className="flex flex-wrap justify-center gap-2">
              {EXAMPLES.map((q) => (
                <Badge key={q} asChild variant="outline">
                  <button type="button" onClick={() => ask(q)}>
                    {q}
                  </button>
                </Badge>
              ))}
            </div>
          </Empty>
        )}

        {turns.map((t) =>
          t.role === "user" ? (
            <div key={t.id} className="flex justify-end">
              <p className="max-w-[80%] rounded-lg bg-muted px-3 py-2 text-sm leading-relaxed">{t.content}</p>
            </div>
          ) : (
            <div key={t.id} className="max-w-[68ch] space-y-3">
              {t.sources && <Sources sources={t.sources} />}
              {t.content && <p className="whitespace-pre-wrap text-sm leading-relaxed">{t.content}</p>}
              {!t.content && !t.error && busy && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner /> 記録を読んでいます
                </p>
              )}
              {t.error && <p className="text-sm text-dont">{t.error}</p>}
            </div>
          ),
        )}
      </div>

      <form
        className="space-y-2 border-t pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          ask(draft);
        }}
      >
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // 改行より送信のほうが圧倒的に多い。改行は Shift + Enter。
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask(draft);
            }
          }}
          placeholder="過去に決めたことを聞く（Shift + Enter で改行）"
          className="min-h-20 resize-none"
        />
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch id="all" checked={allScopes} onCheckedChange={setAllScopes} />
            <Label htmlFor="all" className="text-xs font-normal text-muted-foreground">
              すべてのプロジェクトから探す
            </Label>
          </div>
          {busy ? (
            <Button
              type="button"
              variant="outline"
              className="ml-auto"
              onClick={() => abort.current?.abort()}
            >
              止める
            </Button>
          ) : (
            <Button type="submit" className="ml-auto" disabled={!draft.trim()}>
              聞く <CornerDownLeftIcon />
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
