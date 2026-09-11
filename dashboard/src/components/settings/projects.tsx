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
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

function sourceKind(identKind: string) {
  return identKind === "tracker" ? "issue" : "リポジトリ";
}

export function ProjectsPanel() {
  const qc = useQueryClient();
  const scopes = useQuery({ queryKey: ["scopes"], queryFn: api.scopes });
  const groups = useQuery({ queryKey: ["groups"], queryFn: api.groups });

  const [picked, setPicked] = useState<Set<number>>(new Set());
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

  const toggle = (id: number) => {
    const next = new Set(picked);
    next.has(id) ? next.delete(id) : next.add(id);
    setPicked(next);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-muted/30 p-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
          <div>
            <p className="font-medium">データソース</p>
            <p className="mt-1 text-sm text-muted-foreground">
              リポジトリやissueの出どころ。一つずつ独立しています。
            </p>
          </div>
          <span className="text-sm text-muted-foreground" aria-hidden="true">
            複数を束ねる <span className="sm:hidden">↓</span>
            <span className="hidden sm:inline">→</span>
          </span>
          <div>
            <p className="font-medium">プロジェクト</p>
            <p className="mt-1 text-sm text-muted-foreground">
              関連するデータソースをまとめた、画面の閲覧範囲です。
            </p>
          </div>
        </div>
        <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
          プロジェクトを作成・削除しても、元のデータソースと記録は変わりません。
        </p>
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium">プロジェクト</h2>
          <p className="mt-1 text-sm text-muted-foreground">左上の選択肢として表示される閲覧範囲です。</p>
        </div>
        {groups.isPending && <Skeleton className="h-20 w-full" />}
        {groups.data?.length === 0 && (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            まだプロジェクトがありません。下のフォームでデータソースを2つ以上選んで作成できます。
          </p>
        )}
        {groups.data?.map((group) => (
          <Card key={group.id}>
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1">
                  <CardTitle className="text-base">{group.name}</CardTitle>
                  <CardDescription>データソース {group.members.length} 件</CardDescription>
                </div>
                <ConfirmDelete
                  what={group.name}
                  note="束ねた設定が外れます。記録そのものは残ります。"
                  onConfirm={() => remove.mutate(group.id)}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={remove.isPending}
                    aria-label={`プロジェクト「${group.name}」を消す`}
                  >
                    <Trash2Icon />
                  </Button>
                </ConfirmDelete>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {group.members.map((member) => (
                  <Badge key={member.id} variant="outline">
                    <span className="text-muted-foreground">{sourceKind(member.identKind)}</span>
                    {member.label}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>新しいプロジェクト</CardTitle>
          <CardDescription>
            関連するデータソースを2つ以上選んでください。同じデータソースを複数のプロジェクトに入れることもできます。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {scopes.isPending && <Skeleton className="h-56 w-full" />}
          {scopes.isError && (
            <p className="rounded-md border border-destructive/50 p-4 text-sm text-destructive">
              置き場所を取れませんでした。API に届いていないか、認証が切れています。
            </p>
          )}
          {scopes.data?.length === 0 && (
            <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              登録済みの置き場所がありません。先にローカル環境で取り込みを実行してください。
            </p>
          )}
          {scopes.data && scopes.data.length > 0 && (
            <ScrollArea className="h-72 rounded-md border">
              <div className="divide-y">
                {scopes.data.map((scope) => (
                  <Label
                    key={scope.id}
                    htmlFor={`scope-${scope.id}`}
                    className="flex cursor-pointer items-start gap-3 p-3 hover:bg-muted/50"
                  >
                    <Checkbox
                      id={`scope-${scope.id}`}
                      checked={picked.has(scope.id)}
                      onCheckedChange={() => toggle(scope.id)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">{scope.label}</span>
                        <Badge variant="outline" className="shrink-0">
                          {sourceKind(scope.identKind)}
                        </Badge>
                        {scope.groups && (
                          <Badge variant="secondary" className="shrink-0">
                            所属: {scope.groups}
                          </Badge>
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
                        作業 {scope.records} 件 / 記録 {scope.nodes} 件{scope.role && ` / ${scope.role}`}
                      </span>
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
    </div>
  );
}
