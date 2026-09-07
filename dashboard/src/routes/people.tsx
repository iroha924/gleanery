import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PlusIcon, Trash2Icon, UserIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDelete } from "@/components/confirm-delete";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";

export const Route = createFileRoute("/people")({ component: People });

function People() {
  const qc = useQueryClient();
  const dir = useQuery({ queryKey: ["people"], queryFn: api.people });

  const [display, setDisplay] = useState("");
  const [handles, setHandles] = useState("");
  const [isMe, setIsMe] = useState(false);

  const reset = () => {
    setDisplay("");
    setHandles("");
    setIsMe(false);
  };

  const save = useMutation({
    mutationFn: () =>
      api.savePerson({
        display: display.trim(),
        handles: handles
          .split(/[,\s]+/)
          .map((x) => x.trim())
          .filter(Boolean),
        isMe,
      }),
    onSuccess: () => {
      toast.success(`「${display.trim()}」を名簿に入れた`);
      reset();
      qc.invalidateQueries({ queryKey: ["people"] });
    },
    onError: (e) => toast.error(String(e instanceof Error ? e.message : e)),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deletePerson(id),
    onSuccess: () => {
      toast.success("名簿から外した");
      qc.invalidateQueries({ queryKey: ["people"] });
    },
    onError: (e) => toast.error(String(e instanceof Error ? e.message : e)),
  });

  /** 候補を押したら、その名前を入力欄へ足す。**勝手に呼び名を当てない。** */
  const pick = (handle: string) => {
    setHandles((prev) =>
      prev.split(/[,\s]+/).includes(handle) ? prev : `${prev ? `${prev} ` : ""}${handle}`,
    );
  };

  const edit = (p: { display: string; handles: string[]; is_me: boolean }) => {
    setDisplay(p.display);
    setHandles(p.handles.join(" "));
    setIsMe(p.is_me);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>名簿</CardTitle>
            <CardDescription>
              記録に残っているのは <code className="text-foreground">@reviewer-a</code>{" "}
              のようなハンドル名だけで、それが誰なのかはどこにも書かれていない。ここで結び付けると、
              チャットで「◯◯さんはなんて言ってた？」「最新の私の PR は？」が引けるようになる。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {dir.isPending && <Skeleton className="h-24 w-full" />}
            {dir.data?.people.length === 0 && (
              <p className="text-sm text-muted-foreground">
                まだ誰も入っていない。右の候補から選んで名前を付ける。
              </p>
            )}
            {dir.data?.people.map((p) => (
              <Item key={p.id} variant="outline">
                <ItemMedia>
                  <UserIcon className="size-4" />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="flex items-center gap-2">
                    {p.display}
                    {p.is_me && <Badge>自分</Badge>}
                  </ItemTitle>
                  <ItemDescription className="flex flex-wrap gap-1 pt-1">
                    {p.handles.length === 0 ? (
                      <span>ハンドル未設定</span>
                    ) : (
                      p.handles.map((h) => (
                        <Badge key={h} variant="secondary" className="font-mono text-xs">
                          {h}
                        </Badge>
                      ))
                    )}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button variant="ghost" size="sm" onClick={() => edit(p)}>
                    直す
                  </Button>
                  <ConfirmDelete
                    what={p.display}
                    note="この人に結び付けた呼び名も外れます。記録そのものは残ります。"
                    onConfirm={() => remove.mutate(p.id)}
                  >
                    <Button variant="ghost" size="icon" aria-label={`「${p.display}」を消す`}>
                      <Trash2Icon className="size-4" />
                    </Button>
                  </ConfirmDelete>
                </ItemActions>
              </Item>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>名前を付ける</CardTitle>
            <CardDescription>
              同じ人が GitHub と Linear で違う名前になっていることが多いので、まとめて登録する。
              呼び名が既にあれば上書きになる。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="display">呼び名</Label>
              <Input
                id="display"
                value={display}
                onChange={(e) => setDisplay(e.target.value)}
                placeholder="◯◯さん"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="handles">記録に出てくる名前</Label>
              <Input
                id="handles"
                value={handles}
                onChange={(e) => setHandles(e.target.value)}
                placeholder="reviewer-a レビュアー A"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                空白かカンマで区切る。右の候補を押しても足せる。
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Switch id="isMe" checked={isMe} onCheckedChange={setIsMe} />
              <Label htmlFor="isMe" className="font-normal">
                これは自分（「私の PR」「自分が決めた」がこの人を指すようになる）
              </Label>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => save.mutate()} disabled={!display.trim() || save.isPending}>
                {save.isPending ? <Spinner /> : <PlusIcon />} 名簿に入れる
              </Button>
              {(display || handles) && (
                <Button variant="ghost" onClick={reset}>
                  やめる
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="lg:sticky lg:top-6 lg:self-start">
        <CardHeader>
          <CardTitle>まだ決めていない名前</CardTitle>
          <CardDescription>発言の多い順。押すと入力欄へ足される。</CardDescription>
        </CardHeader>
        <CardContent>
          {dir.isPending && <Skeleton className="h-64 w-full" />}
          {dir.data?.unknown.length === 0 && (
            <p className="text-sm text-muted-foreground">全部の名前に人が付いている。</p>
          )}
          <ScrollArea className="h-[28rem] pr-3">
            <div className="space-y-1">
              {dir.data?.unknown.map((u) => (
                <button
                  key={u.handle}
                  type="button"
                  onClick={() => pick(u.handle)}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <span className="truncate font-mono">{u.handle}</span>
                  <span className="ml-2 shrink-0 tabular-nums text-xs text-muted-foreground">{u.n} 件</span>
                </button>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
