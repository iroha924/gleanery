// API の型。**サーバーの戻り値をここで 1 回だけ書く。**
// 画面ごとに書くと、片方だけ直したときに気付けない。

/** 編集フックが 1 回走ったときの記録。**沈黙も 1 行として残る。** */
export type AdviceRow = {
  at: string;
  path: string;
  line: number | null;
  candidates: number;
  shown: string[];
};

export type Advice = {
  rows: AdviceRow[];
  runs: number;
  spoke: number;
  candidates: number;
  repeat: number;
  byPath: { path: string; n: number }[];
};

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

export type ChatSource = {
  n: number;
  label: string;
  text: string;
  polarity: Polarity;
  recordId: string;
  recordTitle: string;
  scope: string;
  at: string | null;
  /** PR や issue の URL。記録そのものには無い */
  url?: string | null;
};

/**
 * 答えを流しながら受け取る。**根拠が先に来る。**
 * 生成を待たずに「何を見て答えるのか」を出せるようにするため。
 */
export async function askStream(
  body: {
    question: string;
    history: { role: "user" | "assistant"; content: string }[];
    /** どのプロジェクトについて聞くか。空だとサーバーが弾く。 */
    scopeIds: number[];
    /** 続きを書き足す会話。省くと新しい会話になる */
    chatId?: string;
    scopeName?: string;
  },
  on: {
    sources: (s: ChatSource[]) => void;
    text: (t: string) => void;
    error: (m: string) => void;
    saved?: (chatId: string) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.body) throw new Error("応答が空");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE は空行で 1 件。行の途中で切れることがあるので、最後の断片は次へ持ち越す。
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const ev = part.match(/^event: (.+)$/m)?.[1];
      const raw = part.match(/^data: (.+)$/m)?.[1];
      if (!ev || !raw) continue;
      const data = JSON.parse(raw);
      if (ev === "sources") on.sources(data.sources);
      else if (ev === "text") on.text(data.text);
      else if (ev === "saved") on.saved?.(data.chatId);
      else if (ev === "error") on.error(data.message);
    }
  }
}

/** 会話の一覧。**ナレッジとは別物**で、記録には混ざらない。 */
export type ChatRow = {
  id: string;
  title: string | null;
  scope_name: string | null;
  updated_at: string;
  messages: number;
};
export type ChatDetail = {
  id: string;
  title: string | null;
  scope_ids: number[];
  scope_name: string | null;
  messages: { role: "user" | "assistant"; content: string; sources: ChatSource[]; at: string }[];
};

export type Stats = { nodes: number; records: number; scopes: number; refs: number };

export type Scope = {
  id: number;
  label: string;
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
  /** 0 以外で終わったコマンドの回数 */
  failed: number;
};

export type RecordDetail = RecordRow & { nodes: Node[]; refs: Ref[] };

export type Hit = Node & {
  record_id: string;
  record_title: string;
  scope_label: string;
  relevance: number | null;
};

/** 範囲のクエリ。undefined は「すべて」なので付けない。 */
const q = (scopes: number[] | undefined): string =>
  scopes === undefined ? "" : `?scopes=${scopes.join(",")}`;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} が ${res.status}`);
  return res.json() as Promise<T>;
}

export type Candidate = {
  ident: string;
  label: string;
  absPath: string;
  hostOrg: string | null;
  markers: string[];
  scopeId: number | null;
};

export type GroupMember = { id: number; label: string; identKind: string; ident: string };
export type Group = { id: number; name: string; members: GroupMember[] };
/** issue の出どころ。**プロジェクトごとに違う**ので束ごとに持つ。 */
export type TrackerKind = "linear" | "github" | "jira";

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

/** 記録に出てくる名前と、その人の呼び名。**対応付けは人が決める。** */
export type Person = { id: number; display: string; handles: string[]; is_me: boolean; note: string | null };
/** まだ誰にも結び付いていない名前と、その名前での発言数 */
export type UnknownHandle = { handle: string; n: number };

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${path} が ${res.status}`);
  return json;
}

export const api = {
  now: (scopes?: number[]) => get<Now[]>(`/api/now${q(scopes)}`),
  review: (id: string) => get<Node[]>(`/api/review/${encodeURIComponent(id)}`),
  candidates: () => get<Candidate[]>("/api/candidates"),
  groups: () => get<Group[]>("/api/groups"),
  saveGroup: (name: string, paths: string[]) =>
    send<{ ok: true; groupId: number }>("/api/groups", "POST", { name, paths }),
  deleteGroup: (id: number) => send<{ ok: true }>(`/api/groups/${id}`, "DELETE"),
  addTracker: (groupId: number, kind: TrackerKind, ident: string) =>
    send<{ ok: true; scopeId: number }>(`/api/groups/${groupId}/tracker`, "POST", { kind, ident }),
  chats: () => get<ChatRow[]>("/api/chats"),
  chat: (id: string) => get<ChatDetail>(`/api/chats/${id}`),
  deleteChat: (id: string) => send<{ ok: true }>(`/api/chats/${id}`, "DELETE"),
  terms: (scopes?: number[]) => get<Term[]>(`/api/terms${q(scopes)}`),
  saveTerm: (t: { word: string; meaning: string; aliases: string[]; groupId?: number }) =>
    send<{ ok: true }>("/api/terms", "POST", t),
  deleteTerm: (id: number) => send<{ ok: true }>(`/api/terms/${id}`, "DELETE"),
  people: () => get<{ people: Person[]; unknown: UnknownHandle[] }>("/api/people"),
  savePerson: (p: { display: string; handles: string[]; isMe: boolean }) =>
    send<{ ok: true }>("/api/people", "POST", p),
  deletePerson: (id: number) => send<{ ok: true }>(`/api/people/${id}`, "DELETE"),
  stats: (scopes?: number[]) => get<Stats>(`/api/stats${q(scopes)}`),
  scopes: () => get<Scope[]>("/api/scopes"),
  advice: () => get<Advice>("/api/advice"),
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`検索が ${res.status}`);
    return res.json() as Promise<Hit[]>;
  },
};
