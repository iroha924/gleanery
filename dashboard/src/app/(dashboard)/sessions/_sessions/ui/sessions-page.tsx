"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  BotIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GitBranchIcon,
  MessagesSquareIcon,
} from "lucide-react-motion";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { MarkdownText } from "@/components/answer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useProject } from "@/lib/project";
import { loadSession, loadSessions, type SessionRow } from "../api/sessions";

const DATE = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

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

function SessionDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ["session", id],
    queryFn: () => loadSession(id as string),
    enabled: id !== null,
  });

  return (
    <Dialog open={id !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid max-h-[88vh] grid-rows-[auto_minmax(0,1fr)] gap-5 overflow-hidden p-6 sm:max-w-[52rem]">
        <DialogHeader className="pr-8">
          <Button type="button" variant="ghost" size="sm" className="-ml-2 w-fit" onClick={onClose}>
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
                {resumeCommand(detail.data.host, detail.data.session_id) && (
                  <code className="mt-2 block w-fit max-w-full overflow-x-auto rounded-md bg-muted px-2 py-1 font-mono text-sm text-foreground">
                    {resumeCommand(detail.data.host, detail.data.session_id)}
                  </code>
                )}
              </DialogDescription>
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
            <ol className="space-y-4">
              {detail.data.entries.map((entry) => (
                <li key={entry.id} className="rounded-md border bg-card p-4">
                  <div className="mb-2 flex items-center justify-between gap-4 text-sm text-muted-foreground">
                    <span>{entry.role === "human" ? "あなた" : hostLabel(detail.data.host)}</span>
                    <span className="tabular-nums">{formatDate(entry.at)}</span>
                  </div>
                  <MarkdownText text={entry.text} className="text-base leading-7" />
                </li>
              ))}
            </ol>
          </ScrollArea>
        ) : null}
      </DialogContent>
    </Dialog>
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
  const requestedPage = Number(searchParams.get("page") ?? "1");
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const scopeKey = scopeIds?.join(",") ?? "all";
  const previousScope = useRef(scopeKey);
  const restoreRow = useRef<string | null>(null);
  const hrefFor = (nextPage: number, session?: string): string => {
    const params = new URLSearchParams();
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
      {sessions.data.items.length === 0 ? (
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
                <TableHead>
                  <span className="inline-flex items-center gap-1.5">
                    <BotIcon className="size-3.5" />
                    AI
                  </span>
                </TableHead>
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

      {sessions.data.total > 0 && (
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
