import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BotIcon, CornerDownLeftIcon, MessageSquareIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Answer } from "@/components/answer";
import { Graph } from "@/components/graph";
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
import { api, askStream, type ChatSource, type GraphNode } from "@/lib/api";
import { polarityClass } from "@/lib/polarity";
import { useProject } from "@/lib/project";

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
function Sources({
  sources,
  busy,
  onFocus,
}: {
  sources: ChatSource[];
  busy: boolean;
  onFocus: (nodeId: number) => void;
}) {
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
          根拠にした記録 {sources.length} 件 — 押すと地図の焦点が動く
          <span className="ml-1 inline-block transition-transform group-open:rotate-90">›</span>
        </summary>
        <ol className="mt-2 space-y-2 border-l pl-3">
          {sources.map((s) => (
            <li key={s.n} className="text-xs leading-relaxed">
              {/* 節から出た根拠だけが地図に居る。道具（PR 一覧・コード）が返したものには節が無い。 */}
              {s.nodeId === null ? (
                <span className="mr-1 font-medium text-muted-foreground tabular-nums">[{s.n}]</span>
              ) : (
                <button
                  type="button"
                  onClick={() => onFocus(s.nodeId as number)}
                  className="mr-1 rounded-sm bg-primary px-1 font-mono text-[10px] text-primary-foreground"
                >
                  {s.n}
                </button>
              )}
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

const KIND_LABEL: Record<string, string> = {
  decision: "決めたこと",
  option: "検討した案",
  boundary: "触らない制約",
  verification: "確かめたこと",
  question: "未解決の問い",
  event: "分かったこと",
  utterance: "発言",
};

/** 地図で選んだ節。**地図の上に浮かせる** — 列を足すと地図が狭くなる。 */
function Focus({ node, links, onClose }: { node: GraphNode; links: number; onClose: () => void }) {
  const rejected = node.kind === "option" && node.subkind === "rejected";
  return (
    <div className="absolute top-4 right-4 w-72 rounded-md border bg-card p-4 shadow-lg">
      <div className="flex items-center gap-2">
        <span
          className={`font-mono text-[10px] tracking-widest ${rejected || node.kind === "boundary" ? "text-dont" : "text-muted-foreground"}`}
        >
          {rejected ? "棄却された案" : (KIND_LABEL[node.kind] ?? node.kind)}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-muted-foreground text-xs hover:text-foreground"
        >
          閉じる
        </button>
      </div>
      <p className="mt-2 text-sm leading-relaxed">{node.text.slice(0, 320)}</p>
      <dl className="mt-3 space-y-1.5 border-t pt-3 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">つながり</dt>
          <dd className="font-mono">{links} 本</dd>
        </div>
        {node.at && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">いつ</dt>
            <dd className="font-mono">{node.at.slice(0, 10)}</dd>
          </div>
        )}
        {node.actor_name && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">誰が</dt>
            <dd className="truncate">{node.actor_name}</dd>
          </div>
        )}
        {node.pr !== null && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">出どころ</dt>
            <dd className="font-mono">PR #{node.pr}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function Chat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // 範囲はヘッダで選んだものに従う。**送信のたびに選ばせない** —
  // プロジェクトはセッション中ほぼ変わらないので、毎回同じ答えを入力させているだけだった。
  // ただし「すべて」では答えない。混ぜると別の仕事の記録がこの仕事の答えとして返る。
  const { scopeIds: picked, label: projectLabel } = useProject();
  const scopeIds = picked ?? [];
  const abort = useRef<AbortController | null>(null);
  // 開いている会話。**新しい会話は最初の答えが返ってからサーバー側で作られる。**
  const [chatId, setChatId] = useState<string | undefined>(undefined);
  const qc = useQueryClient();
  const history = useQuery({ queryKey: ["chats"], queryFn: api.chats });
  // 地図。**会話と同じ範囲だけを出す。**
  // **全部取る。**引用が発言に当たることがあり、判断だけ取ると光らせる相手が地図に居ない。
  // 出す・出さないは地図側で決める（配置は全部で計算して固定する）。
  const graph = useQuery({ queryKey: ["graph", scopeIds], queryFn: () => api.graph(picked, "all") });
  const [selected, setSelected] = useState<number | null>(null);

  // 直近の答えが引いた節。**引用の番号順に並べる** — 地図のバッジと一致させるため。
  // **毎描画で作り直さない。**新しい配列を渡すと地図側の useMemo と useEffect が
  // 毎回走り、視点の初期化が描画のたびに掛かる。
  const highlighted = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t?.role === "assistant" && t.sources) {
        // **undefined を弾く。**null だけを見ると、古い API が nodeId を返さないときに
        // undefined が並び、強調ありの見た目で 1 つも点かない状態になる（実測）。
        return t.sources.map((x) => x.nodeId).filter((x): x is number => typeof x === "number");
      }
    }
    return [];
  }, [turns]);

  const nodes = graph.data?.nodes ?? [];
  const edges = graph.data?.edges ?? [];
  // 地図に出しているのは判断だけ。**総数を出すと、見えている数と食い違う。**
  const drawn = nodes.filter((n) => n.kind !== "utterance" && n.kind !== "event").length;
  const focus = nodes.find((n) => n.id === selected) ?? null;
  const links = focus ? edges.filter((e) => e.src === focus.id || e.dst === focus.id).length : 0;

  /** 過去の会話を開く。いまの会話は捨てる（保存済みなので消えない）。 */
  const open = async (id: string) => {
    const c = await api.chat(id);
    setChatId(c.id);
    setTurns(
      c.messages.map((m, i) => ({
        id: `${c.id}-${i}`,
        role: m.role,
        content: m.content,
        sources: m.sources,
      })),
    );
  };

  const ask = async (question: string) => {
    if (!question.trim() || busy || scopeIds.length === 0) return;
    setDraft("");
    setBusy(true);
    const past = turns.map((t) => ({ role: t.role, content: t.content }));
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
        { question, history: past, scopeIds, chatId, scopeName: projectLabel },
        {
          sources: (s) => patch((t) => ({ ...t, sources: s })),
          text: (x) => patch((t) => ({ ...t, content: t.content + x })),
          error: (m) => patch((t) => ({ ...t, error: m })),
          saved: (id) => {
            setChatId(id);
            qc.invalidateQueries({ queryKey: ["chats"] });
          },
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

  const fresh = () => {
    setChatId(undefined);
    setTurns([]);
  };

  return (
    // 左で聞き、右の地図が答えの範囲を映す。**別画面にしない** —
    // 分けると、答えを読みながら地図を辿れなくなる。
    <div className="flex h-[calc(100vh-7rem)] gap-4">
      <div className="flex w-[26rem] flex-none flex-col gap-4">
        {/* 過去の会話。**消えないので聞き直さなくていい。** */}
        <div className="flex items-center gap-2">
          <Select value={chatId ?? ""} onValueChange={(v) => (v ? open(v) : fresh())}>
            <SelectTrigger className="w-72" aria-label="過去の会話">
              <SelectValue placeholder="新しい会話" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">新しい会話</SelectItem>
              {history.data?.map((h) => (
                <SelectItem key={h.id} value={h.id}>
                  {h.title ?? "（無題）"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {turns.length > 0 && (
            <Button variant="ghost" size="sm" onClick={fresh}>
              新しい会話
            </Button>
          )}
        </div>
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
                          {t.sources && (
                            <Sources sources={t.sources} busy={busy && !t.content} onFocus={setSelected} />
                          )}
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
                ? "左上でプロジェクトを選んでください"
                : "このプロジェクトについて聞く（⌘ + Enter で送信）"
            }
            disabled={scopeIds.length === 0}
            className="min-h-20 resize-none"
          />
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground text-xs">
              {scopeIds.length > 0
                ? `${projectLabel} について聞いています`
                : "左上でプロジェクトを選んでください"}
            </span>
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

      <div className="relative flex-1 overflow-hidden rounded-md border">
        {graph.isPending ? (
          <p className="p-4 text-muted-foreground text-sm">地図を組み立てています</p>
        ) : nodes.length === 0 ? (
          <p className="p-4 text-muted-foreground text-sm">
            この範囲には判断の記録がありません。取り込むと地図に出ます。
          </p>
        ) : (
          <>
            <Graph
              nodes={nodes}
              edges={edges}
              highlighted={highlighted}
              selected={selected}
              onSelect={setSelected}
            />
            <div className="pointer-events-none absolute top-4 left-4 flex items-center gap-2 font-mono text-[10px] text-muted-foreground tracking-widest">
              <span>{highlighted.length > 0 ? "答えの範囲を表示中" : "全体を表示中"}</span>
              <span className="rounded-sm border bg-card px-1.5 py-0.5">
                判断 {drawn} / 記録全体 {nodes.length}
              </span>
            </div>
            {focus && <Focus node={focus} links={links} onClose={() => setSelected(null)} />}
          </>
        )}
      </div>
    </div>
  );
}
