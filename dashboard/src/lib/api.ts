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

export type ChatSource = {
  n: number;
  /** 発言の主。判断には付かないので、発言のときだけ入る。 */
  actor: string | null;
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
  /** その参照について書き残したこと。URL はここにしか説明が無い */
  note: string | null;
  /** 0 以外で終わったコマンドの回数 */
  failed: number;
};

export type RecordDetail = RecordRow & { nodes: Node[]; refs: Ref[] };

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

/** 会議で引かれた記録の 1 件。返信案の番号はここを指す。 */
export type Fact = { n: number; label: string; text: string; recordId: string; recordTitle: string };

/** 聞かれたことへの返信案。**missing なら記録に無い**ので、その場で作らない。 */
export type Reply = {
  asked: string | null;
  missing: boolean;
  replies: { text: string; sources: number[] }[];
  facts: Fact[];
};

/** 文字起こしの書き直し案。**選ばなくてよい** — 生のままで足りることがある。 */
export type PolishOption = {
  label: string;
  text: string;
  /** 書き換えた後の語。**本文のどこが変わったかを示すのに使う。** */
  changed: string[];
};

export const api = {
  /** 文字起こしを読める文へ直す候補。句読点・同音異義語・桁は音では直せない。 */
  polish: async (text: string): Promise<PolishOption[]> => {
    const res = await fetch("/api/polish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const json = (await res.json()) as { options?: PolishOption[]; error?: string };
    if (!res.ok) throw new Error(json.error ?? `整形が ${res.status}`);
    return json.options ?? [];
  },
  /** 会議で聞かれたことへの返信案。**記録にあることしか返さない。** */
  reply: async (heard: string, scopeIds: number[]): Promise<Reply> => {
    const res = await fetch("/api/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ heard, scopeIds }),
    });
    const json = (await res.json()) as Reply & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `返信案が ${res.status}`);
    return json;
  },
  /** 会議を聞き取るための一時鍵。**本物の API キーはここへ来ない。**10 分で切れる。 */
  realtimeToken: async (): Promise<string> => {
    const res = await fetch("/api/realtime-token", { method: "POST" });
    const json = (await res.json()) as { token?: string; error?: string };
    if (!res.ok || !json.token) throw new Error(json.error ?? `一時鍵が ${res.status}`);
    return json.token;
  },
  /** 話した音を文字にする。 */
  transcribe: async (audio: Blob): Promise<string> => {
    const form = new FormData();
    form.append("audio", audio, "a.webm");
    const res = await fetch("/api/transcribe", { method: "POST", body: form });
    const json = (await res.json()) as { text?: string; error?: string };
    if (!res.ok) throw new Error(json.error ?? `文字起こしが ${res.status}`);
    return json.text ?? "";
  },
  now: (scopes?: number[]) => get<Now[]>(`/api/now${q(scopes)}`),
  candidates: () => get<Candidate[]>("/api/candidates"),
  groups: () => get<Group[]>("/api/groups"),
  saveGroup: (name: string, paths: string[]) =>
    send<{ ok: true; groupId: number }>("/api/groups", "POST", { name, paths }),
  deleteGroup: (id: number) => send<{ ok: true }>(`/api/groups/${id}`, "DELETE"),
  chats: () => get<ChatRow[]>("/api/chats"),
  chat: (id: string) => get<ChatDetail>(`/api/chats/${id}`),
  deleteChat: (id: string) => send<{ ok: true }>(`/api/chats/${id}`, "DELETE"),
  terms: (scopes?: number[]) => get<Term[]>(`/api/terms${q(scopes)}`),
  saveTerm: (t: { word: string; meaning: string; aliases: string[]; groupId?: number }) =>
    send<{ ok: true }>("/api/terms", "POST", t),
  deleteTerm: (id: number) => send<{ ok: true }>(`/api/terms/${id}`, "DELETE"),
  scopes: () => get<Scope[]>("/api/scopes"),
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
