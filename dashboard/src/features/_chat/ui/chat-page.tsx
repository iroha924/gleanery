import { getRouteApi } from "@tanstack/react-router";
import { cn } from "cn";
import {
  ArrowUpIcon,
  BotIcon,
  CheckIcon,
  CopyIcon,
  MicIcon,
  SquareIcon,
  UserRoundIcon,
} from "lucide-react-motion";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Answer, repoUrlOf } from "@/components/answer";
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
import { Message, MessageAvatar, MessageContent, MessageFooter } from "@/components/ui/message";
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
import { useProject } from "@/lib/project";
import { stanceClass } from "@/lib/stance";
import { type ChatSource, type PolishOption, readFull } from "../api/chat";

const route = getRouteApi("/");

import { useChat } from "../model/use-chat";

const EXAMPLES = [
  "IndexedDBって何？",
  "このプロジェクトは何を解こうとしている？",
  "いまどこまで進んでいて、次は何をする？",
  "私が前に試して駄目だったことは？",
];

function Marked({ text, marks }: { text: string; marks: string[] }) {
  const words = marks.filter(Boolean).sort((a, b) => b.length - a.length);
  if (words.length === 0) return text;
  const pattern = new RegExp(
    `(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "g",
  );
  return text.split(pattern).map((part, index) =>
    words.includes(part) ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: 分割位置がそのまま同一性になる。
      <mark key={index} className="box-decoration-clone rounded-[3px] bg-link/20 px-0.5 text-foreground">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

/** 根拠 1 件。全文はその場で読む（選んでいる作業場所の外は読めない）。 */
function Source({ source }: { source: ChatSource }) {
  const { project } = useProject();
  const [full, setFull] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const openFull = () => {
    if (!project) return;
    setReading(true);
    setFailed(null);
    // **全文と失敗を同じ場所へ出さない。**混ぜると、読み手は本文かエラーかを区別できない。
    readFull(source.ref, [project.id])
      .then(setFull)
      .catch((error) => setFailed(error instanceof Error ? error.message : "全文を読めなかった"))
      .finally(() => setReading(false));
  };
  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) return;
        setFull(null);
        setFailed(null);
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-0 py-1 text-left text-sm leading-5 transition-colors hover:bg-secondary/70"
        >
          <span className="w-4 flex-none text-right font-mono text-xs leading-5 text-muted-foreground">
            {source.n}
          </span>
          <span className="line-clamp-2 min-w-0 text-foreground/85">
            <span className={cn("mr-1", stanceClass(source.stance))}>{source.label}</span>
            {source.text}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="gap-5 p-6 sm:max-w-[42rem]">
        <DialogHeader>
          <DialogTitle className={cn("pr-10 text-lg leading-[1.7]", stanceClass(source.stance))}>
            {source.label}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs tracking-[0.06em]">
            {[source.speaker, source.project, source.at, source.ref].filter(Boolean).join(" / ")}
          </DialogDescription>
        </DialogHeader>
        <p className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap pr-1 text-base leading-[2.1]">
          {full ?? source.text}
        </p>
        {failed && (
          <p role="alert" className="text-error text-sm leading-[1.9]">
            {failed}
          </p>
        )}
        <DialogFooter className="-mx-6 -mb-6 p-5 sm:justify-start">
          {full === null && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openFull}
              disabled={reading || !project}
            >
              {reading && <Spinner className="size-3" />}
              全文を読む
            </Button>
          )}
          {source.url && (
            <Button asChild variant="ghost" size="sm">
              <a href={source.url} target="_blank" rel="noopener noreferrer">
                GitHub で開く
              </a>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          })
          .catch(() => toast.error("クリップボードへ写せなかった"));
      }}
    >
      {done ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </Button>
  );
}

function Sources({ sources, busy }: { sources: ChatSource[]; busy: boolean }) {
  if (sources.length === 0) return null;
  if (busy)
    return (
      <div className="flex items-center gap-2 rounded-md bg-secondary/70 p-4 text-muted-foreground text-sm">
        <Spinner className="size-3" /> {sources.length} 件の記録を参照しています
      </div>
    );
  return (
    <div className="space-y-1.5 border-t pt-4 pl-4">
      <Marker className="font-mono text-xs uppercase tracking-[0.14em]">
        <MarkerContent>参照した記録</MarkerContent>
      </Marker>
      <ol>
        {sources.map((source) => (
          <li key={source.n}>
            <Source source={source} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function PolishOptions({
  options,
  polishing,
  choose,
  dismiss,
}: {
  options: PolishOption[];
  polishing: boolean;
  choose: (text: string) => void;
  dismiss: () => void;
}) {
  if (!polishing && options.length === 0) return null;
  return (
    <aside className="mb-2.5 space-y-2">
      <Marker className="font-mono text-xs uppercase tracking-[0.14em]">
        <MarkerContent>書き直しの候補</MarkerContent>
        {options.length > 0 && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="ml-auto h-auto p-0 text-muted-foreground"
            onClick={dismiss}
          >
            このままでいい
          </Button>
        )}
      </Marker>
      {polishing ? (
        <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
          <Spinner className="size-3" />
          読める文に直しています
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2.5">
          {options.map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => choose(option.text)}
              className="group flex flex-col overflow-hidden rounded-md border bg-card text-left transition-colors hover:border-foreground/25 hover:bg-accent/40"
            >
              <span className="flex flex-none items-baseline gap-2 border-b bg-secondary/40 px-3 py-1.5 font-mono text-xs text-muted-foreground uppercase tracking-[0.14em] transition-colors group-hover:text-foreground">
                {option.label}
                {option.changed.length > 0 && (
                  <span className="ml-auto normal-case tracking-normal">{option.changed.length} 箇所</span>
                )}
              </span>
              <span className="relative min-h-0">
                <span className="block max-h-36 overflow-y-auto px-3 py-2.5 text-sm leading-[1.9]">
                  <Marked text={option.text} marks={option.changed} />
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}

export function ChatPage() {
  const { chat: opened } = route.useSearch();
  const navigate = route.useNavigate();
  // 答えの中の #123 は、いま選んでいる作業場所の issue を指す。選んでいなければリンクにしない。
  const { project } = useProject();
  const repo = repoUrlOf(project?.key);
  // 会話を作ったら URL へ載せる。載せないとリロードで開き直せない。
  const chat = useChat({
    onSaved: (id) => navigate({ search: { chat: id }, replace: true }),
  });

  // URL が正本。**当てた値を覚えるのは effect の中**でやる（描画中に ref を書くと Compiler が飛ばす）。
  // 初回の描画も「まだ当てていない」から始まるので、`?chat=` 付きで開いてもここで読み込まれる。
  const applied = useRef<string | undefined | null>(null);
  useEffect(() => {
    if (applied.current === opened) return;
    applied.current = opened;
    if (opened) void chat.openChat(opened);
    else chat.newChat();
  }, [opened, chat.openChat, chat.newChat]);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <MessageScrollerProvider>
          <MessageScroller className="flex-1">
            <MessageScrollerViewport>
              {/* 答えはトークン単位で流れ込む。aria-busy が true のあいだ読み上げは変化を溜め、
                  false になったところで 1 つの発話にまとめられる（WAI-ARIA 1.2 の aria-busy）。 */}
              <MessageScrollerContent
                aria-busy={chat.busy}
                aria-live="polite"
                className="mx-auto w-full max-w-[48rem] gap-8 px-6 pt-8 pb-10"
              >
                {chat.turns.length === 0 && (
                  <Empty className="min-h-[55vh] border-none">
                    <EmptyHeader className="max-w-md">
                      <EmptyTitle className="text-lg leading-[1.5] tracking-[-0.01em]">
                        この作業場所について相談する
                      </EmptyTitle>
                      <EmptyDescription className="text-pretty leading-loose">
                        <span className="block">
                          一般的な質問にはそのまま答え、この作業場所の判断・会話・文書・PRが必要なら記録を調べて根拠を示します。
                        </span>
                        <span className="mt-1 block">
                          履歴はこのブラウザに保存します。回答時は質問・直近の会話・必要な記録を OpenAI API
                          へ送りますが、gleanery の DB には保存しません。
                        </span>
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent className="mt-3 max-w-2xl flex-row flex-wrap justify-center gap-2">
                      {EXAMPLES.map((question) => (
                        <Badge key={question} asChild variant="outline" className="rounded-md font-normal">
                          <button
                            type="button"
                            disabled={chat.projects.length === 0}
                            className="disabled:opacity-40"
                            onClick={() => chat.ask(question)}
                          >
                            {question}
                          </button>
                        </Badge>
                      ))}
                    </EmptyContent>
                  </Empty>
                )}

                {chat.turns.map((turn) =>
                  turn.role === "user" ? (
                    <MessageScrollerItem key={turn.id} messageId={turn.id} scrollAnchor>
                      <Message align="end">
                        <MessageAvatar
                          aria-hidden="true"
                          // **負の margin にしない。**content-visibility の paint containment に切られる。
                          // 1 行目の中心は、BubbleContent の p-3 が 12px 加わって 26px。
                          className="mt-3 size-7 min-w-0 self-start rounded-full border bg-card group-has-data-[slot=message-footer]/message:translate-y-0"
                        >
                          <UserRoundIcon className="size-3.5" />
                        </MessageAvatar>
                        <span className="sr-only">あなた</span>
                        <MessageContent>
                          <Bubble variant="default">
                            <BubbleContent className="whitespace-pre-wrap p-3 leading-7 [&_a]:text-primary-foreground [&_code]:bg-primary-foreground/15 [&_code]:text-primary-foreground [&_pre]:border-primary-foreground/20 [&_pre]:bg-primary-foreground/10 [&_pre]:text-primary-foreground [&_td]:border-primary-foreground/20 [&_th]:border-primary-foreground/20">
                              {turn.content}
                            </BubbleContent>
                          </Bubble>
                          <MessageFooter className="px-0">
                            <Copy text={turn.content} label="質問を写す" />
                          </MessageFooter>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ) : (
                    <MessageScrollerItem key={turn.id} messageId={turn.id}>
                      <Message>
                        <MessageAvatar
                          aria-hidden="true"
                          // AI 側は padding が無いので、leading-7 の半分がアイコンの半径と同じになる。
                          className="size-7 min-w-0 self-start rounded-full border bg-secondary/60 text-muted-foreground group-has-data-[slot=message-footer]/message:translate-y-0"
                        >
                          <BotIcon className="size-3.5" />
                        </MessageAvatar>
                        <span className="sr-only">AI</span>
                        <MessageContent className="gap-3">
                          {turn.content && <Answer text={turn.content} repo={repo} />}
                          {!turn.content &&
                            !turn.error &&
                            !turn.stopped &&
                            chat.busy &&
                            !turn.sources?.length && (
                              <p className="flex items-center gap-2 text-muted-foreground text-base">
                                <Spinner /> 考えています
                              </p>
                            )}
                          {turn.stopped && (
                            <p className="text-muted-foreground text-base">生成を中断しました</p>
                          )}
                          {/* 枠と前置きで本文から切り離す。途中まで流れた答えの直後だと、
                              どこまでが答えかが読めない。 */}
                          {turn.error && (
                            <p
                              role="alert"
                              className="rounded-md border border-error/40 bg-error/5 px-4 py-2.5 text-base text-error leading-[1.9]"
                            >
                              答えを出しきれませんでした。
                              <span className="text-muted-foreground text-sm">（{turn.error}）</span>
                            </p>
                          )}
                          {turn.sources && (
                            <Sources sources={turn.sources} busy={chat.busy && !turn.stopped} />
                          )}
                          {turn.content && !chat.busy && !turn.stopped && (
                            <MessageFooter className="px-0">
                              <Copy text={turn.content} label="答えを写す" />
                            </MessageFooter>
                          )}
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ),
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton direction="start" />
            <MessageScrollerButton direction="end" />
          </MessageScroller>
        </MessageScrollerProvider>

        <div className="relative mx-auto w-full max-w-[48rem] flex-none px-6 pb-6">
          <PolishOptions
            options={chat.options}
            polishing={chat.polishing}
            dismiss={() => chat.setOptions([])}
            choose={(text) => {
              chat.setDraft(text);
              chat.setOptions([]);
            }}
          />
          <form
            className="w-full min-w-0"
            onSubmit={(event) => {
              event.preventDefault();
              chat.ask(chat.draft);
            }}
          >
            <InputGroup className="rounded-md bg-card">
              <InputGroupTextarea
                aria-label="質問"
                value={chat.draft}
                onChange={(event) => chat.setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={
                  chat.projects.length === 0 ? "サイドバーで作業場所を 1 つ選んでください" : "続けて聞く"
                }
                disabled={chat.projects.length === 0}
                className="max-h-64 min-h-14 px-4 pt-3.5 text-base leading-[2.05]"
              />
              <InputGroupAddon align="block-end" className="gap-1.5 px-3 pb-2.5">
                <InputGroupText className="rounded-md border px-2 py-0.5 font-mono text-xs">
                  {chat.projectLabel}
                </InputGroupText>
                {chat.cost !== null && (
                  <InputGroupText className="font-mono text-xs text-muted-foreground tabular-nums">
                    直前 ${chat.cost.toFixed(3)}
                  </InputGroupText>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <InputGroupButton
                      type="button"
                      size="icon-sm"
                      variant={chat.recorder ? "default" : "ghost"}
                      className={cn("ml-auto", chat.recorder && "bg-live text-white hover:bg-live/90")}
                      onClick={chat.listen}
                      disabled={chat.hearing || chat.preparing || chat.projects.length === 0}
                      aria-label={chat.recorder ? "録音を終了" : "録音を開始"}
                    >
                      {chat.hearing || chat.preparing ? (
                        <Spinner className="size-4" />
                      ) : chat.recorder ? (
                        <SquareIcon className="size-3.5" />
                      ) : (
                        <MicIcon className="size-4" />
                      )}
                    </InputGroupButton>
                  </TooltipTrigger>
                  <TooltipContent className="flex items-center gap-2">
                    {chat.hearing
                      ? "文字にしています"
                      : chat.preparing
                        ? "準備中。始まってから話してください"
                        : chat.recorder
                          ? "録音を終了"
                          : "録音を開始"}
                    <KbdGroup>
                      <Kbd>⌘</Kbd>
                      <Kbd>⇧</Kbd>
                      <Kbd>K</Kbd>
                    </KbdGroup>
                  </TooltipContent>
                </Tooltip>
                {chat.busy ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <InputGroupButton
                        type="button"
                        size="icon-sm"
                        variant="secondary"
                        onClick={chat.stop}
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
                        type="button"
                        size="icon-sm"
                        variant="default"
                        onClick={() => chat.ask(chat.draft)}
                        aria-disabled={!chat.draft.trim() || chat.projects.length === 0}
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
