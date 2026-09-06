import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { LinkIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

export const Route = createFileRoute("/scopes")({ component: Scopes });

function Scopes() {
  const qc = useQueryClient();
  const scopes = useQuery({ queryKey: ["scopes"], queryFn: api.scopes });
  const groups = useQuery({ queryKey: ["groups"], queryFn: api.groups });
  const candidates = useQuery({ queryKey: ["candidates"], queryFn: api.candidates });

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");

  const save = useMutation({
    mutationFn: () => api.saveGroup(name.trim(), [...picked]),
    onSuccess: () => {
      toast.success(`束「${name}」に ${picked.size} 件を入れた`);
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
      toast.success("束を解いた");
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
          <CardTitle>束ねる</CardTitle>
          <CardDescription>
            チェックしたものは互いに検索されます。**選ばなかったものは完全に独立**で、
            互いの記録は引かれません。推論では束ねません（org も親ディレクトリも実データで外れました）。
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
              placeholder="束の名前（例: nomophyl）"
            />
            <Button
              onClick={() => save.mutate()}
              disabled={picked.size < 2 || !name.trim() || save.isPending}
            >
              {save.isPending ? <Spinner /> : <LinkIcon />}
              {picked.size >= 2 ? `${picked.size} 件を束ねる` : "2 つ以上選ぶ"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">いまの束</h2>
        {groups.isPending && <Skeleton className="h-20 w-full" />}
        {groups.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">まだ束はありません。全部が独立しています。</p>
        )}
        {groups.data?.map((g) => (
          <Item key={g.id} variant="outline">
            <ItemContent>
              <ItemTitle>{g.name}</ItemTitle>
              <ItemDescription>{g.members.map((m) => m.label).join(" / ")}</ItemDescription>
            </ItemContent>
            <ItemMedia>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => remove.mutate(g.id)}
                disabled={remove.isPending}
                aria-label={`束「${g.name}」を解く`}
              >
                <Trash2Icon />
              </Button>
            </ItemMedia>
          </Item>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">登録されている作業場所</h2>
        {scopes.isPending && <Skeleton className="h-20 w-full" />}
        {scopes.data?.map((s) => (
          <Item key={s.id} variant="outline">
            <ItemContent>
              <ItemTitle>{s.label}</ItemTitle>
              <ItemDescription className="tabular-nums">
                記録 {s.records} / 判断 {s.nodes}
                {s.groups && ` / 束: ${s.groups}`}
                {s.role && ` / ${s.role}`}
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </section>
    </div>
  );
}
