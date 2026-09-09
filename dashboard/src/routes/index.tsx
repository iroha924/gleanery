import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpIcon, CheckIcon, CopyIcon, MicIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Answer } from "@/components/answer";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, askStream, type ChatSource, type PolishOption } from "@/lib/api";
import { polarityClass } from "@/lib/polarity";
import { useProject } from "@/lib/project";

/** 書き換えられた語を本文の中で光らせる。**3 つの候補は書き出しが同じなので、差が見えない。** */
function Marked({ text, marks }: { text: string; marks: string[] }) {
  const words = marks.filter(Boolean).sort((a, b) => b.length - a.length);
  if (words.length === 0) return text;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  return text.split(re).map((part, i) =>
    words.includes(part) ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: 分割の位置がそのまま同一性
      <mark key={i} className="box-decoration-clone rounded-[3px] bg-link/20 px-0.5 text-foreground">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

type Search = { chat?: string };

export const Route = createFileRoute("/")({
  component: Chat,
  // **開いている会話は URL に持つ。**サイドバーから開けるようにするには状態を共有する必要があり、
  // Context を足すより URL のほうが素直（再読み込みと戻るがそのまま効く）。
  validateSearch: (s: Record<string, unknown>): Search =>
    typeof s.chat === "string" && s.chat ? { chat: s.chat } : {},
});

type Turn = {
  /** 本文は流れながら伸びるので、内容はキーにできない。追加時に固定の id を振る。 */
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  error?: string;
  stopped?: boolean;
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
/**
 * 出典 1 件。**会話から離れずに中身を読めるようにする。**
 *
 * 記録のページへ飛ばすと、読み終えたあと会話へ戻るのに一手かかり、続けて聞く流れが切れる。
 */
function Source({ s }: { s: ChatSource }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="flex w-full gap-3 rounded-md px-3 py-2.5 text-left text-[13px] leading-[1.95] transition-colors hover:bg-secondary/70"
        >
          <span className="flex-none pt-0.5 font-mono text-[10.5px] text-muted-foreground">{s.n}</span>
          {/* **一覧では 2 行で切る。**PR 本文がそのまま入っていると 10 行を超え、
              どれが何なのか読み取れなくなる。全文は押せば開く。 */}
          <span className="line-clamp-2 min-w-0 text-foreground/85">
            <span className={`mr-1 ${polarityClass(s.polarity)}`}>{s.label}</span>
            {s.text}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="gap-5 p-6 sm:max-w-[42rem]">
        <DialogHeader>
          <DialogTitle className="pr-10 text-[1.15rem] leading-[1.7]">
            <span className={`mr-1.5 ${polarityClass(s.polarity)}`}>{s.label}</span>
            {s.recordTitle}
          </DialogTitle>
          <DialogDescription className="font-mono text-[10px] uppercase tracking-[0.12em]">
            {s.actor && `@${s.actor} / `}
            {s.scope}
            {s.at && ` / ${s.at}`}
          </DialogDescription>
        </DialogHeader>
        <p className="max-h-[50vh] overflow-y-auto pr-1 text-[14px] leading-[2.1]">
          {/* 見出しに @名前 を出しているので、本文の頭の同じものは剥がす。 */}
          {s.actor ? s.text.replace(/^@[^\s:]+:\s*/, "") : s.text}
        </p>
        <DialogFooter className="-mx-6 -mb-6 p-5 sm:justify-start">
          <Button asChild variant="outline" size="sm">
            <Link to="/records/$id" params={{ id: s.recordId }}>
              記録を開く
            </Link>
          </Button>
          {s.url && (
            <Button asChild variant="ghost" size="sm">
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                PR を開く
              </a>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 写す。**ホバーで出す** — 常に出しておくと、読んでいる行の脇で常時ちらつく。
 * 押した後に印を変えるのは、写せたかが他に分からないため（二度押しの原因になる）。
 */
function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      className="size-7 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/message:opacity-100"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </Button>
  );
}

function Sources({ sources, busy }: { sources: ChatSource[]; busy: boolean }) {
  if (sources.length === 0) return null;
  const top = sources[0];
  return (
    <div className="space-y-4">
      {/* 生成中は 1 位だけ先に出す。**根拠は 0.6 秒、答えは 3 秒**なので、待たせない。 */}
      {busy && top && (
        <div className="rounded-md bg-secondary/70 p-4">
          <p className="text-muted-foreground text-xs">まとめています。いちばん近い記録:</p>
          <p className="mt-1.5 text-sm leading-relaxed">
            <span className={`mr-1 font-medium ${polarityClass(top.polarity)}`}>{top.label}</span>
            {top.text}
          </p>
        </div>
      )}
      {!busy && (
        <div className="space-y-2 border-t pt-5">
          <Marker className="px-3 font-mono text-[8.5px] uppercase tracking-[0.14em]">
            <MarkerContent>Sources</MarkerContent>
          </Marker>
          <ol className="-mx-3 space-y-0.5">
            {sources.map((s) => (
              <li key={s.n}>
                <Source s={s} />
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function Chat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // **turn に持たせない。**保存後に会話を読み直すと turns ごと入れ替わって消える。
  // 今月の累計はそもそも会話ごとの値でもない。
  const [cost, setCost] = useState<{ question: number; month: number | null } | null>(null);
  // 範囲はヘッダで選んだものに従う。**送信のたびに選ばせない** —
  // プロジェクトはセッション中ほぼ変わらないので、毎回同じ答えを入力させているだけだった。
  // ただし「すべて」では答えない。混ぜると別の仕事の記録がこの仕事の答えとして返る。
  const { scopeIds: picked, label: projectLabel } = useProject();
  const scopeIds = picked ?? [];
  const abort = useRef<AbortController | null>(null);
  const pendingQuestion = useRef<string | null>(null);
  // 話して入れる。**録った音は手元の whisper.cpp へ行くだけで、外へは出ない。**
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [hearing, setHearing] = useState(false);
  // マイクが立ち上がるまでの数百 ms。**ここを「録音中」と見せると先頭の音が落ちる。**
  const [preparing, setPreparing] = useState(false);
  // 書き直しの候補。**入れ替えるのは押されたときだけ**で、黙って直さない。
  const [options, setOptions] = useState<PolishOption[]>([]);
  const [polishing, setPolishing] = useState(false);
  // 開いている会話。**新しい会話は最初の答えが返ってからサーバー側で作られる。**
  const { chat: chatId } = Route.useSearch();
  const nav = useNavigate({ from: Route.fullPath });
  const setChatId = (id: string | undefined) => nav({ search: id ? { chat: id } : {} });
  const qc = useQueryClient();

  const stop = () => {
    const controller = abort.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    const question = pendingQuestion.current;
    if (question !== null) {
      setDraft((current) => current || question);
      pendingQuestion.current = null;
    }
    setTurns((prev) =>
      prev.map((turn, index) => (index >= prev.length - 2 ? { ...turn, stopped: true } : turn)),
    );
  };

  /** 押すと録り始め、もう一度押すと止めて文字にする。 */
  const listen = async () => {
    if (rec) {
      rec.stop();
      return;
    }
    if (preparing) return;
    setPreparing(true);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setPreparing(false);
      toast.error("マイクを使えなかった");
      return;
    }
    // **24kbps で録る。**API の上限は 25MB で、既定の 128kbps だと 1 時間の会議で超える。
    // 音声認識にはこれで足りる（人の声の帯域しか要らない）。
    const m = new MediaRecorder(stream, { audioBitsPerSecond: 24_000 });
    const chunks: Blob[] = [];
    m.ondataavailable = (e) => chunks.push(e.data);
    m.onstop = async () => {
      for (const t of stream.getTracks()) t.stop();
      setRec(null);
      setHearing(true);
      try {
        const text = await api.transcribe(new Blob(chunks, { type: m.mimeType }));
        if (!text) {
          toast.error("何も聞き取れなかった");
          return;
        }
        setDraft((d) => (d ? `${d} ${text}` : text));
        // 候補は後から追いつく。**待たせない** — 生のままで送れる状態にしてから取りに行く。
        setPolishing(true);
        api
          .polish(text)
          .then(setOptions)
          .catch(() => {})
          .finally(() => setPolishing(false));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setHearing(false);
      }
    };
    // **録音が本当に始まってから「録音中」にする。**start() の時点ではまだマイクが立ち上がって
    // おらず、押した直後に話すと先頭が落ちる（実測:「ポストグレス」の「ポ」が消えた）。
    m.onstart = () => {
      setPreparing(false);
      setRec(m);
    };
    m.start();
  };

  // **⌘⇧K で録り始め、もう一度で止める。**Chrome が macOS で押さえていない組み合わせを選んだ
  // （⌘⇧M はプロファイル切替、⌘⇧V は書式なしペースト、⌘⇧Q は macOS のログアウト）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && abort.current && !abort.current.signal.aborted) {
        e.preventDefault();
        stop();
        return;
      }
      if (e.key.toLowerCase() === "k" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        listen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // **URL の会話を読み込む。**サイドバーから開いたときも、再読み込みしたときも同じ経路を通る。
  const loaded = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!chatId) {
      if (loaded.current) {
        loaded.current = undefined;
        setTurns([]);
      }
      return;
    }
    if (loaded.current === chatId) return;
    loaded.current = chatId;
    api
      .chat(chatId)
      .then((c) =>
        setTurns(
          c.messages.map((m, i) => ({
            id: `${c.id}-${i}`,
            role: m.role,
            content: m.content,
            sources: m.sources,
          })),
        ),
      )
      .catch(() => toast.error("会話を開けなかった"));
  }, [chatId]);

  const ask = async (question: string) => {
    setOptions([]);
    if (!question.trim() || busy || scopeIds.length === 0) return;
    setDraft("");
    setBusy(true);
    pendingQuestion.current = question;
    const past = turns.filter((t) => !t.stopped).map((t) => ({ role: t.role, content: t.content }));
    const id = crypto.randomUUID();
    setTurns((t) => [
      ...t,
      { id: `${id}-q`, role: "user", content: question },
      { id: `${id}-a`, role: "assistant", content: "" },
    ]);

    const controller = new AbortController();
    abort.current = controller;
    const patch = (fn: (t: Turn) => Turn) =>
      setTurns((prev) => prev.map((t, i) => (i === prev.length - 1 ? fn(t) : t)));

    try {
      await askStream(
        { question, history: past, scopeIds, chatId, scopeName: projectLabel },
        {
          sources: (s) => patch((t) => ({ ...t, sources: s })),
          text: (x) => patch((t) => ({ ...t, content: t.content + x })),
          error: (m) => patch((t) => ({ ...t, error: m })),
          cost: (question, month) => setCost({ question, month }),
          saved: (id) => {
            if (abort.current === controller) {
              abort.current = null;
              pendingQuestion.current = null;
              setBusy(false);
            }
            setChatId(id);
            qc.invalidateQueries({ queryKey: ["chats"] });
          },
        },
        controller.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        patch((t) => ({ ...t, error: e instanceof Error ? e.message : String(e) }));
      }
    } finally {
      if (abort.current === controller) {
        abort.current = null;
        pendingQuestion.current = null;
        setBusy(false);
      }
    }
  };

  return (
    // **往復として読ませる。**自分の発言は右に寄せた吹き出し、答えは地の文。
    // 質問を見出しにしていたときは、聞いた本人の一言が記事の題に化けて、
    // 続けて聞くほど「誰が書いたのか」が読めなくなっていた。
    <div className="-m-4 flex h-[calc(100vh-3.5rem)]">
      <div className="flex min-w-0 flex-1 flex-col">
        <MessageScrollerProvider>
          <MessageScroller className="flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent aria-busy={busy} className="mx-auto w-full max-w-[64rem] px-6 pb-10">
                {turns.length === 0 && (
                  <Empty className="min-h-[55vh] border-none">
                    <EmptyHeader className="max-w-md">
                      <EmptyTitle className="text-2xl leading-[1.5] tracking-[-0.01em]">
                        記録について聞く
                      </EmptyTitle>
                      <EmptyDescription className="text-pretty leading-loose">
                        保存されているものだけで答えます。記録に無いことは「無い」と答え、
                        答えには根拠が付きます。
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent className="mt-3 max-w-2xl flex-row flex-wrap justify-center gap-2">
                      {EXAMPLES.map((q) => (
                        <Badge key={q} asChild variant="outline" className="rounded-md font-normal">
                          <button type="button" onClick={() => ask(q)}>
                            {q}
                          </button>
                        </Badge>
                      ))}
                    </EmptyContent>
                  </Empty>
                )}

                {turns.map((t) =>
                  t.role === "user" ? (
                    <MessageScrollerItem key={t.id} messageId={t.id} scrollAnchor>
                      <Message align="end" className="pt-9">
                        <MessageContent>
                          <Bubble align="end" variant="secondary">
                            {/* **改行を保つ。**貼り付けた箇条書きが 1 行に潰れると、何を聞いたのか読めない。 */}
                            <BubbleContent className="whitespace-pre-wrap px-4 py-2.5 text-[14px] leading-[1.9]">
                              {t.content}
                            </BubbleContent>
                          </Bubble>
                          <MessageFooter className="px-0">
                            <Copy text={t.content} label="質問を写す" />
                          </MessageFooter>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ) : (
                    <MessageScrollerItem key={t.id} messageId={t.id}>
                      <Message className="pt-4">
                        <MessageContent className="gap-5">
                          {t.content && <Answer text={t.content} />}
                          {!t.content && !t.error && !t.stopped && busy && (
                            <p className="flex items-center gap-2 text-muted-foreground text-sm">
                              <Spinner /> 記録を探しています
                            </p>
                          )}
                          {t.stopped && <p className="text-muted-foreground text-sm">生成を中断しました</p>}
                          {t.error && <p className="text-dont text-sm">{t.error}</p>}
                          {t.sources && (
                            <Sources sources={t.sources} busy={busy && !t.content && !t.stopped} />
                          )}
                          {/* 流し終えるまで出さない。**途中の本文を写しても使えない。** */}
                          {t.content && !busy && !t.stopped && (
                            <MessageFooter className="px-0">
                              <Copy text={t.content} label="答えを写す" />
                            </MessageFooter>
                          )}
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ),
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>

        {/* **候補は横に並べる。**絶対配置で右へ浮かすと、窓が狭いときに画面の外へ出る
            （1400px 幅で溢れる）。列にしておけば、狭ければ本文が縮むだけで崩れない。 */}
        <div className="relative mx-auto w-full max-w-[64rem] flex-none px-6 pb-6">
          {/* 上の本文が入力欄の縁で断ち切られると、続きがあるのか終わりなのか分からない。 */}
          <div className="pointer-events-none absolute inset-x-0 -top-10 h-10 bg-gradient-to-t from-background to-transparent" />
          {(polishing || options.length > 0) && (
            <aside className="mb-2.5 space-y-2">
              <Marker className="font-mono text-[9px] uppercase tracking-[0.14em]">
                <MarkerContent>書き直しの候補</MarkerContent>
                {options.length > 0 && (
                  <button
                    type="button"
                    className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() => setOptions([])}
                  >
                    このままでいい
                  </button>
                )}
              </Marker>
              {polishing ? (
                <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2.5 text-[12px] text-muted-foreground">
                  <Spinner className="size-3" />
                  読める文に直しています
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-2.5">
                  {options.map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      onClick={() => {
                        setDraft(o.text);
                        setOptions([]);
                      }}
                      className="group flex flex-col overflow-hidden rounded-md border bg-card text-left transition-colors hover:border-foreground/25 hover:bg-accent/40"
                    >
                      {/* **見出しは本文の外に置く。**中に重ねると、スクロールした本文が透ける。 */}
                      <span className="flex flex-none items-baseline gap-2 border-b bg-secondary/40 px-3 py-1.5 font-mono text-[9px] text-muted-foreground uppercase tracking-[0.14em] transition-colors group-hover:text-foreground">
                        {o.label}
                        {o.changed.length > 0 && (
                          <span className="ml-auto normal-case tracking-normal">{o.changed.length} 箇所</span>
                        )}
                      </span>
                      <span className="relative min-h-0">
                        <span className="block max-h-36 overflow-y-auto px-3 py-2.5 text-[12.5px] leading-[1.9]">
                          <Marked text={o.text} marks={o.changed} />
                        </span>
                        {/* **下端をぼかす。**切れているのか終わったのかが、切り口だけでは分からない。 */}
                        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-card to-transparent" />
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </aside>
          )}
          <form
            className="w-full min-w-0"
            onSubmit={(e) => {
              e.preventDefault();
              ask(draft);
            }}
          >
            {/* **入力欄は伸びる。**textarea の field-sizing-content が効くので、
                長い質問でも 8 行までは全文が見えたまま書ける。 */}
            <InputGroup className="rounded-xl bg-card shadow-xs">
              <InputGroupTextarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // 変換確定の Enter は送信にしない。Shift + Enter は textarea の改行へ渡す。
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={scopeIds.length === 0 ? "左でプロジェクトを選んでください" : "続けて聞く"}
                disabled={scopeIds.length === 0}
                className="max-h-64 min-h-14 px-4 pt-3.5 text-[15px] leading-[2.05]"
              />
              <InputGroupAddon align="block-end" className="gap-1.5 px-3 pb-2.5">
                <InputGroupText className="rounded-md border px-2 py-0.5 font-mono text-[9px]">
                  {projectLabel}
                </InputGroupText>
                {cost && (
                  <InputGroupText className="font-mono text-[9px] text-muted-foreground tabular-nums">
                    直前 ${cost.question.toFixed(3)}
                    {/* 積み上げた log を読めないホストでは月額を出さない。0 と見分けが付かない */}
                    {cost.month !== null && ` / 今月 $${cost.month.toFixed(2)}`}
                  </InputGroupText>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <InputGroupButton
                      size="icon-sm"
                      variant={rec ? "default" : "ghost"}
                      className={`ml-auto ${rec ? "bg-dont text-white hover:bg-dont/90" : ""}`}
                      onClick={listen}
                      disabled={hearing || preparing || scopeIds.length === 0}
                      aria-label={rec ? "録音を終了" : "録音を開始"}
                    >
                      {hearing || preparing ? (
                        <Spinner className="size-4" />
                      ) : rec ? (
                        <SquareIcon className="size-3.5" />
                      ) : (
                        <MicIcon className="size-4" />
                      )}
                    </InputGroupButton>
                  </TooltipTrigger>
                  <TooltipContent className="flex items-center gap-2">
                    {hearing
                      ? "文字にしています"
                      : preparing
                        ? "準備中。始まってから話してください"
                        : rec
                          ? "録音を終了"
                          : "録音を開始"}
                    <KbdGroup>
                      <Kbd>⌘</Kbd>
                      <Kbd>⇧</Kbd>
                      <Kbd>K</Kbd>
                    </KbdGroup>
                  </TooltipContent>
                </Tooltip>
                {busy ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <InputGroupButton
                        size="icon-sm"
                        variant="destructive"
                        onClick={stop}
                        aria-label="生成を中断"
                      >
                        <SquareIcon className="size-3" />
                      </InputGroupButton>
                    </TooltipTrigger>
                    <TooltipContent className="flex items-center gap-2">
                      生成を中断
                      <Kbd>Esc</Kbd>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <InputGroupButton
                        type="submit"
                        size="icon-sm"
                        variant="default"
                        // **disabled にしない。**InputGroup は has-disabled で枠ごと薄くするので、
                        // 書き始める前の入力欄が「使えない欄」に見えていた。送れないことはボタン
                        // 自身の濃さで示し、押下は ask() が空文字で弾く。
                        aria-disabled={!draft.trim() || scopeIds.length === 0}
                        className="aria-disabled:pointer-events-none aria-disabled:opacity-40"
                        aria-label="送る"
                      >
                        <ArrowUpIcon className="size-4" />
                      </InputGroupButton>
                    </TooltipTrigger>
                    <TooltipContent className="flex items-center gap-2">
                      送る
                      <Kbd>⏎</Kbd>
                    </TooltipContent>
                  </Tooltip>
                )}
              </InputGroupAddon>
            </InputGroup>
          </form>
        </div>
      </div>
    </div>
  );
}
