"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, GitPullRequestIcon, RefreshCwIcon, UnplugIcon } from "lucide-react-motion";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { ConfirmDelete } from "@/components/confirm-delete";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, type GithubRepository } from "@/lib/api";

const syncLabels: Record<GithubRepository["syncStatus"], string> = {
  queued: "同期待ち",
  syncing: "同期中",
  synced: "同期済み",
  error: "同期エラー",
};

const syncVariants: Record<GithubRepository["syncStatus"], "warning" | "info" | "success" | "destructive"> = {
  queued: "warning",
  syncing: "info",
  synced: "success",
  error: "destructive",
};

function time(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
    : "未同期";
}

export function GithubPanel() {
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const startedInstallation = useRef<number | null>(null);
  const status = useQuery({
    queryKey: ["github"],
    queryFn: api.github,
    refetchInterval: (query) =>
      query.state.data?.connection?.repositories.some((repository) =>
        ["queued", "syncing"].includes(repository.syncStatus),
      )
        ? 2_000
        : false,
  });

  const connect = useMutation({
    mutationFn: api.connectGithub,
    onSuccess: (data) => {
      qc.setQueryData(["github"], data);
      qc.invalidateQueries({ queryKey: ["scopes"] });
      toast.success("GitHubのリポジトリを接続した");
      window.history.replaceState(null, "", "/settings");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const refresh = useMutation({
    mutationFn: api.refreshGithub,
    onSuccess: (data) => {
      qc.setQueryData(["github"], data);
      qc.invalidateQueries({ queryKey: ["scopes"] });
      toast.success("GitHubの選択リポジトリを更新した");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const sync = useMutation({
    mutationFn: api.syncGithub,
    onSuccess: ({ queued }) => {
      qc.invalidateQueries({ queryKey: ["github"] });
      toast.success(`${queued}件の同期を受け付けた`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const disconnect = useMutation({
    mutationFn: api.disconnectGithub,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["github"] });
      toast.success("GitHub Appの接続を解除した");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  useEffect(() => {
    const raw = searchParams.get("installation_id");
    const installationId = raw && /^\d+$/.test(raw) ? Number(raw) : null;
    if (!installationId || startedInstallation.current === installationId) return;
    startedInstallation.current = installationId;
    connect.mutate(installationId);
  }, [searchParams, connect.mutate]);

  if (status.isPending) return <Skeleton className="h-40 w-full" />;
  if (status.isError) {
    return (
      <p className="rounded-md border border-destructive/50 p-4 text-base text-destructive">
        GitHubの接続状態を取得できませんでした。APIの設定とデータベース移行を確認してください。
      </p>
    );
  }
  if (!status.data.configured) {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle>GitHub</CardTitle>
          <CardDescription>GitHub Appの環境変数が未設定です。接続を開始できません。</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const connection = status.data.connection;
  if (!connection) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitPullRequestIcon />
            GitHubからデータソースを追加
          </CardTitle>
          <CardDescription>
            GitHub Appに許可したリポジトリのPR、issue、レビューコメントを自動で取り込みます。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild disabled={connect.isPending}>
            <a href={status.data.installUrl ?? "#"}>
              <GitPullRequestIcon />
              GitHubと連携
            </a>
          </Button>
          {connect.isPending && (
            <p className="mt-3 text-base text-muted-foreground">
              <Spinner />
              接続を確認しています
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
              <GitPullRequestIcon className="size-5" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>GitHub</CardTitle>
                <Badge variant="info">{connection.accountLogin}</Badge>
              </div>
              <CardDescription className="mt-1">
                許可されたリポジトリだけをデータソースとして同期します。
              </CardDescription>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              {refresh.isPending ? <Spinner /> : <RefreshCwIcon />}選択を更新
            </Button>
            <Button
              size="sm"
              onClick={() => sync.mutate(undefined)}
              disabled={sync.isPending || connection.status !== "active"}
            >
              {sync.isPending ? <Spinner /> : <RefreshCwIcon />}すべて同期
            </Button>
            <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />
            <Tooltip>
              <ConfirmDelete
                what="GitHub Appの接続"
                note="GitHubからAppをアンインストールします。取り込み済みの記録は残ります。"
                onConfirm={() => disconnect.mutate()}
              >
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={disconnect.isPending}
                    aria-label="GitHub Appの接続を解除"
                  >
                    <UnplugIcon />
                  </Button>
                </TooltipTrigger>
              </ConfirmDelete>
              <TooltipContent side="bottom">接続を解除</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {connection.status === "suspended" && (
          <p className="rounded-md border border-destructive/50 p-3 text-base text-destructive">
            GitHub Appが停止されています。GitHub側で再開してから選択を再取得してください。
          </p>
        )}
        {connection.repositories.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-base text-muted-foreground">
            許可されたリポジトリがありません。GitHubでリポジトリを選び、選択を再取得してください。
          </p>
        ) : (
          <div className="space-y-2">
            {connection.repositories.map((repository) => (
              <div
                key={repository.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/45 p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{repository.fullName}</span>
                    {repository.private && <Badge variant="outline">private</Badge>}
                    <Badge variant={syncVariants[repository.syncStatus]}>
                      {syncLabels[repository.syncStatus]}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    最終同期: {time(repository.lastSyncedAt)}
                  </p>
                  {repository.lastError && (
                    <p className="mt-1 text-sm text-destructive">{repository.lastError}</p>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => sync.mutate(repository.id)}
                  disabled={sync.isPending || connection.status !== "active"}
                >
                  <RefreshCwIcon />
                  同期
                </Button>
              </div>
            ))}
          </div>
        )}
        <Button variant="link" className="h-auto gap-1 px-0" asChild>
          <a href={status.data.installUrl ?? "#"}>
            GitHubで対象リポジトリを変更
            <ArrowUpRightIcon />
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}
