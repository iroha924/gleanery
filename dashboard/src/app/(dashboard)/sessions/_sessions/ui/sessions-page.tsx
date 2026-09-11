"use client";

import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CopyIcon,
  GitBranchIcon,
  ListChecksIcon,
  MessagesSquareIcon,
  RouteIcon,
  ScaleIcon,
  SearchIcon,
  ShieldAlertIcon,
  SlidersHorizontalIcon,
} from "lucide-react-motion";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { MarkdownText } from "@/components/answer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { polarityClass } from "@/lib/polarity";
import { useProject } from "@/lib/project";
import {
  loadSession,
  loadSessions,
  type SessionDetail,
  type SessionHit,
  type SessionNode,
  type SessionRow,
  searchSessions,
} from "../api/sessions";

const DATE = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const SEARCH_KINDS = [
  ["decision", "決めたこと"],
  ["option", "検討した案"],
  ["event", "作業の経緯"],
  ["boundary", "守るルール"],
  ["verification", "確かめたこと"],
  ["question", "未解決の問い"],
] as const;
const SEARCH_KIND_VALUES = new Set<string>(SEARCH_KINDS.map(([value]) => value));

const hostLabel = (host: string): string => {
  if (host === "claude-code") return "Claude Code";
  if (host === "codex") return "Codex";
  return host;
};

const formatDate = (value: string | null): string => (value ? DATE.format(new Date(value)) : "不明");

const statusLabel = (status: string): string =>
  ({ planning: "計画中", "in-progress": "進行中", blocked: "ブロック", paused: "一時停止", done: "完了" })[
    status
  ] ?? status;

const statusVariant = (status: string): "secondary" | "info" | "warning" | "success" | "destructive" => {
  if (status === "done") return "success";
  if (status === "in-progress") return "info";
  if (status === "blocked") return "destructive";
  if (status === "paused") return "warning";
  return "secondary";
};

const resumeCommand = (host: string, sessionId: string): string | null => {
  if (host === "claude-code") return `claude --resume ${sessionId}`;
  if (host === "codex") return `codex resume ${sessionId}`;
  return null;
};

type Section = {
  id: string;
  title: string;
  description: string;
  icon: typeof ScaleIcon;
  tone: keyof typeof SECTION_TONES;
  nodes: SessionNode[];
};

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
    title: "決めたこと",
    description: "採用した方針と、その理由",
    icon: ScaleIcon,
    tone: "green",
  },
  {
    id: "event",
    title: "作業の経緯",
    description: "発見、変更、行き止まり",
    icon: RouteIcon,
    tone: "ochre",
  },
  {
    id: "boundary",
    title: "守るルール",
    description: "制約と、今回やらないこと",
    icon: ShieldAlertIcon,
    tone: "red",
  },
  {
    id: "verification",
    title: "確かめたこと",
    description: "実行した検証と結果",
    icon: CircleCheckIcon,
    tone: "slate",
  },
  {
    id: "question",
    title: "未解決の問い",
    description: "次のセッションで判断すること",
    icon: ListChecksIcon,
    tone: "brown",
  },
] as const;

function sectionsOf(detail: SessionDetail): Section[] {
  return SECTION_DEFINITIONS.flatMap((section) => {
    const nodes = detail.nodes.filter((node) => node.kind === section.id);
    return nodes.length > 0 ? [{ ...section, nodes }] : [];
  });
}

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
                navigator.clipboard.writeText(command).then(() => setCopied(true));
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

function NodeDetails({
  node,
  options,
  tone,
}: {
  node: SessionNode;
  options: SessionNode[];
  tone: Section["tone"];
}) {
  const related = options.filter((option) => option.parent_id === node.id);
  return (
    <article className={cn("space-y-3 rounded-md border p-4", SECTION_TONES[tone].panel)}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className={SECTION_TONES[tone].text}>{node.label}</span>
        {node.at && <time className="text-muted-foreground tabular-nums">{formatDate(node.at)}</time>}
      </div>
      <MarkdownText text={node.text} className="text-base leading-7" />
      {node.ex && (
        <div className="rounded-md border bg-card p-3">
          <p className="mb-1 text-sm font-medium text-muted-foreground">背景</p>
          <MarkdownText text={node.ex} className="text-sm leading-6" />
        </div>
      )}
      {node.attrs.confirmation && (
        <div>
          <p className="text-sm font-medium text-muted-foreground">確かめ方</p>
          <MarkdownText text={node.attrs.confirmation} className="mt-1 text-sm leading-6" />
        </div>
      )}
      {node.attrs.consequences && node.attrs.consequences.length > 0 && (
        <ul className="space-y-2 border-t pt-3">
          {node.attrs.consequences.map((item) => (
            <li key={item.text} className="grid grid-cols-[6rem_1fr] gap-2 text-sm leading-6">
              <span className={item.good ? "text-do" : "text-dont"}>
                {item.good ? "得たもの" : "引き受けた不利"}
              </span>
              <MarkdownText text={item.text} className="text-sm leading-6" />
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
                <span className={option.polarity === "dont" ? "text-dont" : "text-do"}>
                  {option.polarity === "dont" ? "不採用" : "採用"}
                </span>{" "}
                {option.text}
                {option.attrs.whyNot && (
                  <span className="text-muted-foreground"> — {option.attrs.whyNot}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {node.attrs.cmd && (
        <pre className="max-h-56 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-5">
          <code>
            $ {node.attrs.cmd}
            {node.attrs.output ? `\n${node.attrs.output}` : ""}
          </code>
        </pre>
      )}
      {node.attrs.whyNotRun && <p className="text-sm text-dont">未実行: {node.attrs.whyNotRun}</p>}
    </article>
  );
}

function SectionDialog({
  section,
  options,
  onClose,
}: {
  section: Section | null;
  options: SessionNode[];
  onClose: () => void;
}) {
  return (
    <Dialog open={section !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid max-h-[82vh] grid-rows-[auto_minmax(0,1fr)] gap-4 overflow-hidden p-6 sm:max-w-[48rem]">
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
                <span className="text-sm tabular-nums">{section.nodes.length}件</span>
              </div>
              <DialogTitle className={cn("text-left", SECTION_TONES[section.tone].text)}>
                {section.title}
              </DialogTitle>
              <DialogDescription className="text-left">{section.description}</DialogDescription>
            </DialogHeader>
            <ScrollArea className="min-h-0 pr-4">
              <div className="space-y-3">
                {section.nodes.map((node) => (
                  <NodeDetails key={node.id} node={node} options={options} tone={section.tone} />
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
          {section.nodes.length}件
          <ChevronRightIcon className="size-4" />
        </span>
      </span>
      <span className={cn("mt-3 font-medium", SECTION_TONES[section.tone].text)}>{section.title}</span>
      <span className="mt-1 text-sm text-muted-foreground">{section.description}</span>
      <span className="mt-auto line-clamp-2 pt-4 text-sm leading-6 text-muted-foreground">
        {section.nodes[0]?.text}
      </span>
    </button>
  );
}

function SessionDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [selectedSection, setSelectedSection] = useState<Section | null>(null);
  const detail = useQuery({
    queryKey: ["session", id],
    queryFn: () => loadSession(id as string),
    enabled: id !== null,
  });
  const closeDialog = () => {
    setSelectedSection(null);
    onClose();
  };

  return (
    <Dialog open={id !== null} onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent className="grid max-h-[88vh] grid-rows-[auto_minmax(0,1fr)] gap-5 overflow-hidden p-6 sm:max-w-[58rem]">
        <DialogHeader className="pr-8">
          <Button type="button" variant="ghost" size="sm" className="-ml-2 w-fit" onClick={closeDialog}>
            <ArrowLeftIcon />
            一覧へ戻る
          </Button>
          {detail.data ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="info">{hostLabel(detail.data.host)}</Badge>
                <span className="text-sm text-muted-foreground">{detail.data.scope_label}</span>
              </div>
              <DialogTitle className="text-left text-lg leading-snug">{detail.data.title}</DialogTitle>
              <DialogDescription className="space-y-1 text-left">
                <span className="block font-mono text-sm break-all">
                  Session ID: {detail.data.session_id}
                </span>
                <span className="flex flex-wrap gap-x-4 gap-y-1">
                  <span>
                    {formatDate(detail.data.created_at)} 〜 {formatDate(detail.data.updated_at)}
                  </span>
                  {detail.data.branch && (
                    <span className="inline-flex items-center gap-1">
                      <GitBranchIcon className="size-3" />
                      {detail.data.branch}
                    </span>
                  )}
                  <span>{detail.data.exchanges} 往復</span>
                  <span>{statusLabel(detail.data.status)}</span>
                </span>
              </DialogDescription>
              {resumeCommand(detail.data.host, detail.data.session_id) && (
                <ResumeCommand command={resumeCommand(detail.data.host, detail.data.session_id) as string} />
              )}
            </>
          ) : (
            <DialogTitle>セッション詳細</DialogTitle>
          )}
        </DialogHeader>

        {detail.isPending ? (
          <Skeleton className="h-80 w-full" />
        ) : detail.error ? (
          <p className="text-base text-dont">{String(detail.error)}</p>
        ) : detail.data ? (
          <ScrollArea className="min-h-0 pr-4">
            <div className="space-y-5">
              {detail.data.current_text && (
                <section className="rounded-md border border-do/25 bg-do/5 p-4">
                  <div className="mb-2 flex items-center justify-between gap-4">
                    <h3 className="font-medium text-do">完了時点</h3>
                    {detail.data.phases.length > 0 && (
                      <span className="text-sm text-muted-foreground tabular-nums">
                        {detail.data.phases.filter((phase) => phase.state === "done").length} /{" "}
                        {detail.data.phases.length} 完了
                      </span>
                    )}
                  </div>
                  <MarkdownText text={detail.data.current_text} className="text-sm leading-6" />
                </section>
              )}

              {(detail.data.problem || detail.data.goal) && (
                <div className="grid gap-3 md:grid-cols-2">
                  {detail.data.problem && (
                    <section className="rounded-md border border-dont/25 bg-dont/5 p-4">
                      <h3 className="mb-2 text-sm font-medium text-dont">課題</h3>
                      <MarkdownText text={detail.data.problem} className="text-sm leading-6" />
                    </section>
                  )}
                  {detail.data.goal && (
                    <section className="rounded-md border border-earth-slate/25 bg-earth-slate/5 p-4">
                      <h3 className="mb-2 text-sm font-medium text-earth-slate">目標</h3>
                      <MarkdownText text={detail.data.goal} className="text-sm leading-6" />
                    </section>
                  )}
                </div>
              )}

              <section className="space-y-3">
                <div>
                  <h3 className="font-medium">セッションのナレッジ</h3>
                  <p className="mt-1 text-sm text-muted-foreground">セクションを選ぶと詳細を確認できます。</p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {sectionsOf(detail.data).map((section) => (
                    <SectionCard
                      key={section.id}
                      section={section}
                      onOpen={() => setSelectedSection(section)}
                    />
                  ))}
                </div>
              </section>
            </div>
          </ScrollArea>
        ) : null}

        <SectionDialog
          section={selectedSection}
          options={detail.data?.nodes.filter((node) => node.kind === "option") ?? []}
          onClose={() => setSelectedSection(null)}
        />
      </DialogContent>
    </Dialog>
  );
}

type SearchGroup = {
  id: string;
  title: string;
  scopeLabel: string;
  hits: SessionHit[];
};

function groupHits(hits: SessionHit[]): SearchGroup[] {
  const groups = new Map<string, SearchGroup>();
  for (const hit of hits) {
    const group = groups.get(hit.record_id);
    if (group) group.hits.push(hit);
    else {
      groups.set(hit.record_id, {
        id: hit.record_id,
        title: hit.record_title,
        scopeLabel: hit.scope_label,
        hits: [hit],
      });
    }
  }
  return [...groups.values()];
}

function SearchToolbar({
  query,
  onlyDont,
  kinds,
  onSearch,
  onKindsChange,
  onOnlyDontChange,
  onClear,
}: {
  query: string | undefined;
  onlyDont: boolean;
  kinds: string[];
  onSearch: (query: string) => void;
  onKindsChange: (kinds: string[]) => void;
  onOnlyDontChange: (value: boolean) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState(query ?? "");
  const activeFilters = kinds.length + Number(onlyDont);

  useEffect(() => setDraft(query ?? ""), [query]);

  return (
    <section className="shrink-0 overflow-hidden rounded-md border bg-card">
      <form
        className="flex items-center gap-2 p-2"
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
            placeholder="セッションの判断や経緯を検索"
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
      <details className="group border-t">
        <summary
          data-motion-icon-group=""
          className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground [&::-webkit-details-marker]:hidden"
        >
          <SlidersHorizontalIcon className="size-4" />
          詳細条件
          {activeFilters > 0 && <Badge variant="secondary">{activeFilters}</Badge>}
          <span className="ml-auto text-xs">
            {kinds.length > 0 ? `${kinds.length}種類` : "すべてのナレッジ"}
            {onlyDont ? "・やらないことのみ" : ""}
          </span>
          <ChevronRightIcon className="size-4 transition-transform group-open:rotate-90" />
        </summary>
        <div className="flex flex-wrap items-center gap-3 border-t p-3">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">種類</p>
            <ToggleGroup
              type="multiple"
              variant="outline"
              size="sm"
              value={kinds}
              onValueChange={onKindsChange}
              className="flex-wrap justify-start"
            >
              {SEARCH_KINDS.map(([value, label]) => (
                <ToggleGroupItem key={value} value={value} aria-label={label}>
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">方針</p>
            <Button
              type="button"
              variant={onlyDont ? "secondary" : "outline"}
              size="sm"
              aria-pressed={onlyDont}
              onClick={() => onOnlyDontChange(!onlyDont)}
            >
              やらないことのみ
            </Button>
          </div>
        </div>
      </details>
    </section>
  );
}

function SearchResults({ hits, onOpen }: { hits: SessionHit[]; onOpen: (id: string) => void }) {
  const groups = groupHits(hits);
  if (groups.length === 0) {
    return (
      <Empty className="min-h-64 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="size-10 bg-muted text-muted-foreground">
            <SearchIcon className="size-5" />
          </EmptyMedia>
          <EmptyTitle>該当するセッションはありません</EmptyTitle>
          <EmptyDescription>言葉を変えるか、詳細条件を減らしてみてください。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="min-h-0 overflow-y-auto">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 className="font-medium">検索結果</h2>
        <p className="text-sm text-muted-foreground">
          {groups.length} セッション・{hits.length} 件
        </p>
      </div>
      <div className="space-y-3">
        {groups.map((group) => (
          <button
            key={group.id}
            type="button"
            data-motion-icon-group=""
            className="group w-full rounded-md border bg-card p-4 text-left transition-colors hover:border-foreground/25 hover:bg-muted/30"
            onClick={() => onOpen(group.id)}
          >
            <span className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block truncate font-medium">{group.title}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{group.scopeLabel}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
                {group.hits.length}件
                <ChevronRightIcon className="size-4" />
              </span>
            </span>
            <span className="mt-4 block space-y-3 border-t pt-3">
              {group.hits.slice(0, 3).map((hit) => (
                <span key={hit.id} className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
                  <span className={`text-sm ${polarityClass(hit.polarity)}`}>{hit.label}</span>
                  <span className="min-w-0">
                    <span className="line-clamp-2 block text-sm leading-6">{hit.text}</span>
                    {hit.ex && (
                      <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">
                        {hit.ex}
                      </span>
                    )}
                  </span>
                </span>
              ))}
              {group.hits.length > 3 && (
                <span className="block text-sm text-muted-foreground">ほか {group.hits.length - 3} 件</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SessionRowView({ session, onOpen }: { session: SessionRow; onOpen: (id: string) => void }) {
  const open = () => onOpen(session.id);
  return (
    <TableRow
      id={`session-row-${session.id}`}
      data-motion-icon-group=""
      tabIndex={0}
      aria-label={`${session.title}の詳細を開く`}
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
        {formatDate(session.updated_at)}
      </TableCell>
      <TableCell className="font-mono text-sm text-muted-foreground" title={session.session_id}>
        {session.session_id.slice(0, 8)}
      </TableCell>
      <TableCell className="max-w-[34rem] whitespace-normal py-4 font-medium">{session.title}</TableCell>
      <TableCell>
        <Badge variant="info">{hostLabel(session.host)}</Badge>
      </TableCell>
      <TableCell>{session.scope_label}</TableCell>
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
      <TableCell>
        <Badge variant={statusVariant(session.status)}>{statusLabel(session.status)}</Badge>
      </TableCell>
      <TableCell className="pr-4 text-right tabular-nums">{session.exchanges}</TableCell>
    </TableRow>
  );
}

export function SessionsPage() {
  const { scopeIds } = useProject();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selected = searchParams.get("session");
  const query = searchParams.get("q")?.trim() || undefined;
  const onlyDont = searchParams.get("dont") === "1";
  const kinds = searchParams.getAll("kind").filter((kind) => SEARCH_KIND_VALUES.has(kind));
  const requestedPage = Number(searchParams.get("page") ?? "1");
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const scopeKey = scopeIds?.join(",") ?? "all";
  const previousScope = useRef(scopeKey);
  const restoreRow = useRef<string | null>(null);
  const hrefFor = (nextPage: number, session?: string): string => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("page");
    params.delete("session");
    if (nextPage > 1) params.set("page", String(nextPage));
    if (session) params.set("session", session);
    const query = params.toString();
    return query ? `/sessions?${query}` : "/sessions";
  };
  const listHref = hrefFor(page);
  const openSession = (id: string) => {
    restoreRow.current = id;
    router.push(hrefFor(page, id), { scroll: false });
  };
  const closeSession = () => {
    if (restoreRow.current === selected) router.back();
    else router.replace(listHref, { scroll: false });
  };
  const goToPage = (next: number) => {
    restoreRow.current = null;
    router.push(hrefFor(next), { scroll: false });
  };
  const sessions = useQuery({
    queryKey: ["sessions", scopeIds, page],
    queryFn: () => loadSessions(page, scopeIds),
  });
  const results = useQuery({
    queryKey: ["session-search", query, onlyDont, kinds, scopeIds],
    queryFn: () =>
      searchSessions({
        question: query as string,
        onlyDont: onlyDont || undefined,
        kinds: kinds.length > 0 ? kinds : undefined,
        scopeIds,
      }),
    enabled: query !== undefined,
    staleTime: 60_000,
  });
  const updateSearch = (next: { q?: string; onlyDont?: boolean; kinds?: string[] }) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("session");
    params.delete("page");
    if (next.q !== undefined) {
      if (next.q) params.set("q", next.q);
      else params.delete("q");
    }
    if (next.onlyDont !== undefined) {
      if (next.onlyDont) params.set("dont", "1");
      else params.delete("dont");
    }
    if (next.kinds !== undefined) {
      params.delete("kind");
      for (const kind of next.kinds) params.append("kind", kind);
    }
    const nextQuery = params.toString();
    window.history.pushState(null, "", nextQuery ? `/sessions?${nextQuery}` : "/sessions");
  };

  useEffect(() => {
    if (previousScope.current === scopeKey) return;
    previousScope.current = scopeKey;
    restoreRow.current = null;
    router.replace("/sessions", { scroll: false });
  }, [router, scopeKey]);

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
  if (sessions.error) return <p className="text-base text-dont">{String(sessions.error)}</p>;

  return (
    <div className="mx-auto flex h-full w-full max-w-[84rem] flex-col gap-4">
      <SearchToolbar
        query={query}
        onlyDont={onlyDont}
        kinds={kinds}
        onSearch={(value) => updateSearch({ q: value })}
        onKindsChange={(value) => updateSearch({ kinds: value })}
        onOnlyDontChange={(value) => updateSearch({ onlyDont: value })}
        onClear={() => updateSearch({ q: "", onlyDont: false, kinds: [] })}
      />

      {query ? (
        results.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : results.error ? (
          <p className="text-base text-dont">{String(results.error)}</p>
        ) : (
          <SearchResults hits={results.data} onOpen={openSession} />
        )
      ) : sessions.data.items.length === 0 ? (
        <Empty className="min-h-80 border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="size-10 bg-muted text-muted-foreground">
              <MessagesSquareIcon className="size-5" />
            </EmptyMedia>
            <EmptyTitle>セッションはまだありません</EmptyTitle>
            <EmptyDescription>
              <span className="block whitespace-nowrap">残したいセッションで trace を実行すると、</span>
              <span className="block">ここに表示されます。</span>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="min-h-0 overflow-y-auto rounded-md">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead className="pl-4">最終記録</TableHead>
                <TableHead>Session ID</TableHead>
                <TableHead>セッション</TableHead>
                <TableHead>AI</TableHead>
                <TableHead>プロジェクト</TableHead>
                <TableHead>ブランチ</TableHead>
                <TableHead>状態</TableHead>
                <TableHead className="pr-4 text-right">往復</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.data.items.map((session) => (
                <SessionRowView key={session.id} session={session} onOpen={openSession} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {!query && sessions.data.total > 0 && (
        <nav className="flex shrink-0 items-center justify-between gap-4" aria-label="セッション一覧のページ">
          <p className="text-sm text-muted-foreground">
            {sessions.data.total} 件中 {(sessions.data.page - 1) * sessions.data.page_size + 1}〜
            {Math.min(sessions.data.page * sessions.data.page_size, sessions.data.total)} 件
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
