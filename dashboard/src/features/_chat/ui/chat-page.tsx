import {
  ArrowUpIcon,
  BotIcon,
  CheckIcon,
  CopyIcon,
  MicIcon,
  SquareIcon,
  UserRoundIcon,
} from "lucide-react-motion";
import { useState } from "react";
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
import { api } from "@/lib/api";
import { useProject } from "@/lib/project";
import { stanceClass } from "@/lib/stance";
import type { ChatSource, PolishOption } from "../api/chat";
import { useChat } from "../model/use-chat";

const EXAMPLES = [
  "このプロジェクトは何を解こうとしている？",
  "いまどこまで進んでいて、次は何をする？",
  "触ってはいけないところはどこ？",
  "何を試して駄目だった？",
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

/** 根拠 1 件。**全文はその場で読む**（選んでいる作業場所の外は読めない）。 */
function Source({ source }: { source: ChatSource }) {
  const { project } = useProject();
  const [full, setFull] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const readFull = () => {
    if (!project) return;
    setReading(true);
    api
      .read(source.ref, [project.id])
      .then(setFull)
      .catch((error) => setFull(error instanceof Error ? error.message : String(error)))
      .finally(() => setReading(false));
  };
  return (
    <Dialog onOpenChange={(open) => !open && setFull(null)}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-0 py-1 text-left text-sm leading-5 transition-colors hover:bg-secondary/70"
        >
          <span className="w-4 flex-none text-right font-mono text-xs leading-5 text-muted-foreground">
            {source.n}
          </span>
          <span className="line-clamp-2 min-w-0 text-foreground/85">
            <span className={`mr-1 ${stanceClass(source.stance)}`}>{source.label}</span>
            {source.text}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="gap-5 p-6 sm:max-w-[42rem]">
        <DialogHeader>
          <DialogTitle className={`pr-10 text-lg leading-[1.7] ${stanceClass(source.stance)}`}>
            {source.label}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs tracking-[0.06em]">
            {[source.speaker, source.project, source.at, source.ref].filter(Boolean).join(" / ")}
          </DialogDescription>
        </DialogHeader>
        <p className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap pr-1 text-base leading-[2.1]">
          {full ?? source.text}
        </p>
        <DialogFooter className="-mx-6 -mb-6 p-5 sm:justify-start">
          {full === null && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={readFull}
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
      {busy && top && (
        <div className="rounded-md bg-secondary/70 p-4">
          <p className="text-muted-foreground text-sm">まとめています。いちばん近い記録:</p>
          <p className="mt-1.5 text-base leading-relaxed">
            <span className={`mr-1 font-medium ${stanceClass(top.stance)}`}>{top.label}</span>
            {top.text}
          </p>
        </div>
      )}
      {!busy && (
        <div className="space-y-1.5 border-t pt-4 pl-4">
          <Marker className="font-mono text-xs uppercase tracking-[0.14em]">
            <MarkerContent>Sources</MarkerContent>
          </Marker>
          <ol>
            {sources.map((source) => (
              <li key={source.n}>
                <Source source={source} />
              </li>
            ))}
          </ol>
        </div>
      )}
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
          <button
            type="button"
            className="ml-auto text-sm text-muted-foreground underline-offset-2 hover:underline"
            onClick={dismiss}
          >
            このままでいい
          </button>
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
  const chat = useChat();

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <MessageScrollerProvider>
          <MessageScroller className="flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent
                aria-busy={chat.busy}
                className="mx-auto w-full max-w-[48rem] px-6 pb-10"
              >
                {chat.turns.length === 0 && (
                  <Empty className="min-h-[55vh] border-none">
                    <EmptyHeader className="max-w-md">
                      <EmptyTitle className="text-lg leading-[1.5] tracking-[-0.01em]">
                        記録について聞く
                      </EmptyTitle>
                      <EmptyDescription className="text-pretty leading-loose">
                        記録（判断・会話・文書・PR）だけで答えます。記録に無いことは「無い」と答え、答えには根拠が付きます。
                        この会話は保存しません。
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
                      <Message align="end" className="pt-9">
                        <MessageAvatar aria-hidden="true" className="mb-1 size-8 border bg-card">
                          <UserRoundIcon className="size-4" />
                        </MessageAvatar>
                        <MessageContent>
                          <Bubble align="end" variant="secondary">
                            <BubbleContent className="whitespace-pre-wrap rounded-br-[2px] border-border px-4 py-2.5 text-base leading-[1.9]">
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
                      <Message className="pt-4">
                        <MessageAvatar
                          aria-hidden="true"
                          className="mt-1 size-8 self-start border bg-card group-has-data-[slot=message-footer]/message:translate-y-0"
                        >
                          <BotIcon className="size-4" />
                        </MessageAvatar>
                        <MessageContent className="gap-5">
                          {turn.content && <Answer text={turn.content} />}
                          {!turn.content && !turn.error && !turn.stopped && chat.busy && (
                            <p className="flex items-center gap-2 text-muted-foreground text-base">
                              <Spinner /> 記録を探しています
                            </p>
                          )}
                          {turn.stopped && (
                            <p className="text-muted-foreground text-base">生成を中断しました</p>
                          )}
                          {turn.error && <p className="text-dont text-base">{turn.error}</p>}
                          {turn.sources && (
                            <Sources
                              sources={turn.sources}
                              busy={chat.busy && !turn.content && !turn.stopped}
                            />
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
            <MessageScrollerButton />
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
                      className={`ml-auto ${chat.recorder ? "bg-dont text-white hover:bg-dont/90" : ""}`}
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
                        variant="destructive"
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
