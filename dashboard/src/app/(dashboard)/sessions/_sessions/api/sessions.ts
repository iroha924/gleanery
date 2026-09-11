import { get, send } from "@/lib/api-client";

export type SessionRow = {
  id: string;
  session_id: string;
  title: string;
  status: string;
  branch: string | null;
  host: string;
  created_at: string;
  updated_at: string;
  scope_label: string;
  exchanges: number;
};

export type SessionPhase = {
  id: string;
  label: string;
  state: "done" | "doing" | "todo";
};

export type SessionNode = {
  id: number;
  kind: string;
  subkind: string | null;
  polarity: "do" | "dont" | "na";
  status: string | null;
  key: string;
  at: string | null;
  text: string;
  ex: string;
  label: string;
  attrs: {
    confirmation?: string | null;
    consequences?: { good: boolean; text: string }[] | null;
    whyNot?: string | null;
    cmd?: string | null;
    output?: string | null;
    whyNotRun?: string | null;
    verifies?: string | null;
  };
  parent_id: number | null;
};

export type SessionDetail = SessionRow & {
  problem: string;
  goal: string;
  current_at: string | null;
  current_text: string | null;
  phases: SessionPhase[];
  next: { who: "ai" | "human"; text: string }[];
  ended_at: string | null;
  ingested_at: string;
  nodes: SessionNode[];
};

export type SessionHit = {
  id: number;
  key: string;
  kind: string;
  subkind: string | null;
  polarity: "do" | "dont" | "na";
  status: string | null;
  at: string | null;
  text: string;
  ex: string;
  label: string;
  record_id: string;
  record_title: string;
  scope_label: string;
  actor_name: string | null;
  relevance: number | null;
};

export type SessionsPage = {
  items: SessionRow[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
};

const sessionsQuery = (page: number, scopeIds?: number[]): string => {
  const params = new URLSearchParams({ page: String(page), pageSize: "20" });
  if (scopeIds !== undefined) params.set("scopes", scopeIds.join(","));
  return `?${params}`;
};

export const loadSessions = (page: number, scopeIds?: number[]): Promise<SessionsPage> =>
  get<SessionsPage>(`/api/sessions${sessionsQuery(page, scopeIds)}`);

export const loadSession = (id: string): Promise<SessionDetail> =>
  get<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`);

export const searchSessions = (body: {
  question: string;
  onlyDont?: boolean;
  kinds?: string[];
  scopeIds?: number[];
}): Promise<SessionHit[]> => send<SessionHit[]>("/api/sessions/search", "POST", { ...body, limit: 20 });
