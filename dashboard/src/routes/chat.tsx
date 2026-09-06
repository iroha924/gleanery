import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BotIcon, CornerDownLeftIcon, MessageSquareIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Answer } from "@/components/answer";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Message, MessageAvatar, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, askStream, type ChatSource } from "@/lib/api";
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
  "このプロジェクトは何を解こうとしている？",
  "いまどこまで進んでいて、次は何をする？",
  "触ってはいけないところはどこ？",
  "何を試して駄目だった？",
];

/**
 * 根拠。**生成中は 1 位を開いて出す。**
 * 根拠は 0.6 秒で出るのに答えは 3 秒かかる。会議中に聞く用途では、
 * まとめを待つより「引いた 1 位」を先に読めた方が速い（実測: 体感 3.1s → 0.6s）。
 */
function Sources({ sources, busy }: { sources: ChatSource[]; busy: boolean }) {
  if (sources.length === 0) return null;
  const top = sources[0];
  return (
    <div className="space-y-2">
      {busy && top && (
        <div className="rounded-md border bg-muted/40 p-3">
          <p className="text-xs text-muted-foreground">まとめています。いちばん近い記録:</p>
          <p className="mt-1 text-sm leading-relaxed">
            <span className={`mr-1 font-medium ${polarityClass(top.polarity)}`}>{top.label}</span>
            {top.text}
          </p>
          {top.at && <p className="mt-1 text-xs text-muted-foreground tabular-nums">{top.at}</p>}
        </div>
      )}
      <details className="group">
        <summary className="cursor-pointer list-none text-muted-foreground text-xs hover:text-foreground">
          根拠にした記録 {sources.length} 件
          <span className="ml-1 inline-block transition-transform group-open:rotate-90">›</span>
        </summary>
        <ol className="mt-2 space-y-2 border-l pl-3">
          {sources.map((s) => (
            <li key={s.n} className="text-xs leading-relaxed">
              <span className="mr-1 font-medium text-muted-foreground tabular-nums">[{s.n}]</span>
              <span className={`mr-1 ${polarityClass(s.polarity)}`}>{s.label}</span>
              {s.text}
              <span className="ml-1 text-muted-foreground">
                （
                <Link to="/records/$id" params={{ id: s.recordId }} className="underline underline-offset-2">
                  {s.recordTitle}
                </Link>
                {s.at && ` / ${s.at}`}
                {s.url && (
                  <>
                    {" / "}
                    {/* PR や issue は外にある。**新しいタブで開く** — いまの会話を捨てさせない。 */}
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2"
                    >
                      開く
                    </a>
                  </>
                )}
                ）
              </span>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

function Chat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // **どのプロジェクトについて聞くかを先に選ぶ。**選ばないと送れない。
  // 範囲なしで全部を混ぜると、別の仕事の記録がこのプロジェクトの答えとして返る。
  const [target, setTarget] = useState<string>("");
  const scopes = useQuery({ queryKey: ["scopes"], queryFn: api.scopes });
  const groups = useQuery({ queryKey: ["groups"], queryFn: api.groups });

  const scopeIds = target.startsWith("g:")
    ? (groups.data?.find((g) => `g:${g.id}` === target)?.members.map((m) => m.id) ?? [])
    : target
      ? [Number(target)]
      : [];
  const abort = useRef<AbortController | null>(null);

  const ask = async (question: string) => {
    if (!question.trim() || busy || scopeIds.length === 0) return;
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
        { question, history, scopeIds },
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
      {/* 生成中の自動追従と最下部へ戻るボタンは MessageScroller が持っている。
          自前の overflow-y-auto だと、答えが画面の下へ流れ落ちて追えない。 */}
      <MessageScrollerProvider>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent aria-busy={busy}>
              {turns.length === 0 && (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <MessageSquareIcon />
                    </EmptyMedia>
                    <EmptyTitle>このプロジェクトについて聞く</EmptyTitle>
                    <EmptyDescription>
                      保存されているものだけで答えます。記録に無いことは「無い」と答え、
                      答えには根拠が付きます。
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

              {turns.map((t) => (
                <MessageScrollerItem key={t.id} messageId={t.id} scrollAnchor={t.role === "user"}>
                  {t.role === "user" ? (
                    <Message align="end">
                      <MessageContent>
                        <Bubble>
                          <BubbleContent>{t.content}</BubbleContent>
                        </Bubble>
                      </MessageContent>
                    </Message>
                  ) : (
                    <Message>
                      <MessageAvatar>
                        <Avatar>
                          <AvatarFallback>
                            <BotIcon className="size-4" />
                          </AvatarFallback>
                        </Avatar>
                      </MessageAvatar>
                      <MessageContent className="space-y-3">
                        {t.sources && <Sources sources={t.sources} busy={busy && !t.content} />}
                        {t.content && (
                          <Bubble variant="ghost">
                            <BubbleContent>
                              <Answer text={t.content} />
                            </BubbleContent>
                          </Bubble>
                        )}
                        {!t.content && !t.error && !t.sources && busy && (
                          <p className="flex items-center gap-2 text-muted-foreground text-sm">
                            <Spinner /> 記録を探しています
                          </p>
                        )}
                        {t.error && <p className="text-sm text-dont">{t.error}</p>}
                      </MessageContent>
                    </Message>
                  )}
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

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
            // **Enter では送らない。**日本語入力では Enter が変換の確定に使われるので、
            // 送信に割り当てると変換の途中で飛ぶ（実測: 漢字に変換して確定した瞬間に送信された）。
            // `isComposing` を見るだけでは足りない — 変換の確定と、確定後の 1 打目の Enter は
            // どちらも composing が false で来る。送信は修飾キー付きに寄せる。
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              ask(draft);
            }
          }}
          placeholder={
            scopeIds.length === 0
              ? "先にプロジェクトを選んでください"
              : "このプロジェクトについて聞く（⌘ + Enter で送信）"
          }
          disabled={scopeIds.length === 0}
          className="min-h-20 resize-none"
        />
        <div className="flex items-center gap-3">
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger className="w-[19rem]">
              <SelectValue placeholder="どのプロジェクトについて聞くか選ぶ" />
            </SelectTrigger>
            <SelectContent>
              {groups.data?.map((g) => (
                <SelectItem key={`g:${g.id}`} value={`g:${g.id}`}>
                  {g.name}（{g.members.length} プロジェクト）
                </SelectItem>
              ))}
              {scopes.data?.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
            <Button type="submit" className="ml-auto" disabled={!draft.trim() || scopeIds.length === 0}>
              聞く
              <kbd className="ml-1 rounded border px-1 text-[10px] leading-4 opacity-70">⌘</kbd>
              <CornerDownLeftIcon />
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
