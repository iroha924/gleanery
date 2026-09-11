import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenIcon, CircleQuestionMarkIcon, PlusIcon, Trash2Icon } from "lucide-react-motion";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDelete } from "@/components/confirm-delete";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useProject } from "@/lib/project";

export function TermsPanel() {
  const qc = useQueryClient();
  const { scopeIds } = useProject();
  const terms = useQuery({ queryKey: ["terms", scopeIds], queryFn: () => api.terms(scopeIds) });

  const [word, setWord] = useState("");
  const [meaning, setMeaning] = useState("");
  const [aliases, setAliases] = useState("");

  const reset = () => {
    setWord("");
    setMeaning("");
    setAliases("");
  };

  const save = useMutation({
    mutationFn: () =>
      api.saveTerm({
        word: word.trim(),
        meaning: meaning.trim(),
        aliases: aliases
          .split(/[,\s]+/)
          .map((x) => x.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      toast.success(`「${word.trim()}」を覚えた`);
      reset();
      qc.invalidateQueries({ queryKey: ["terms"] });
    },
    onError: (e) => toast.error(String(e instanceof Error ? e.message : e)),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteTerm(id),
    onSuccess: () => {
      toast.success("用語集から外した");
      qc.invalidateQueries({ queryKey: ["terms"] });
    },
    onError: (e) => toast.error(String(e instanceof Error ? e.message : e)),
  });

  const pending = terms.data?.filter((t) => !t.meaning) ?? [];
  const known = terms.data?.filter((t) => t.meaning) ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="space-y-6">
        {/* **AI が聞きたがっている語。**推測で埋めないので、ここが埋まるのを待っている。 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CircleQuestionMarkIcon className="size-4" />
              教えてほしい言葉
              {pending.length > 0 && <Badge variant="warning">{pending.length}</Badge>}
            </CardTitle>
            <CardDescription>
              チャットで答えられなかった社内語です。推測では埋めません —
              間違った定義が事実として引かれるほうが、 知らないままより悪いためです。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {terms.isPending && <Skeleton className="h-20 w-full" />}
            {!terms.isPending && pending.length === 0 && (
              <p className="text-muted-foreground text-base">いま聞きたい言葉はありません。</p>
            )}
            {pending.map((t) => (
              <Item key={t.id} variant="outline">
                <ItemMedia>
                  <CircleQuestionMarkIcon className="size-4" />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{t.word}</ItemTitle>
                  {t.asked_why && <ItemDescription className="pt-1">{t.asked_why}</ItemDescription>}
                </ItemContent>
                <Button variant="outline" size="sm" onClick={() => setWord(t.word)}>
                  答える
                </Button>
              </Item>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>言葉を教える</CardTitle>
            <CardDescription>
              チャットで「〜とは〜という意味」と説明しても覚えます。ここは直したいときに使います。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="word">言葉</Label>
              <Input
                id="word"
                value={word}
                onChange={(e) => setWord(e.target.value)}
                placeholder="旧基盤移行"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="meaning">意味</Label>
              <Textarea
                id="meaning"
                value={meaning}
                onChange={(e) => setMeaning(e.target.value)}
                placeholder="旧基盤で動いている案件を新基盤へ移す作業。社内では「移行」とだけ呼ばれることが多い。"
                className="min-h-20"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="aliases">別の書き方</Label>
              <Input
                id="aliases"
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
                placeholder="移行 基盤移行"
              />
              <p className="text-muted-foreground text-sm">
                空白かカンマで区切る。記録の中でこの書き方をされていても引けるようになる。
              </p>
            </div>
            <Button
              onClick={() => save.mutate()}
              disabled={!word.trim() || !meaning.trim() || save.isPending}
            >
              {save.isPending ? <Spinner /> : <PlusIcon />} 覚えさせる
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card className="lg:sticky lg:top-6 lg:self-start">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpenIcon className="size-4" />
            覚えている言葉
          </CardTitle>
          <CardDescription>{known.length} 語</CardDescription>
        </CardHeader>
        <CardContent>
          {known.length === 0 && <p className="text-muted-foreground text-base">まだありません。</p>}
          <ItemGroup>
            {known.map((t) => (
              <Item key={t.id} variant="muted" className="items-start">
                <ItemContent>
                  <ItemTitle>{t.word}</ItemTitle>
                  <ItemDescription className="leading-relaxed">{t.meaning}</ItemDescription>
                  {t.aliases.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1.5">
                      {t.aliases.map((a) => (
                        <Badge key={a} variant="secondary" className="text-sm">
                          {a}
                        </Badge>
                      ))}
                    </div>
                  )}
                </ItemContent>
                <ItemActions>
                  <ConfirmDelete what={t.word} onConfirm={() => remove.mutate(t.id)}>
                    <Button variant="ghost" size="icon" aria-label={`「${t.word}」を消す`}>
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </ConfirmDelete>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </CardContent>
      </Card>
    </div>
  );
}
