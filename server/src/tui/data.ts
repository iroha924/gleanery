// TUI が読むものの口。**SQL をここにも画面にも書かない** — MCP・CLI と同じ関数（sessions.ts・search.ts）を呼ぶ。
// 接続は reader だけで、この module から書く接続（db-write.ts）へ import を辿らせない（`bun run architecture`）。
// プロセスの分離ではない — dashboard は CLI と同じプロセスで動き、バンドルした cli.js には書く接続も入っている。

import { openReader } from "../db.ts";
import { identify, projectId } from "../project.ts";
import {
  type Hit,
  missing,
  read,
  searchMessages,
  searchSplit,
  type Work,
  type WorkDetail,
  workDetail,
} from "../search.ts";
import {
  listSessions,
  listWork,
  type Project,
  projects,
  type SessionDetail,
  type SessionsPage,
  sessionDetail,
} from "../sessions.ts";

export type Mode = "knowledge" | "said";

/** 画面が使う読み出し。test では偽の関数を渡す。 */
export type Data = {
  /** 起動した場所のプロジェクト。未登録なら project は null で、全部のプロジェクトを見る */
  here: { project: number | null; name: string | null };
  projects(): Promise<Project[]>;
  sessions(project: number | null, page: number, pageSize: number): Promise<SessionsPage>;
  session(id: string): Promise<SessionDetail | null>;
  works(project: number | null): Promise<Work[]>;
  work(ref: string, project: number | null): Promise<WorkDetail | null>;
  search(question: string, mode: Mode, project: number | null): Promise<Hit[]>;
  /** 参照の先が無ければ null */
  read(ref: string, project: number | null): Promise<string | null>;
};

/** 全文を読むときの上限。MCP の read（8KB）より広く取る — 人が画面で読むので、切った先を読みに行く手段が無い。 */
const READ_BYTES = 64 * 1024;

const scope = (project: number | null) => (project === null ? null : [project]);

export async function liveData(cwd: string): Promise<{ data: Data; close: () => Promise<void> }> {
  const db = openReader();
  const place = identify(cwd);
  const project = place ? await projectId(db, place.key) : null;
  const data: Data = {
    here: { project, name: project === null ? null : (place?.name ?? null) },
    projects: () => projects(db),
    sessions: (p, page, pageSize) => listSessions(db, { project: p, page, pageSize }),
    session: (id) => sessionDetail(db, id),
    works: (p) => listWork(db, scope(p)),
    work: (ref, p) => workDetail(db, Number(ref.replace(/^w:/, "")), scope(p)),
    // MCP の recall と同じ関数・同じ順位。判断の記録の後に文書の節を並べる。
    search: async (question, mode, p) => {
      if (mode === "said") return searchMessages(db, { question, projects: scope(p), who: "me", limit: 20 });
      const { records, documents } = await searchSplit(db, { question, projects: scope(p), limit: 20 });
      return [...records, ...documents];
    },
    read: async (ref, p) => {
      const text = await read(db, [ref], READ_BYTES, { projects: scope(p) });
      return text === missing(ref) ? null : text;
    },
  };
  return { data, close: () => db.destroy() };
}
