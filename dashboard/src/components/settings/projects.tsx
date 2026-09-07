import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LinkIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDelete } from "@/components/confirm-delete";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

export function ProjectsPanel() {
  const qc = useQueryClient();
  const scopes = useQuery({ queryKey: ["scopes"], queryFn: api.scopes });
  const groups = useQuery({ queryKey: ["groups"], queryFn: api.groups });
  const candidates = useQuery({ queryKey: ["candidates"], queryFn: api.candidates });

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");

  const save = useMutation({
    mutationFn: () => api.saveGroup(name.trim(), [...picked]),
    onSuccess: () => {
      toast.success(`プロジェクト「${name}」に ${picked.size} 件を入れた`);
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
      toast.success("プロジェクトを消した");
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
          <CardTitle>プロジェクトを作る</CardTitle>
          <CardDescription>
            関連するリポジトリを 1 つのプロジェクトにします。左上でプロジェクトを選ぶと、
            チャット・探す・作業がその中だけを見るようになります。
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
              placeholder="プロジェクト名（例: Example Org）"
            />
            <Button
              onClick={() => save.mutate()}
              disabled={picked.size < 2 || !name.trim() || save.isPending}
            >
              {save.isPending ? <Spinner /> : <LinkIcon />}
              {picked.size >= 2 ? `${picked.size} 件でプロジェクトを作る` : "2 つ以上選ぶ"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">プロジェクト</h2>
        {groups.isPending && <Skeleton className="h-20 w-full" />}
        {groups.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            まだプロジェクトがありません。リポジトリは全部独立しています。
          </p>
        )}
        {groups.data?.map((g) => {
          const dirs = g.members.filter((m) => m.identKind !== "tracker");
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
                  <ConfirmDelete
                    what={g.name}
                    note="束ねた設定が外れます。記録そのものは残ります。"
                    onConfirm={() => remove.mutate(g.id)}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={remove.isPending}
                      aria-label={`プロジェクト「${g.name}」を消す`}
                    >
                      <Trash2Icon />
                    </Button>
                  </ConfirmDelete>
                </div>
              </CardHeader>
              <CardContent className="space-y-3"></CardContent>
            </Card>
          );
        })}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">リポジトリと issue の出どころ</h2>
        {scopes.isPending && <Skeleton className="h-20 w-full" />}
        {scopes.data?.map((s) => (
          <Item key={s.id} variant="outline">
            <ItemContent>
              <ItemTitle>{s.label}</ItemTitle>
              <ItemDescription className="tabular-nums">
                作業 {s.records} 件 / 記録 {s.nodes} 件{s.groups && ` / ${s.groups}`}
                {s.role && ` / ${s.role}`}
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </section>
    </div>
  );
}
