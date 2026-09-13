import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, type Project } from "@/lib/api";

// いま何を見ているか。**1 箇所で決めて全画面が従う。**
// プロジェクトはセッション中ほぼ変わらないので、画面ごとに毎回選ばせない。
//
// `""` は「すべて」。チャットと会議だけは 1 つ選ばれていることを求める（混ぜると別の仕事の決定が答えに入る）。
const KEY = "mitos.project";

type Ctx = {
  /** 作業場所の id か ""（すべて） */
  target: string;
  setTarget: (t: string) => void;
  projects: Project[] | undefined;
  /** 選んだ作業場所。すべてなら null */
  project: Project | null;
  /** API の絞り込みに渡す id。すべてなら undefined（絞らない） */
  projectIds: number[] | undefined;
  label: string;
};

const ProjectContext = createContext<Ctx | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [target, setTargetState] = useState<string | null>(null);
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects, enabled: target !== null });

  useEffect(() => {
    try {
      setTargetState(localStorage.getItem(KEY) ?? "");
    } catch {
      setTargetState("");
    }
  }, []);

  const setTarget = useCallback((next: string) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // 保存できなくても、このタブの中では切り替わる
    }
    setTargetState(next);
  }, []);

  const value = useMemo<Ctx | null>(() => {
    if (target === null) return null;
    const list = projects.data;
    if (!target)
      return { target, setTarget, projects: list, project: null, projectIds: undefined, label: "すべて" };
    const p = list?.find((x) => String(x.id) === target) ?? null;
    // **消えた作業場所を選んだままにしない。**一覧が届いて見つからなければ「すべて」に戻す。
    if (list && !p)
      return { target: "", setTarget, projects: list, project: null, projectIds: undefined, label: "すべて" };
    return {
      target,
      setTarget,
      projects: list,
      project: p,
      projectIds: [Number(target)],
      label: p?.name ?? "…",
    };
  }, [target, setTarget, projects.data]);

  // 保存済みの範囲を読む前に子を出すと、一瞬だけ「すべて」で検索が走る。
  if (value === null) return null;
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): Ctx {
  const c = useContext(ProjectContext);
  if (!c) throw new Error("ProjectProvider の外で useProject を呼んでいる");
  return c;
}
