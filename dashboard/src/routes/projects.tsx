import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { LinkIcon, TicketIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, type TrackerKind } from "@/lib/api";

export const Route = createFileRoute("/projects")({ component: Projects });

function Projects() {
  const qc = useQueryClient();
  const scopes = useQuery({ queryKey: ["scopes"], queryFn: api.scopes });
  const groups = useQuery({ queryKey: ["groups"], queryFn: api.groups });
  const candidates = useQuery({ queryKey: ["candidates"], queryFn: api.candidates });

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");

  const save = useMutation({
    mutationFn: () => api.saveGroup(name.trim(), [...picked]),
    onSuccess: () => {
      toast.success(`「${name}」に ${picked.size} 件をまとめた`);
      setPicked(new Set());
      setName("");
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["scopes"] });
    },
    onError: (e) => toast.error(String(e instanceof Error ? e.message : e)),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteGroup(id),
    onSuccess: () => {
      toast.success("まとめを解除した");
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["scopes"] });
    },
    onError: (e) => toast.error(String(e instanceof Error ? e.message : e)),
  });

  // issue の出どころは束ごとに違う。**リポジトリではない**ので、まとめの一員として持つ。
  const [trackerFor, setTrackerFor] = useState<number | null>(null);
  const [trackerKind, setTrackerKind] = useState<TrackerKind>("linear");
  const [trackerIdent, setTrackerIdent] = useState("");

  const addTracker = useMutation({
    mutationFn: (groupId: number) => api.addTracker(groupId, trackerKind, trackerIdent.trim()),
    onSuccess: () => {
      toast.success(`issue の出どころを足した（${trackerKind}: ${trackerIdent.trim()}）`);
      setTrackerFor(null);
      setTrackerIdent("");
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["scopes"] });
    },
    onError: (e) => toast.error(String(e instanceof Error ? e.message : e)),
  });

  const toggle = (p: string) => {
    const next = new Set(picked);
    next.has(p) ? next.delete(p) : next.add(p);
    setPicked(next);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>関連するプロジェクトをまとめる</CardTitle>
          <CardDescription>
            チェックしたプロジェクトは互いに検索されます。チェックしなかったものは独立したままで、
            検索結果に混ざりません。フロントとバックエンドを分けているような場合にまとめます。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {candidates.isPending && <Skeleton className="h-56 w-full" />}
          {candidates.data && (
            <ScrollArea className="h-72 rounded-md border">
              <div className="divide-y">
                {candidates.data.map((c) => (
                  <Label
                    key={c.ident}
                    htmlFor={c.ident}
                    className="flex cursor-pointer items-start gap-3 p-3 hover:bg-muted/50"
                  >
                    <Checkbox
                      id={c.ident}
                      checked={picked.has(c.absPath)}
                      onCheckedChange={() => toggle(c.absPath)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">{c.label}</span>
                        {c.scopeId !== null && (
                          <Badge variant="secondary" className="shrink-0">
                            登録済み
                          </Badge>
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{c.absPath}</span>
                      {c.markers.length > 0 && (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {c.markers.slice(0, 4).map((m) => (
                            <Badge key={m} variant="outline" className="text-[10px]">
                              {m}
                            </Badge>
                          ))}
                        </span>
                      )}
                    </span>
                  </Label>
                ))}
              </div>
            </ScrollArea>
          )}
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="まとめの名前（例: nomophyl）"
            />
            <Button
              onClick={() => save.mutate()}
              disabled={picked.size < 2 || !name.trim() || save.isPending}
            >
              {save.isPending ? <Spinner /> : <LinkIcon />}
              {picked.size >= 2 ? `${picked.size} 件をまとめる` : "2 つ以上選ぶ"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">いまのまとめ</h2>
        {groups.isPending && <Skeleton className="h-20 w-full" />}
        {groups.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            まだまとめはありません。プロジェクトは全部独立しています。
          </p>
        )}
        {groups.data?.map((g) => {
          const dirs = g.members.filter((m) => m.identKind !== "tracker");
          const trackers = g.members.filter((m) => m.identKind === "tracker");
          return (
            <Card key={g.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <CardTitle className="text-base">{g.name}</CardTitle>
                    <CardDescription>
                      {dirs.map((m) => m.label).join(" / ") || "リポジトリ未設定"}
                    </CardDescription>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => remove.mutate(g.id)}
                    disabled={remove.isPending}
                    aria-label={`「${g.name}」のまとめを解除`}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">issue の出どころ</span>
                  {trackers.length === 0 ? (
                    <span className="text-xs text-muted-foreground">未設定</span>
                  ) : (
                    trackers.map((t) => (
                      <Badge key={t.id} variant="secondary" className="gap-1">
                        <TicketIcon className="size-3" />
                        {t.label}
                      </Badge>
                    ))
                  )}
                  {trackerFor !== g.id && (
                    <Button variant="ghost" size="sm" onClick={() => setTrackerFor(g.id)}>
                      足す
                    </Button>
                  )}
                </div>
                {trackerFor === g.id && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Select value={trackerKind} onValueChange={(v) => setTrackerKind(v as TrackerKind)}>
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="linear">Linear</SelectItem>
                        <SelectItem value="github">GitHub</SelectItem>
                        <SelectItem value="jira">Jira</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      value={trackerIdent}
                      onChange={(e) => setTrackerIdent(e.target.value)}
                      placeholder={
                        trackerKind === "linear"
                          ? "チーム名（例: Onetag）"
                          : trackerKind === "jira"
                            ? "プロジェクトキー"
                            : "owner/repo"
                      }
                      className="w-56"
                    />
                    <Button
                      size="sm"
                      onClick={() => addTracker.mutate(g.id)}
                      disabled={!trackerIdent.trim() || addTracker.isPending}
                    >
                      {addTracker.isPending ? <Spinner /> : null} 決定
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setTrackerFor(null)}>
                      やめる
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">保存されているプロジェクト</h2>
        {scopes.isPending && <Skeleton className="h-20 w-full" />}
        {scopes.data?.map((s) => (
          <Item key={s.id} variant="outline">
            <ItemContent>
              <ItemTitle>{s.label}</ItemTitle>
              <ItemDescription className="tabular-nums">
                作業 {s.records} 件 / 記録 {s.nodes} 件{s.groups && ` / まとめ: ${s.groups}`}
                {s.role && ` / ${s.role}`}
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </section>
    </div>
  );
}
