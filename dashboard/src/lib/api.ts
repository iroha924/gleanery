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

export type Group = { id: number; name: string; members: { id: number; label: string }[] };

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
  now: () => get<Now[]>("/api/now"),
  review: (id: string) => get<Node[]>(`/api/review/${encodeURIComponent(id)}`),
  candidates: () => get<Candidate[]>("/api/candidates"),
  groups: () => get<Group[]>("/api/groups"),
  saveGroup: (name: string, paths: string[]) =>
    send<{ ok: true; groupId: number }>("/api/groups", "POST", { name, paths }),
  deleteGroup: (id: number) => send<{ ok: true }>(`/api/groups/${id}`, "DELETE"),
  stats: () => get<Stats>("/api/stats"),
  scopes: () => get<Scope[]>("/api/scopes"),
  records: () => get<RecordRow[]>("/api/records"),
  record: (id: string) => get<RecordDetail>(`/api/records/${encodeURIComponent(id)}`),
  search: async (body: {
    question: string;
    onlyDont?: boolean;
    kinds?: string[];
    limit?: number;
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
