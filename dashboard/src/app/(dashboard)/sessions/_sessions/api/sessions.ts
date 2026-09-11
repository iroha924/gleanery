import { get } from "@/lib/api-client";

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

export type SessionEntry = {
  id: number;
  key: string;
  at: string | null;
  text: string;
  role: "human" | "ai";
  actor_name: string | null;
};

export type SessionDetail = SessionRow & { entries: SessionEntry[] };

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
