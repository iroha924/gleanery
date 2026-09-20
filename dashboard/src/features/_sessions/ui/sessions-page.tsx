import { skipToken, useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import {
  ArrowLeftIcon,
  BotIcon,
  CalendarIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  ClipboardListIcon,
  CopyIcon,
  DraftingCompassIcon,
  FileTextIcon,
  GitBranchIcon,
  HashIcon,
  ListChecksIcon,
  MessagesSquareIcon,
  RouteIcon,
  ScaleIcon,
  SearchIcon,
  ShieldAlertIcon,
  UserRoundIcon,
} from "lucide-react-motion";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MarkdownText } from "@/components/answer";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageAvatar, MessageContent } from "@/components/ui/message";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useProject } from "@/lib/project";
import { stanceClass } from "@/lib/stance";
import {
  type FoundSession,
  loadSession,
  loadSessions,
  type SearchMode,
  type SessionArtifact,
  type SessionKnowledge,
  type SessionMessage,
  type SessionRow,
  type SessionWork,
  searchSessions,
} from "../api/sessions";

// route と component は別 file なので、循環 import を避けて route api から引く。
const route = getRouteApi("/sessions");

const DATE = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const formatDate = (value: string | null): string => (value ? DATE.format(new Date(value)) : "不明");

const SEARCH_MODES: [SearchMode, string][] = [
  ["knowledge", "判断"],
  ["avoid", "やらないこと"],
  ["said", "自分の発言"],
];
const isMode = (v: string | null): v is SearchMode => SEARCH_MODES.some(([m]) => m === v);

const hostLabel = (host: string): string =>
  host === "claude-code" ? "Claude Code" : host === "codex" ? "Codex" : host;

const resumeCommand = (host: string, sessionId: string): string | null => {
  if (host === "claude-code") return `claude --resume ${sessionId}`;
  if (host === "codex") return `codex resume ${sessionId}`;
  return null;
};

const WORK_STATUS: Record<
  string,
  { label: string; variant: "info" | "warning" | "success" | "secondary" | "outline" }
> = {
  active: { label: "進行中", variant: "info" },
  blocked: { label: "止まっている", variant: "warning" },
  paused: { label: "中断中", variant: "secondary" },
  done: { label: "完了", variant: "success" },
  abandoned: { label: "取りやめ", variant: "outline" },
};

// ---- 判断（trace で残したもの）----

const SECTION_TONES = {
  green: {
    card: "border-do/25 bg-do/8 hover:border-do/45 hover:bg-do/12",
    icon: "bg-do/15 text-do",
    text: "text-do",
    panel: "border-do/25 bg-do/5",
  },
  ochre: {
    card: "border-earth-ochre/30 bg-earth-ochre/8 hover:border-earth-ochre/50 hover:bg-earth-ochre/12",
    icon: "bg-earth-ochre/15 text-earth-ochre",
    text: "text-earth-ochre",
    panel: "border-earth-ochre/25 bg-earth-ochre/5",
  },
  red: {
    card: "border-dont/25 bg-dont/8 hover:border-dont/45 hover:bg-dont/12",
    icon: "bg-dont/15 text-dont",
    text: "text-dont",
    panel: "border-dont/25 bg-dont/5",
  },
  slate: {
    card: "border-earth-slate/30 bg-earth-slate/8 hover:border-earth-slate/50 hover:bg-earth-slate/12",
    icon: "bg-earth-slate/15 text-earth-slate",
    text: "text-earth-slate",
    panel: "border-earth-slate/25 bg-earth-slate/5",
  },
  brown: {
    card: "border-chart-5/30 bg-chart-5/8 hover:border-chart-5/50 hover:bg-chart-5/12",
    icon: "bg-chart-5/15 text-chart-5",
    text: "text-chart-5",
    panel: "border-chart-5/25 bg-chart-5/5",
  },
} as const;

const SECTION_DEFINITIONS = [
  {
    id: "decision",
    kinds: ["decision"],
    title: "決めたこと",
    description: "採用した方針と、捨てた案",
    icon: ScaleIcon,
    tone: "green",
  },
  {
    id: "boundary",
    kinds: ["constraint", "non_goal", "debt"],
    title: "守るルール",
    description: "制約、やらないこと、意図して残した負債",
    icon: ShieldAlertIcon,
    tone: "red",
  },
  {
    id: "event",
    kinds: ["finding", "dead_end"],
    title: "分かったこと",
    description: "発見と、試して駄目だった道",
    icon: RouteIcon,
    tone: "ochre",
  },
  {
    id: "verification",
    kinds: ["verification"],
    title: "確かめたこと",
    description: "検証と結果",
    icon: CircleCheckIcon,
    tone: "slate",
  },
  {
    id: "question",
    kinds: ["question"],
    title: "問い",
    description: "答えの出ていない問い",
    icon: ListChecksIcon,
    tone: "brown",
  },
] as const;

type Section = (typeof SECTION_DEFINITIONS)[number] & { items: SessionKnowledge[] };

function sectionsOf(knowledge: SessionKnowledge[]): Section[] {
  return SECTION_DEFINITIONS.flatMap((section) => {
    const items = knowledge.filter((k) => (section.kinds as readonly string[]).includes(k.kind));
    return items.length > 0 ? [{ ...section, items }] : [];
  });
}

function KnowledgeDetails({
  item,
  options,
  tone,
}: {
  item: SessionKnowledge;
  options: SessionKnowledge[];
  tone: Section["tone"];
}) {
  const related = options.filter((option) => option.decisionId === item.id);
  return (
    <article className={cn("space-y-3 rounded-md border p-4", SECTION_TONES[tone].panel)}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className={stanceClass(item.stance)}>{item.label}</span>
        <time className="text-muted-foreground tabular-nums">{formatDate(item.at)}</time>
      </div>
      <MarkdownText text={item.body} className="text-base leading-7" />
      {item.reason && (
        <div className="rounded-md border bg-card p-3">
          <p className="mb-1 text-sm font-medium text-muted-foreground">
            {item.kind === "decision"
              ? "なぜ要ったか"
              : item.kind === "verification"
                ? "実行しなかった理由"
                : "理由"}
          </p>
          <MarkdownText text={item.reason} className="text-sm leading-6" />
        </div>
      )}
      {item.confirmation && (
        <div>
          <p className="text-sm font-medium text-muted-foreground">確かめ方</p>
          <MarkdownText text={item.confirmation} className="mt-1 text-sm leading-6" />
        </div>
      )}
      {item.downsides.length > 0 && (
        <ul className="space-y-1.5 border-t pt-3">
          {item.downsides.map((text) => (
            <li key={text} className="grid grid-cols-[7rem_1fr] gap-2 text-sm leading-6">
              <span className="text-dont">引き受けた不利</span>
              <MarkdownText text={text} className="text-sm leading-6" />
            </li>
          ))}
        </ul>
      )}
      {related.length > 0 && (
        <div className="space-y-2 border-t pt-3">
          <p className="text-sm font-medium text-muted-foreground">検討した案</p>
          <ul className="space-y-1.5">
            {related.map((option) => (
              <li key={option.id} className="text-sm leading-6">
                <span className={stanceClass(option.stance)}>{option.label}</span> {option.body}
                {option.reason && <span className="text-muted-foreground"> — {option.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function SectionDialog({
  section,
  options,
  onClose,
}: {
  section: Section | null;
  options: SessionKnowledge[];
  onClose: () => void;
}) {
  return (
    <Dialog open={section !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid max-h-[82vh] grid-rows-[auto_minmax(0,1fr)] gap-4 overflow-hidden p-6 sm:max-w-[48rem] [&>*]:min-w-0">
        {section && (
          <>
            <DialogHeader className="pr-8">
              <div className={cn("flex items-center gap-2", SECTION_TONES[section.tone].text)}>
                <span
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md",
                    SECTION_TONES[section.tone].icon,
                  )}
                >
                  <section.icon className="size-4" />
                </span>
                <span className="text-sm tabular-nums">{section.items.length}件</span>
              </div>
              <DialogTitle className={cn("text-left", SECTION_TONES[section.tone].text)}>
                {section.title}
              </DialogTitle>
              <DialogDescription className="text-left">{section.description}</DialogDescription>
            </DialogHeader>
            <ScrollArea className="min-h-0 pr-4">
              <div className="space-y-3">
                {section.items.map((item) => (
                  <KnowledgeDetails key={item.id} item={item} options={options} tone={section.tone} />
                ))}
              </div>
            </ScrollArea>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SectionCard({ section, onOpen }: { section: Section; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-motion-icon-group=""
      className={cn(
        "group flex min-h-40 flex-col rounded-md border p-4 text-left transition-colors",
        SECTION_TONES[section.tone].card,
      )}
      onClick={onOpen}
    >
      <span className="flex items-start justify-between gap-4">
        <span
          className={cn(
            "flex size-8 items-center justify-center rounded-md",
            SECTION_TONES[section.tone].icon,
          )}
        >
          <section.icon className="size-4" />
        </span>
        <span className={cn("flex items-center gap-1 text-sm", SECTION_TONES[section.tone].text)}>
          {section.items.length}件
          <ChevronRightIcon className="size-4" />
        </span>
      </span>
      <span className={cn("mt-3 font-medium", SECTION_TONES[section.tone].text)}>{section.title}</span>
      <span className="mt-1 text-sm text-muted-foreground">{section.description}</span>
      <span className="mt-auto line-clamp-2 pt-4 text-sm leading-6 text-muted-foreground">
        {section.items[0]?.body}
      </span>
    </button>
  );
}

// ---- 作業の現在地 ----

function WorkCard({ work }: { work: SessionWork }) {
  const status = WORK_STATUS[work.status] ?? { label: work.status, variant: "secondary" as const };
  return (
    <section className="space-y-3 rounded-md border border-do/25 bg-do/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{work.title}</h3>
        <span className="flex items-center gap-2">
          <Badge variant={status.variant}>{status.label}</Badge>
          <time className="text-sm text-muted-foreground tabular-nums">
            {formatDate(work.updatedAt)} 更新
          </time>
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <p className="text-sm font-medium text-muted-foreground">目指すところ</p>
          <MarkdownText text={work.goal} className="mt-1 text-sm leading-6" />
        </div>
        <div>
          <p className="text-sm font-medium text-muted-foreground">いまの状況</p>
          <MarkdownText text={work.current} className="mt-1 text-sm leading-6" />
        </div>
      </div>
      {work.next.length > 0 && (
        <div className="border-t pt-3">
          <p className="text-sm font-medium text-muted-foreground">次にやること</p>
          <ul className="mt-1 space-y-1">
            {work.next.map((n) => (
              <li key={n} className="text-sm leading-6">
                {n.startsWith("人:") ? (
                  <>
                    <Badge variant="warning" className="mr-1.5">
                      人
                    </Badge>
                    {n.slice(2).trim()}
                  </>
                ) : (
                  n
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ---- 会話（自動記録）----

const FILE_ACTION = { edit: "編集", read: "読んだ", review: "指摘" } as const;

function Turn({ message }: { message: SessionMessage }) {
  const mine = message.speaker === "self";
  // AI の応答は長い。読むのは自分の発言が主なので、応答は畳んでおき、開けば全文を出す。
  const [open, setOpen] = useState(mine);
  const long = !mine && message.body.split("\n").length > 50;
  return (
    <li>
      <Message align={mine ? "end" : "start"}>
        <MessageAvatar
          className={cn(
            "size-7 min-w-0 translate-y-[5px] self-start rounded-full border",
            mine ? "bg-card" : "bg-secondary/60 text-muted-foreground",
          )}
          aria-hidden="true"
        >
          {mine ? <UserRoundIcon className="size-3.5" /> : <BotIcon className="size-3.5" />}
        </MessageAvatar>
        {/* 誰の発言かは左右とアイコンだけで示している。読み上げには位置も色も届かない。 */}
        <span className="sr-only">{mine ? "あなた" : "AI"}</span>
        <MessageContent>
          <Bubble
            variant={mine ? "outline" : "muted"}
            className="has-[button:hover]:*:data-[slot=bubble-content]:inset-ring-2 has-[button:hover]:*:data-[slot=bubble-content]:inset-ring-foreground/25"
          >
            <BubbleContent
              className={cn(
                "p-3",
                long && !open && "max-h-40 [mask-image:linear-gradient(to_bottom,black_70%,transparent)]",
              )}
            >
              <MarkdownText text={message.body} className="text-sm leading-6" />
            </BubbleContent>
            {long && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => setOpen(!open)}
              >
                {open ? "折りたたむ" : "全文を読む"}
              </Button>
            )}
          </Bubble>
          {message.truncated && (
            <p className="text-xs text-muted-foreground">
              大きすぎる発言なので冒頭と末尾だけを保存した（元は{" "}
              {message.originalBytes.toLocaleString("ja-JP")} bytes）
            </p>
          )}
          {message.files.length > 0 && (
            <ul className="flex flex-wrap gap-1.5 group-data-[align=end]/message:justify-end">
              {message.files.map((f) => (
                <li key={`${f.action}:${f.path}`}>
                  <Badge variant="outline" className="font-mono text-xs">
                    <FileTextIcon className="size-3" />
                    {FILE_ACTION[f.action]} {f.path}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </MessageContent>
      </Message>
    </li>
  );
}

// ---- 成果物 ----

const ARTIFACT_KINDS = {
  requirements: { label: "要件定義", icon: ClipboardListIcon, badge: "info" },
  design: { label: "設計書", icon: DraftingCompassIcon, badge: "secondary" },
} as const;

function ArtifactCard({ artifact, onOpen }: { artifact: SessionArtifact; onOpen: () => void }) {
  const kind = ARTIFACT_KINDS[artifact.kind];
  return (
    <button
      type="button"
      data-motion-icon-group=""
      className="group flex min-w-0 flex-col gap-2 rounded-md border bg-card p-4 text-left transition-colors hover:bg-muted/50"
      onClick={onOpen}
    >
      <span className="flex items-center justify-between gap-3">
        <Badge variant={kind.badge}>
          <kind.icon className="size-3.5" />
          {kind.label}
        </Badge>
        <ChevronRightIcon className="size-4 text-muted-foreground" />
      </span>
      <span className="font-medium leading-snug">{artifact.title}</span>
      <span className="font-mono text-xs break-all text-muted-foreground">{artifact.path}</span>
      <span className="text-xs text-muted-foreground tabular-nums">
        取り込み {formatDate(artifact.syncedAt)}
      </span>
    </button>
  );
}

function ArtifactDialog({ artifact, onClose }: { artifact: SessionArtifact | null; onClose: () => void }) {
  return (
    <Dialog open={artifact !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid max-h-[82vh] grid-rows-[auto_minmax(0,1fr)] gap-4 overflow-hidden p-6 sm:max-w-[48rem] [&>*]:min-w-0">
        {artifact && (
          <>
            <DialogHeader className="pr-8">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={ARTIFACT_KINDS[artifact.kind].badge}>
                  {ARTIFACT_KINDS[artifact.kind].label}
                </Badge>
                <span className="text-sm text-muted-foreground tabular-nums">
                  取り込み {formatDate(artifact.syncedAt)}
                </span>
              </div>
              <DialogTitle className="text-left">{artifact.title}</DialogTitle>
              <DialogDescription className="text-left font-mono text-xs break-all">
                {artifact.path}
              </DialogDescription>
            </DialogHeader>
            <ScrollArea className="min-h-0 pr-4">
              <MarkdownText text={artifact.content} className="text-sm leading-6" />
            </ScrollArea>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- 詳細 ----

function ResumeCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 flex max-w-full items-center rounded-md border bg-card">
      <code className="min-w-0 flex-1 overflow-x-auto px-3 py-2 font-mono text-sm text-foreground">
        {command}
      </code>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="mr-1 shrink-0"
              aria-label="再開コマンドをコピー"
              onClick={() => {
                navigator.clipboard
                  .writeText(command)
                  .then(() => setCopied(true))
                  .catch(() => toast.error("再開コマンドをコピーできなかった"));
              }}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{copied ? "コピーしました" : "再開コマンドをコピー"}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

function SessionDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [selectedSection, setSelectedSection] = useState<Section | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<SessionArtifact | null>(null);
  // 閉じる経路（ボタン・Esc・ブラウザの戻る）はどれも id を変える。session が変わったら、開いていた節と成果物を閉じる。
  const [shownId, setShownId] = useState(id);
  if (shownId !== id) {
    setShownId(id);
    setSelectedSection(null);
    setSelectedArtifact(null);
  }
  const detail = useQuery({
    queryKey: ["session", id],
    queryFn: id === null ? skipToken : () => loadSession(id),
  });
  const d = detail.data;
  const decisions = d?.knowledge.filter((k) => k.kind !== "option") ?? [];
  const lastAt = d?.messages.at(-1)?.sentAt ?? null;
  const said = d?.messages.filter((m) => m.speaker === "self").length ?? 0;
  const resume = d ? resumeCommand(d.origin, d.sessionId) : null;

  return (
    <Dialog open={id !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid max-h-[88vh] grid-rows-[auto_minmax(0,1fr)] gap-5 overflow-hidden p-6 sm:max-w-[min(calc(100%-2rem),max(58rem,60vw))] [&>*]:min-w-0">
        <DialogHeader className="pr-8">
          <Button type="button" variant="ghost" size="sm" className="-ml-2 w-fit" onClick={onClose}>
            <ArrowLeftIcon />
            一覧へ戻る
          </Button>
          {d ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="info">{hostLabel(d.origin)}</Badge>
                <span className="text-sm text-muted-foreground">{d.project}</span>
              </div>
              <DialogTitle className="line-clamp-2 text-left text-lg leading-snug">
                {d.title?.split("\n")[0] ?? "（題なし）"}
              </DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-2 text-left">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {d.branch && (
                      <Badge variant="outline" className="font-mono">
                        <GitBranchIcon />
                        {d.branch}
                      </Badge>
                    )}
                    <Badge variant="info">
                      <MessagesSquareIcon />
                      あなたの発言 {said}
                    </Badge>
                    <Badge variant="secondary">
                      <ScaleIcon />
                      判断 {decisions.length}
                    </Badge>
                  </div>
                  <Marker>
                    <MarkerIcon>
                      <CalendarIcon />
                    </MarkerIcon>
                    <MarkerContent className="text-sm">
                      {formatDate(d.startedAt)}
                      {lastAt && ` 〜 ${formatDate(lastAt)}`}
                    </MarkerContent>
                  </Marker>
                  <Marker>
                    <MarkerIcon>
                      <HashIcon />
                    </MarkerIcon>
                    <MarkerContent className="font-mono text-sm">{d.sessionId}</MarkerContent>
                  </Marker>
                </div>
              </DialogDescription>
              {resume && <ResumeCommand command={resume} />}
            </>
          ) : (
            <>
              <DialogTitle>セッション詳細</DialogTitle>
              <DialogDescription>選んだ session の会話と、残した判断を出す。</DialogDescription>
            </>
          )}
        </DialogHeader>

        {detail.isPending ? (
          <Skeleton className="h-80 w-full" />
        ) : detail.isError ? (
          <Failed what="このセッション" error={detail.error} />
        ) : d ? (
          <Tabs
            defaultValue={decisions.length > 0 ? "knowledge" : "conversation"}
            className="flex min-h-0 flex-col gap-3"
          >
            {d.work.length > 0 && (
              <div className="space-y-3">
                {d.work.map((w) => (
                  <WorkCard key={w.id} work={w} />
                ))}
              </div>
            )}
            <TabsList>
              <TabsTrigger value="conversation">会話 {d.messages.length}</TabsTrigger>
              <TabsTrigger value="knowledge">判断 {decisions.length}</TabsTrigger>
              {d.artifacts.length > 0 && (
                <TabsTrigger value="artifacts">成果物 {d.artifacts.length}</TabsTrigger>
              )}
            </TabsList>
            <ScrollArea className="min-h-0 flex-1 pr-4">
              <TabsContent value="conversation" className="pt-3">
                {d.messages.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    この session の会話は記録されていない（trace だけで残した session）。
                  </p>
                ) : (
                  <ol className="space-y-4">
                    {d.messages.map((m) => (
                      <Turn key={m.id} message={m} />
                    ))}
                  </ol>
                )}
              </TabsContent>
              <TabsContent value="knowledge" className="pt-3">
                {decisions.length === 0 ? (
                  <p className="text-sm leading-6 text-muted-foreground">
                    この session では判断を残していない。残すなら、その session で{" "}
                    <code className="font-mono">/gleanery:trace</code> を実行する。
                  </p>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    {sectionsOf(d.knowledge).map((section) => (
                      <SectionCard
                        key={section.id}
                        section={section}
                        onOpen={() => setSelectedSection(section)}
                      />
                    ))}
                  </div>
                )}
              </TabsContent>
              {d.artifacts.length > 0 && (
                <TabsContent value="artifacts" className="space-y-3 pt-3">
                  <p className="text-sm text-muted-foreground">
                    この session が触れた要件定義と設計書。承認済みとして同期された本文を表示する。
                  </p>
                  <div className="grid gap-3 md:grid-cols-2">
                    {d.artifacts.map((artifact) => (
                      <ArtifactCard
                        key={artifact.path}
                        artifact={artifact}
                        onOpen={() => setSelectedArtifact(artifact)}
                      />
                    ))}
                  </div>
                </TabsContent>
              )}
            </ScrollArea>
          </Tabs>
        ) : null}

        <SectionDialog
          section={selectedSection}
          options={d?.knowledge.filter((k) => k.kind === "option") ?? []}
          onClose={() => setSelectedSection(null)}
        />
        <ArtifactDialog artifact={selectedArtifact} onClose={() => setSelectedArtifact(null)} />
      </DialogContent>
    </Dialog>
  );
}

// ---- 一覧と検索 ----

function SearchToolbar({
  query,
  mode,
  onSearch,
  onModeChange,
  onClear,
}: {
  query: string | undefined;
  mode: SearchMode;
  onSearch: (query: string) => void;
  onModeChange: (mode: SearchMode) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState(query ?? "");
  useEffect(() => setDraft(query ?? ""), [query]);

  return (
    <section className="flex shrink-0 flex-col gap-2 rounded-md border bg-card p-2 sm:flex-row sm:items-center">
      <form
        className="flex min-w-0 flex-1 items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim()) onSearch(draft.trim());
        }}
      >
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={
              mode === "said"
                ? "自分が何と言ったかで探す"
                : mode === "avoid"
                  ? "やらないと決めたことで探す"
                  : "判断や経緯で探す"
            }
            aria-label="セッションを検索"
            className="h-10 bg-background pr-3 pl-9"
          />
        </div>
        {query && (
          <Button type="button" variant="ghost" onClick={onClear}>
            クリア
          </Button>
        )}
        <Button type="submit" disabled={!draft.trim()}>
          検索
        </Button>
      </form>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={mode}
        onValueChange={(value) => isMode(value) && onModeChange(value)}
        aria-label="何で探すか"
      >
        {SEARCH_MODES.map(([value, label]) => (
          <ToggleGroupItem key={value} value={value}>
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </section>
  );
}

function SearchResults({ found, onOpen }: { found: FoundSession[]; onOpen: (id: string) => void }) {
  if (found.length === 0) {
    return (
      <Empty className="min-h-64 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="size-10 bg-muted text-muted-foreground">
            <SearchIcon className="size-5" />
          </EmptyMedia>
          <EmptyTitle>該当するセッションはありません</EmptyTitle>
          <EmptyDescription>
            言葉を変えるか、探し方（判断・やらないこと・自分の発言）を切り替えてください。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const hits = found.reduce((n, s) => n + s.hits.length, 0);
  return (
    <div className="min-h-0 overflow-y-auto">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 className="font-medium">検索結果</h2>
        <p className="text-sm text-muted-foreground">
          {found.length} セッション・{hits} 件
        </p>
      </div>
      <div className="space-y-3">
        {found.map((session) => (
          <button
            key={session.id}
            type="button"
            data-motion-icon-group=""
            className="group w-full rounded-md border bg-card p-4 text-left transition-colors hover:border-foreground/25 hover:bg-muted/30"
            onClick={() => onOpen(session.id)}
          >
            <span className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block truncate font-medium">{session.title ?? "（題なし）"}</span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  {hostLabel(session.origin)} ・ {session.project} ・ {session.sessionId.slice(0, 8)}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
                {session.hits.length}件
                <ChevronRightIcon className="size-4" />
              </span>
            </span>
            <span className="mt-4 block space-y-3 border-t pt-3">
              {session.hits.slice(0, 3).map((hit) => (
                <span key={hit.ref} className="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3">
                  <span className={cn("text-sm", stanceClass(hit.stance))}>{hit.label}</span>
                  <span className="min-w-0">
                    <span className="line-clamp-2 block text-sm leading-6">{hit.text}</span>
                    {hit.reason && (
                      <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">
                        {hit.reason}
                      </span>
                    )}
                  </span>
                </span>
              ))}
              {session.hits.length > 3 && (
                <span className="block text-sm text-muted-foreground">ほか {session.hits.length - 3} 件</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SessionRowView({
  session,
  showProject,
  onOpen,
}: {
  session: SessionRow;
  showProject: boolean;
  onOpen: (id: string) => void;
}) {
  const open = () => onOpen(session.id);
  const title = session.title?.split("\n")[0] ?? "（題なし）";
  return (
    <TableRow
      id={`session-row-${session.id}`}
      data-motion-icon-group=""
      tabIndex={0}
      aria-label={`${title}の詳細を開く`}
      className="cursor-pointer focus-visible:bg-muted focus-visible:outline-none"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
    >
      <TableCell className="w-[11rem] pl-4 text-sm text-muted-foreground tabular-nums">
        {formatDate(session.lastAt ?? session.startedAt)}
      </TableCell>
      <TableCell className="max-w-[34rem] whitespace-normal py-4">
        <span className="line-clamp-2 font-medium">{title}</span>
        <span className="mt-1 block font-mono text-xs text-muted-foreground" title={session.sessionId}>
          {session.sessionId.slice(0, 8)}
        </span>
      </TableCell>
      <TableCell>
        <Badge variant="info">{hostLabel(session.origin)}</Badge>
      </TableCell>
      {showProject && <TableCell>{session.project}</TableCell>}
      <TableCell className="text-muted-foreground">
        {session.branch ? (
          <span className="inline-flex items-center gap-1">
            <GitBranchIcon className="size-3" />
            {session.branch}
          </span>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">{session.said}</TableCell>
      <TableCell className="pr-4 text-right tabular-nums">
        {session.traced > 0 ? (
          <Badge variant="success">{session.traced}</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * 引けなかったことを利用者へ伝える。**例外の文字列をそのまま出さない** —
 * `Error: /api/sessions が 500` は読み手が何もできない文である。
 */
function Failed({ what, error }: { what: string; error: unknown }) {
  const detail = error instanceof Error ? error.message : null;
  return (
    <p role="alert" className="text-base text-error leading-[1.9]">
      {what}を読めませんでした。
      {detail && <span className="text-muted-foreground text-sm"> （{detail}）</span>}
    </p>
  );
}

export function SessionsPage() {
  const { target } = useProject();
  const projectId = target ? Number(target) : undefined;
  const router = useRouter();
  const navigate = route.useNavigate();
  const { mode, page, q, session } = route.useSearch();
  const selected = session ?? null;
  const query = q?.trim() || undefined;
  const scopeKey = projectId ?? "all";
  const previousScope = useRef(scopeKey);
  const restoreRow = useRef<string | null>(null);
  const openSession = (id: string) => {
    restoreRow.current = id;
    navigate({ search: (prev) => ({ ...prev, session: id }), resetScroll: false });
  };
  const closeSession = () => {
    // 自分で開いた行なら戻る。直接 URL で開かれたときは戻り先が別の画面なので置き換える。
    if (restoreRow.current === selected) router.history.back();
    else navigate({ search: (prev) => ({ ...prev, session: undefined }), replace: true, resetScroll: false });
  };
  const goToPage = (next: number) => {
    restoreRow.current = null;
    navigate({ search: (prev) => ({ ...prev, page: next, session: undefined }), resetScroll: false });
  };
  const sessions = useQuery({
    queryKey: ["sessions", projectId, page],
    queryFn: () => loadSessions(page, projectId),
  });
  const results = useQuery({
    queryKey: ["session-search", query, mode, projectId],
    queryFn: query === undefined ? skipToken : () => searchSessions(query, mode, projectId),
    staleTime: 60_000,
  });
  // 検索の条件が変われば 1 ページ目に戻し、開いていた詳細は閉じる。
  const updateSearch = (next: { q?: string | undefined; mode?: SearchMode }) => {
    navigate({
      search: (prev) => ({ ...prev, ...next, page: 1, session: undefined }),
      resetScroll: false,
    });
  };

  useEffect(() => {
    if (previousScope.current === scopeKey) return;
    previousScope.current = scopeKey;
    restoreRow.current = null;
    // 4 つとも明示して消す。省くと retainSearchParams が前の作業場所の絞り込みを書き戻す。
    navigate({
      search: { q: undefined, mode: "knowledge", page: 1, session: undefined },
      replace: true,
      resetScroll: false,
    });
  }, [navigate, scopeKey]);

  useEffect(() => {
    const id = restoreRow.current;
    if (selected !== null || id === null || !sessions.data?.items.some((item) => item.id === id)) return;
    restoreRow.current = null;
    requestAnimationFrame(() => {
      const row = document.getElementById(`session-row-${id}`);
      row?.scrollIntoView({ block: "center" });
      row?.focus({ preventScroll: true });
    });
  }, [selected, sessions.data]);

  if (sessions.isPending) return <Skeleton className="h-96 w-full" />;
  if (sessions.isError) return <Failed what="セッションの一覧" error={sessions.error} />;
  const showProject = projectId === undefined;

  return (
    <div className="mx-auto flex h-full w-full max-w-[84rem] flex-col gap-4">
      <SearchToolbar
        query={query}
        mode={mode}
        onSearch={(value) => updateSearch({ q: value })}
        onModeChange={(value) => updateSearch({ mode: value })}
        onClear={() => updateSearch({ q: undefined, mode: "knowledge" })}
      />

      {query ? (
        results.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : results.isError ? (
          <Failed what="検索の結果" error={results.error} />
        ) : (
          <SearchResults found={results.data} onOpen={openSession} />
        )
      ) : sessions.data.items.length === 0 && sessions.data.total > 0 ? (
        <Empty className="min-h-80 border-0">
          <EmptyHeader>
            <EmptyTitle>{sessions.data.page} ページ目はありません</EmptyTitle>
            <EmptyDescription>セッションは全 {sessions.data.pages} ページです。</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" variant="outline" size="sm" onClick={() => goToPage(sessions.data.pages)}>
              最後のページへ
            </Button>
          </EmptyContent>
        </Empty>
      ) : sessions.data.items.length === 0 ? (
        <Empty className="min-h-80 border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="size-10 bg-muted text-muted-foreground">
              <MessagesSquareIcon className="size-5" />
            </EmptyMedia>
            <EmptyTitle>セッションはまだありません</EmptyTitle>
            <EmptyDescription>
              <span className="block">登録した作業場所で Claude Code を使うと、会話が自動で残り、</span>
              <span className="block">ここに並びます。</span>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="min-h-0 overflow-y-auto rounded-md">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead className="pl-4">最後の発言</TableHead>
                <TableHead>最初の発言</TableHead>
                <TableHead>AI</TableHead>
                {showProject && <TableHead>作業場所</TableHead>}
                <TableHead>ブランチ</TableHead>
                <TableHead className="text-right">発言</TableHead>
                <TableHead className="pr-4 text-right">判断</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.data.items.map((session) => (
                <SessionRowView
                  key={session.id}
                  session={session}
                  showProject={showProject}
                  onOpen={openSession}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {!query && sessions.data.items.length > 0 && (
        <nav className="flex shrink-0 items-center justify-between gap-4" aria-label="セッション一覧のページ">
          <p className="text-sm text-muted-foreground">
            {sessions.data.total} 件中 {(sessions.data.page - 1) * sessions.data.pageSize + 1}〜
            {Math.min(sessions.data.page * sessions.data.pageSize, sessions.data.total)} 件
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => goToPage(Math.max(1, page - 1))}
            >
              <ChevronLeftIcon />
              前へ
            </Button>
            <span className="min-w-16 text-center text-sm tabular-nums text-muted-foreground">
              {sessions.data.page} / {sessions.data.pages}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= sessions.data.pages}
              onClick={() => goToPage(page + 1)}
            >
              次へ
              <ChevronRightIcon />
            </Button>
          </div>
        </nav>
      )}

      <SessionDialog id={selected} onClose={closeSession} />
    </div>
  );
}
