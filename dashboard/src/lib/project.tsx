import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";

// いま何を見ているか。**1 箇所で決めて全画面が従う。**
//
// 以前は送信のたびにチャットで選ばせていたが、プロジェクトはセッション中ほぼ変わらないので、
// 毎回同じ答えを入力させているだけだった。探すと作業も全プロジェクトを混ぜて出していて、
// 34,591 件のうちどれが目の前の仕事のものか分からなかった。
//
// `""` は「すべて」。チャットだけは 1 つ選ばれていることを求める（混ぜると別の仕事の決定が答えに入る）。
const KEY = "mitos.project";

type Ctx = {
  /** "g:3"（プロジェクト）か "12"（リポジトリ単体）か ""（すべて） */
  target: string;
  setTarget: (t: string) => void;
  /** target を展開したもの。すべてなら undefined（絞らない） */
  scopeIds: number[] | undefined;
  label: string;
};

const ProjectContext = createContext<Ctx | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const groups = useQuery({ queryKey: ["groups"], queryFn: api.groups });
  const scopes = useQuery({ queryKey: ["scopes"], queryFn: api.scopes });
  const [target, setTarget] = useState<string>(() => localStorage.getItem(KEY) ?? "");

  useEffect(() => {
    localStorage.setItem(KEY, target);
  }, [target]);

  const value = useMemo<Ctx>(() => {
    if (target.startsWith("g:")) {
      const g = groups.data?.find((x) => `g:${x.id}` === target);
      return {
        target,
        setTarget,
        // **読み込み前に空配列を返さない。**空配列は「どれも見ない」なので、
        // 一覧が届く前の一瞬だけ全画面が空になる。
        scopeIds: g ? g.members.map((m) => m.id) : undefined,
        label: g?.name ?? "…",
      };
    }
    if (target) {
      const s = scopes.data?.find((x) => String(x.id) === target);
      return { target, setTarget, scopeIds: [Number(target)], label: s?.label ?? "…" };
    }
    return { target, setTarget, scopeIds: undefined, label: "すべて" };
  }, [target, groups.data, scopes.data]);

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): Ctx {
  const c = useContext(ProjectContext);
  if (!c) throw new Error("ProjectProvider の外で useProject を呼んでいる");
  return c;
}

/** API へ渡すクエリ文字列。すべてのときは付けない。 */
export const scopeQuery = (ids: number[] | undefined): string =>
  ids === undefined ? "" : `?scopes=${ids.join(",")}`;
