// TUI が読むものの口。**SQL をここにも画面にも書かない** — MCP・CLI と同じ関数（sessions.ts・search.ts）を呼ぶ。
// 接続は reader だけ。取り込み・trace・書き込みの鍵をこのプロセスへ持ち込まない（AGENTS.md の実行境界）。

import { KEY, loadEnv, open } from "../db.ts";
import { identify, projectId } from "../project.ts";
import {
  type Hit,
  read,
  searchKnowledge,
  searchMessages,
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
  /** 起動した場所の作業場所。未登録なら project は null で、全部の作業場所を見る */
  here: { project: number | null; name: string | null };
  projects(): Promise<Project[]>;
  sessions(project: number | null, page: number, pageSize: number): Promise<SessionsPage>;
  session(id: string): Promise<SessionDetail | null>;
  works(project: number | null): Promise<Work[]>;
  work(ref: string, project: number | null): Promise<WorkDetail | null>;
  search(question: string, mode: Mode, project: number | null): Promise<Hit[]>;
  read(ref: string, project: number | null): Promise<string>;
};

/** 全文を読むときの上限。MCP の read（8KB）より広く取る — 人が画面で読むので、切った先を読みに行く手段が無い。 */
const READ_BYTES = 64 * 1024;

const scope = (project: number | null) => (project === null ? null : [project]);

export async function liveData(cwd: string): Promise<{ data: Data; close: () => Promise<void> }> {
  const all = loadEnv();
  // 検索が質問を埋め込むのに VOYAGE_API_KEY が要る（無ければ語彙だけで引く）。それ以外は渡さない。
  const env = { [KEY.reader]: all[KEY.reader], VOYAGE_API_KEY: all.VOYAGE_API_KEY };
  const db = open(env, "reader");
  const place = identify(cwd);
  const project = place ? await projectId(db, place.key) : null;
  const data: Data = {
    here: { project, name: project === null ? null : (place?.name ?? null) },
    projects: () => projects(db),
    sessions: (p, page, pageSize) => listSessions(db, { project: p, page, pageSize }),
    session: (id) => sessionDetail(db, id),
    works: (p) => listWork(db, scope(p)),
    work: (ref, p) => workDetail(db, ref.replace(/^w:/, ""), scope(p)),
    search: (question, mode, p) =>
      mode === "said"
        ? searchMessages(db, env, { question, projects: scope(p), who: "me", limit: 20 })
        : searchKnowledge(db, env, { question, projects: scope(p), limit: 20 }),
    read: (ref, p) => read(db, [ref], READ_BYTES, { projects: scope(p) }),
  };
  return { data, close: () => db.destroy() };
}
