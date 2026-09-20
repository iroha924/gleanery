import type { Stance } from "@/lib/api";
import { get } from "@/lib/api-client";

/** coding session 1 件。title は持ち主の最初の発言。 */
export type SessionRow = {
  id: string;
  origin: "claude-code" | "codex";
  sessionId: string;
  branch: string | null;
  startedAt: string;
  project: string;
  lastAt: string | null;
  title: string | null;
  /** 持ち主の発言の数 */
  said: number;
  /** trace で残した判断の数（案は数えない） */
  traced: number;
};

export type SessionsPage = {
  items: SessionRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
};

/** 自動記録した発言。self は持ち主、assistant は AI の最後の応答。 */
export type SessionMessage = {
  id: string;
  speaker: "self" | "assistant";
  body: string;
  sentAt: string;
  truncated: boolean;
  originalBytes: number;
  files: { path: string; action: "edit" | "read" | "review" }[];
};

/** trace で残した判断。option は decisionId で決定を指す。 */
export type SessionKnowledge = {
  id: number;
  kind: string;
  status: string | null;
  stance: Stance;
  body: string;
  reason: string | null;
  confirmation: string | null;
  downsides: string[];
  at: string;
  decisionId: number | null;
  label: string;
};

export type SessionWork = {
  id: number;
  title: string;
  goal: string;
  current: string;
  next: string[];
  status: string;
  updatedAt: string;
};

/** セッションが触れた要件定義・設計書のうち、承認済みとして同期された原文。 */
export type SessionArtifact = {
  kind: "requirements" | "design";
  change: string;
  path: string;
  title: string;
  /** この版を取り込んだ時刻（文書の本文・題・最終更新日が変わった同期で進む）。commit 時刻ではない */
  syncedAt: string;
  content: string;
};

export type SessionDetail = {
  id: string;
  origin: SessionRow["origin"];
  sessionId: string;
  branch: string | null;
  startedAt: string;
  projectId: number;
  project: string;
  /** `git:github.com/owner/repo`。本文の #123 を issue へ繋ぐのに使う。 */
  projectKey: string;
  /** 一覧と同じ題（持ち主の最初の発言、無ければ結んだ作業の題） */
  title: string | null;
  messages: SessionMessage[];
  knowledge: SessionKnowledge[];
  work: SessionWork[];
  artifacts: SessionArtifact[];
};

/** 検索の当たり 1 件と、それを含む session。 */
export type SessionHit = {
  ref: string;
  label: string;
  stance: Stance;
  text: string;
  reason: string | null;
  at: string;
};
export type FoundSession = {
  id: string;
  sessionId: string;
  origin: SessionRow["origin"];
  project: string;
  title: string | null;
  hits: SessionHit[];
};

/** knowledge は判断、avoid は通ってはいけない道、said は持ち主の発言。 */
export type SearchMode = "knowledge" | "avoid" | "said";

/** project を省くと全部の作業場所。 */
const withProject = (params: URLSearchParams, project: number | undefined): string => {
  if (project !== undefined) params.set("project", String(project));
  return `?${params}`;
};

export const loadSessions = (page: number, project?: number): Promise<SessionsPage> =>
  get<SessionsPage>(
    `/api/sessions${withProject(new URLSearchParams({ page: String(page), pageSize: "20" }), project)}`,
  );

export const loadSession = (id: string): Promise<SessionDetail> =>
  get<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`);

export const searchSessions = (q: string, mode: SearchMode, project?: number): Promise<FoundSession[]> =>
  get<FoundSession[]>(`/api/sessions/search${withProject(new URLSearchParams({ q, mode }), project)}`);
