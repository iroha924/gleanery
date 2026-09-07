import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpIcon, MicIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Answer } from "@/components/answer";
import { Badge } from "@/components/ui/badge";
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
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Marker, MarkerContent } from "@/components/ui/marker";
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

export const Route = createFileRoute("/")({ component: Chat });

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
          className="flex w-full gap-3 rounded-lg px-2 py-1.5 text-left text-[13px] leading-[1.95] transition-colors hover:bg-secondary/60"
        >
          <span className="flex-none pt-0.5 font-mono text-[10.5px] text-muted-foreground">{s.n}</span>
          <span className="min-w-0 text-foreground/85">
            <span className={`mr-1 ${polarityClass(s.polarity)}`}>{s.label}</span>
            {s.text}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[36rem]">
        <DialogHeader>
          <DialogTitle className="text-[1.15rem] leading-[1.7]">
            <span className={`mr-1.5 ${polarityClass(s.polarity)}`}>{s.label}</span>
            {s.recordTitle}
          </DialogTitle>
          <DialogDescription className="font-mono text-[10px] uppercase tracking-[0.12em]">
            {s.scope}
            {s.at && ` / ${s.at}`}
          </DialogDescription>
        </DialogHeader>
        <p className="max-h-[50vh] overflow-y-auto text-[14px] leading-[2.1]">{s.text}</p>
        <DialogFooter className="sm:justify-start">
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

function Sources({ sources, busy }: { sources: ChatSource[]; busy: boolean }) {
  if (sources.length === 0) return null;
  const top = sources[0];
  return (
    <div className="space-y-4">
      {/* 生成中は 1 位だけ先に出す。**根拠は 0.6 秒、答えは 3 秒**なので、待たせない。 */}
      {busy && top && (
        <div className="rounded-xl bg-secondary/70 p-4">
          <p className="text-muted-foreground text-xs">まとめています。いちばん近い記録:</p>
          <p className="mt-1.5 text-sm leading-relaxed">
            <span className={`mr-1 font-medium ${polarityClass(top.polarity)}`}>{top.label}</span>
            {top.text}
          </p>
        </div>
      )}
      {!busy && (
        <div className="space-y-2 border-t pt-5">
          <Marker className="px-2 font-mono text-[8.5px] uppercase tracking-[0.14em]">
            <MarkerContent>Sources</MarkerContent>
          </Marker>
          <ol className="-mx-2">
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
  // 範囲はヘッダで選んだものに従う。**送信のたびに選ばせない** —
  // プロジェクトはセッション中ほぼ変わらないので、毎回同じ答えを入力させているだけだった。
  // ただし「すべて」では答えない。混ぜると別の仕事の記録がこの仕事の答えとして返る。
  const { scopeIds: picked, label: projectLabel } = useProject();
  const scopeIds = picked ?? [];
  const abort = useRef<AbortController | null>(null);
  // 話して入れる。**録った音は手元の whisper.cpp へ行くだけで、外へは出ない。**
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [hearing, setHearing] = useState(false);
  // マイクが立ち上がるまでの数百 ms。**ここを「録音中」と見せると先頭の音が落ちる。**
  const [preparing, setPreparing] = useState(false);
  // 書き直しの候補。**入れ替えるのは押されたときだけ**で、黙って直さない。
  const [options, setOptions] = useState<PolishOption[]>([]);
  const [polishing, setPolishing] = useState(false);
  // 開いている会話。**新しい会話は最初の答えが返ってからサーバー側で作られる。**
  const [chatId, setChatId] = useState<string | undefined>(undefined);
  const qc = useQueryClient();
  const history = useQuery({ queryKey: ["chats"], queryFn: api.chats });
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
      if (e.key.toLowerCase() === "k" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        listen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const ask = async (question: string) => {
    setOptions([]);
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
    // **1 往復を 1 本の短い記事として読ませる** — 質問が見出し、答えが本文、
    // 根拠が末尾の脚注。吹き出しの往復にしない。
    <div className="-m-4 flex h-[calc(100vh-3.5rem)]">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 flex-none items-center gap-2 px-6">
          <Select value={chatId ?? ""} onValueChange={(v) => (v ? open(v) : fresh())}>
            <SelectTrigger className="h-8 w-64 rounded-full border-none bg-transparent text-xs shadow-none hover:bg-secondary">
              <SelectValue placeholder="新しく聞く" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">新しく聞く</SelectItem>
              {history.data?.map((h) => (
                <SelectItem key={h.id} value={h.id}>
                  {h.title ?? "（無題）"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <MessageScrollerProvider>
          <MessageScroller className="flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent aria-busy={busy} className="mx-auto w-full max-w-[83rem] px-6 pb-10">
                {turns.length === 0 && (
                  <div className="pt-24 text-center">
                    <h2 className="font-extrabold text-2xl leading-relaxed">記録について聞く</h2>
                    <p className="mx-auto mt-3 max-w-96 text-muted-foreground text-sm leading-loose">
                      保存されているものだけで答えます。記録に無いことは「無い」と答え、
                      答えには根拠が付きます。
                    </p>
                    <div className="mt-7 flex flex-wrap justify-center gap-2">
                      {EXAMPLES.map((q) => (
                        <Badge key={q} asChild variant="outline" className="rounded-full font-normal">
                          <button type="button" onClick={() => ask(q)}>
                            {q}
                          </button>
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {turns.map((t, i) =>
                  t.role === "user" ? (
                    <MessageScrollerItem key={t.id} messageId={t.id} scrollAnchor>
                      {/* 質問が見出しになる。日付と範囲をその上に小さく乗せる */}
                      <div className={i === 0 ? "pt-4" : "pt-14"}>
                        <Marker className="font-mono text-[9px] uppercase tracking-[0.14em]">
                          <MarkerContent>
                            {new Date().toLocaleDateString("sv-SE").replaceAll("-", ".")} · {projectLabel}
                          </MarkerContent>
                        </Marker>
                        <h2 className="mt-3 font-extrabold text-[1.7rem] leading-[1.62]">{t.content}</h2>
                        <div className="mt-5 h-px bg-border" />
                      </div>
                    </MessageScrollerItem>
                  ) : (
                    <MessageScrollerItem key={t.id} messageId={t.id}>
                      <div className="mt-6 space-y-5">
                        {t.content && <Answer text={t.content} />}
                        {!t.content && !t.error && busy && (
                          <p className="flex items-center gap-2 text-muted-foreground text-sm">
                            <Spinner /> 記録を探しています
                          </p>
                        )}
                        {t.error && <p className="text-dont text-sm">{t.error}</p>}
                        {t.sources && <Sources sources={t.sources} busy={busy && !t.content} />}
                      </div>
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
        <div className="mx-auto w-full max-w-[83rem] flex-none px-6 pb-6">
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
                <div className="flex items-center gap-2 rounded-xl border border-dashed px-3 py-2.5 text-[12px] text-muted-foreground">
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
                      className="group flex flex-col overflow-hidden rounded-xl border bg-card text-left transition hover:border-primary/45 hover:shadow-[0_3px_14px_rgba(0,0,0,0.06)]"
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
            <div className="rounded-2xl border bg-card px-6 py-4 shadow-[0_1px_2px_rgba(0,0,0,0.03),0_10px_26px_rgba(0,0,0,0.045)]">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // **Enter では送らない。**日本語入力では変換の確定に使われるため。
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    ask(draft);
                  }
                }}
                placeholder={scopeIds.length === 0 ? "左でプロジェクトを選んでください" : "続けて聞く"}
                disabled={scopeIds.length === 0}
                className="-m-2 min-h-12 resize-none border-none bg-transparent p-2 text-[15px] leading-[2.15] shadow-none focus-visible:ring-0"
              />
              <div className="flex items-center gap-2 pt-2">
                <span className="rounded-md border px-2 py-1 font-mono text-[9px] text-muted-foreground">
                  {projectLabel}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant={rec ? "default" : "ghost"}
                      size="icon"
                      className={`ml-auto size-8 rounded-full ${rec ? "bg-dont text-white hover:bg-dont/90" : ""}`}
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
                    </Button>
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
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => abort.current?.abort()}
                  >
                    止める
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    size="icon"
                    className="size-8 rounded-full"
                    disabled={!draft.trim() || scopeIds.length === 0}
                    aria-label="送る"
                  >
                    <ArrowUpIcon className="size-4" />
                  </Button>
                )}
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
