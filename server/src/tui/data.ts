// What the dashboard reads. **No SQL here or in the screens** — call the same functions as MCP and the CLI (sessions.ts, search.ts).
// Only reader connections. Imports from this module never reach a writing connection (db-write.ts) (`bun run architecture`).
// This is not process isolation — the dashboard runs in the CLI process, and the bundled cli.js also contains writing connections.

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

/** Reads the screens use. Tests pass fakes. */
export type Data = {
  /** The project where the dashboard started. When unregistered, project is null and every project is shown */
  here: { project: number | null; name: string | null };
  projects(): Promise<Project[]>;
  sessions(project: number | null, page: number, pageSize: number): Promise<SessionsPage>;
  session(id: string): Promise<SessionDetail | null>;
  /** more is true when the list was cut at the limit */
  works(project: number | null): Promise<{ items: Work[]; more: boolean }>;
  work(ref: string, project: number | null): Promise<WorkDetail | null>;
  search(question: string, mode: Mode, project: number | null): Promise<Hit[]>;
  /** null when the reference points to nothing */
  read(ref: string, project: number | null): Promise<string | null>;
};

/** Limit for reading a full record. Wider than MCP read (8KB) — a person reads it on screen and has no way to fetch the rest. */
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
    // Same function and ranking as MCP recall. Document sections follow the decision records.
    search: async (question, mode, p) => {
      if (mode === "said") return searchMessages(db, { question, projects: scope(p), who: "me", limit: 20 });
      const { records, documents } = await searchSplit(db, {
        question,
        projects: scope(p),
        limit: 20,
      });
      return [...records, ...documents];
    },
    read: async (ref, p) => {
      const text = (await read(db, [ref], READ_BYTES, { projects: scope(p) })).text;
      return text === missing(ref) ? null : text;
    },
  };
  return { data, close: () => db.destroy() };
}
