import { authed, get, send } from "@/lib/api-client";

// API の型。**サーバーの戻り値をここで 1 回だけ書く。**
// 画面ごとに書くと、片方だけ直したときに気付けない。

export type Phase = { id: string; label: string; state: "done" | "doing" | "todo"; from: string };
export type NextItem = { who: "ai" | "human"; text: string };
export type Wall = { record_id: string; subkind: "constraint" | "non-goal"; text: string; key: string };

export type Now = {
  id: string;
  title: string;
  status: string;
  branch: string | null;
  current_at: string | null;
  current_text: string | null;
  phases: Phase[];
  next: NextItem[];
  updated_at: string;
  project: string;
  walls: Wall[];
};

/** 会話の一覧。**ナレッジとは別物**で、記録には混ざらない。 */
export type ChatRow = {
  id: string;
  title: string | null;
  scope_name: string | null;
  updated_at: string;
  messages: number;
};

export type Scope = {
  id: number;
  label: string;
  identKind: string;
  role: string | null;
  summary: string | null;
  groups: string | null;
  records: number;
  nodes: number;
};

export type RecordRow = {
  id: string;
  title: string;
  status: string;
  branch: string | null;
  problem: string;
  goal: string;
  current_at: string | null;
  current_text: string | null;
  updated_at: string;
  scope_label: string;
  nodes: number;
};

export type Polarity = "do" | "dont" | "na";

export type Node = {
  id: number;
  kind: string;
  subkind: string | null;
  polarity: Polarity;
  status: string | null;
  key: string;
  at: string | null;
  text: string;
  ex: string;
  label: string;
  attrs: {
    // 決定なら「どう確かめるか」と「受け入れた不利な点」、検証なら実行したコマンドと出力。
    // どれも記録には書かれているのに、画面が落としていた。
    confirmation?: string | null;
    /** 実データは配列。良かった点と引き受けた不利が同じ配列に入る。 */
    consequences?: { good: boolean; text: string }[] | null;
    supersededBy?: string | null;
    whyNot?: string | null;
    cmd?: string | null;
    output?: string | null;
    whyNotRun?: string | null;
    verifies?: string | null;
    blocking?: boolean;
    who?: string | null;
    when?: string | null;
  };
  parent_id: number | null;
};

export type Ref = {
  kind: string;
  key: string;
  title: string | null;
  url: string | null;
  /** 根拠(evidence) / 触った(touched) / 関連(link) をまとめたもの */
  roles: string;
  /** その参照について書き残したこと。URL はここにしか説明が無い */
  note: string | null;
  /** 0 以外で終わったコマンドの回数 */
  failed: number;
};

export type RecordDetail = RecordRow & { phases: Phase[]; next: NextItem[]; nodes: Node[]; refs: Ref[] };

export type Hit = Node & {
  record_id: string;
  record_title: string;
  scope_label: string;
  relevance: number | null;
  /** 発言の主。**bot か人かは、これを見ないと本文からしか判らない。** */
  actor_name: string | null;
};

/** 範囲のクエリ。undefined は「すべて」なので付けない。 */
const q = (scopes: number[] | undefined): string =>
  scopes === undefined ? "" : `?scopes=${scopes.join(",")}`;

export type GroupMember = { id: number; label: string; identKind: string; ident: string };
export type Group = { id: number; name: string; members: GroupMember[] };

export type GithubRepository = {
  id: string;
  scopeId: number;
  fullName: string;
  private: boolean;
  syncStatus: "queued" | "syncing" | "synced" | "error";
  syncRequestedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
};

export type GithubStatus = {
  configured: boolean;
  installUrl: string | null;
  connection: {
    id: number;
    accountLogin: string;
    repositorySelection: "all" | "selected";
    status: "active" | "suspended";
    repositories: GithubRepository[];
  } | null;
};

/** プロジェクトの言葉。meaning が null なら「AI が聞きたがっている語」。 */
export type Term = {
  id: number;
  word: string;
  aliases: string[];
  meaning: string | null;
  asked_why: string | null;
  asked_at: string | null;
  project: string | null;
};

/** 会議で引かれた記録の 1 件。返信案の番号はここを指す。 */
export type Fact = { n: number; label: string; text: string; recordId: string; recordTitle: string };

/** 聞かれたことへの返信案。**missing なら記録に無い**ので、その場で作らない。 */
export type Reply = {
  asked: string | null;
  missing: boolean;
  replies: { text: string; sources: number[] }[];
  facts: Fact[];
};

export const api = {
  /** 会議で聞かれたことへの返信案。**記録にあることしか返さない。** */
  reply: async (heard: string, scopeIds: number[]): Promise<Reply> => {
    const res = await fetch("/api/reply", {
      method: "POST",
      headers: await authed({ "content-type": "application/json" }),
      body: JSON.stringify({ heard, scopeIds }),
    });
    const json = (await res.json()) as Reply & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `返信案が ${res.status}`);
    return json;
  },
  /** 会議を聞き取るための一時鍵。**本物の API キーはここへ来ない。**10 分で切れる。 */
  realtimeToken: async (): Promise<string> => {
    const res = await fetch("/api/realtime-token", { method: "POST", headers: await authed() });
    const json = (await res.json()) as { token?: string; error?: string };
    if (!res.ok || !json.token) throw new Error(json.error ?? `一時鍵が ${res.status}`);
    return json.token;
  },
  now: (scopes?: number[]) => get<Now[]>(`/api/now${q(scopes)}`),
  groups: () => get<Group[]>("/api/groups"),
  saveGroup: (name: string, scopeIds: number[]) =>
    send<{ ok: true; groupId: number }>("/api/groups", "POST", { name, scopeIds }),
  deleteGroup: (id: number) => send<{ ok: true }>(`/api/groups/${id}`, "DELETE"),
  chats: () => get<ChatRow[]>("/api/chats"),
  deleteChat: (id: string) => send<{ ok: true }>(`/api/chats/${encodeURIComponent(id)}`, "DELETE"),
  terms: (scopes?: number[]) => get<Term[]>(`/api/terms${q(scopes)}`),
  saveTerm: (t: { word: string; meaning: string; aliases: string[]; groupId?: number }) =>
    send<{ ok: true }>("/api/terms", "POST", t),
  deleteTerm: (id: number) => send<{ ok: true }>(`/api/terms/${id}`, "DELETE"),
  scopes: () => get<Scope[]>("/api/scopes"),
  github: () => get<GithubStatus>("/api/github"),
  connectGithub: (installationId: number) =>
    send<GithubStatus>("/api/github/installations", "POST", { installationId }),
  refreshGithub: () => send<GithubStatus>("/api/github/refresh", "POST"),
  syncGithub: (repositoryId?: string) =>
    send<{ ok: true; queued: number }>("/api/github/sync", "POST", { repositoryId }),
  disconnectGithub: () => send<{ ok: true }>("/api/github/installation", "DELETE"),
  records: (scopes?: number[]) => get<RecordRow[]>(`/api/records${q(scopes)}`),
  record: (id: string) => get<RecordDetail>(`/api/records/${encodeURIComponent(id)}`),
  search: async (body: {
    question: string;
    onlyDont?: boolean;
    kinds?: string[];
    limit?: number;
    scopeIds?: number[];
  }): Promise<Hit[]> => {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: await authed({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`検索が ${res.status}`);
    return res.json() as Promise<Hit[]>;
  },
};
