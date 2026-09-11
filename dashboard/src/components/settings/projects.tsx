import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, FolderPlusIcon, LinkIcon, Trash2Icon } from "lucide-react-motion";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDelete } from "@/components/confirm-delete";
import { GithubPanel } from "@/components/settings/github";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
      <GithubPanel />

      <div className="overflow-hidden rounded-md border bg-card">
        <div className="border-b px-5 py-3">
          <p className="text-base font-medium">プロジェクトの使い方</p>
        </div>
        <ol
          className="grid items-stretch gap-0 px-2 py-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr]"
          aria-label="プロジェクトの使い方"
        >
          <li className="flex gap-3 p-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-background text-base font-semibold">
              1
            </span>
            <div>
              <p className="font-medium">データソースを同期する</p>
              <p className="mt-1 text-base text-muted-foreground">
                GitHubのリポジトリやissueを、それぞれ独立して取り込みます。
              </p>
            </div>
          </li>
          <ArrowRightIcon
            className="mx-auto size-4 rotate-90 self-center text-muted-foreground sm:rotate-0"
            aria-hidden="true"
          />
          <li className="flex gap-3 p-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-background text-base font-semibold">
              2
            </span>
            <div>
              <p className="font-medium">関連するものをまとめる</p>
              <p className="mt-1 text-base text-muted-foreground">
                下のフォームで2つ以上選び、プロジェクトを作ります。
              </p>
            </div>
          </li>
          <ArrowRightIcon
            className="mx-auto size-4 rotate-90 self-center text-muted-foreground sm:rotate-0"
            aria-hidden="true"
          />
          <li className="flex gap-3 p-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-background text-base font-semibold">
              3
            </span>
            <div>
              <p className="font-medium">閲覧範囲を切り替える</p>
              <p className="mt-1 text-base text-muted-foreground">
                作ったプロジェクトは、サイドバー上部から選べます。
              </p>
            </div>
          </li>
        </ol>
        <p className="border-t px-5 py-3 text-sm text-muted-foreground">
          まとめ方を変えても、データソースと記録は削除されません。
        </p>
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-medium">プロジェクト</h2>
          <p className="mt-1 text-base text-muted-foreground">左上の選択肢として表示される閲覧範囲です。</p>
        </div>
        {groups.isPending && <Skeleton className="h-20 w-full" />}
        {groups.data?.length === 0 && (
          <div className="flex items-center gap-3 rounded-md border border-dashed bg-card/60 p-4">
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-secondary text-secondary-foreground">
              <FolderPlusIcon className="size-4" />
            </span>
            <p className="text-base">
              <span className="font-medium">まだプロジェクトがありません</span>
              <span className="mt-0.5 block text-muted-foreground">
                下のフォームでデータソースを2つ以上選んで作成できます。
              </span>
            </p>
          </div>
        )}
        {groups.data?.map((group) => (
          <Card key={group.id}>
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1">
                  <CardTitle className="text-lg">{group.name}</CardTitle>
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
            <p className="rounded-md border border-destructive/50 p-4 text-base text-destructive">
              置き場所を取れませんでした。API に届いていないか、認証が切れています。
            </p>
          )}
          {scopes.data?.length === 0 && (
            <p className="rounded-md border border-dashed p-4 text-base text-muted-foreground">
              登録済みの置き場所がありません。先にローカル環境で取り込みを実行してください。
            </p>
          )}
          {scopes.data && scopes.data.length > 0 && (
            <div className="max-h-72 overflow-y-auto rounded-md border">
              <div className="divide-y">
                {scopes.data.map((scope) => (
                  <Label
                    key={scope.id}
                    htmlFor={`scope-${scope.id}`}
                    className="flex cursor-pointer items-center gap-3 p-3 hover:bg-muted/50"
                  >
                    <Checkbox
                      id={`scope-${scope.id}`}
                      checked={picked.has(scope.id)}
                      onCheckedChange={() => toggle(scope.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">{scope.label}</span>
                        {scope.groups && (
                          <Badge variant="secondary" className="shrink-0">
                            所属: {scope.groups}
                          </Badge>
                        )}
                      </span>
                      <span className="mt-0.5 block text-sm text-muted-foreground tabular-nums">
                        作業 {scope.records} 件 / 記録 {scope.nodes} 件{scope.role && ` / ${scope.role}`}
                      </span>
                    </span>
                  </Label>
                ))}
              </div>
            </div>
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
