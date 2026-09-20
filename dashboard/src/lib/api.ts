import { get } from "@/lib/api-client";

// API の型。**サーバーの戻り値をここで 1 回だけ書く。**
// 画面ごとに書くと、片方だけ直したときに気付けない。

/** 通ってよい道か（do）、いけない道か（dont）。札の色を分ける。 */
export type Stance = "do" | "dont" | "neutral";

/** 取り込み元ごとの最後の同期。失敗していれば lastError を持つ。 */
export type Connector = {
  provider: "github" | "docs";
  lastSuccessAt: string | null;
  lastError: string | null;
};

export type Project = {
  id: number;
  key: string;
  name: string;
  /** coding session の数 */
  sessions: number;
  /** trace で残した判断の数（文書の節は数えない） */
  knowledge: number;
  connectors: Connector[];
};

/** 会議で引かれた記録の 1 件。返信案の番号はここを指す。 */
export type Fact = {
  n: number;
  ref: string;
  label: string;
  text: string;
  speaker: string | null;
  context: string | null;
};

/** 聞かれたことへの返信案。**missing なら記録に無い**ので、その場で作らない。 */
export type Reply = {
  asked: string | null;
  missing: boolean;
  replies: { text: string; sources: number[] }[];
  facts: Fact[];
};

export const api = {
  projects: () => get<Project[]>("/api/projects"),
  /** 参照（k: / m: / s: / w:）の全文。**選んだ作業場所の外は「無い」と返る。** */
  read: (ref: string, projects: number[]) =>
    get<{ text: string }>(`/api/read?${new URLSearchParams({ ref, projects: projects.join(",") })}`).then(
      (r) => r.text,
    ),
  /** 会議で聞かれたことへの返信案。**記録にあることしか返さない。** */
  reply: async (heard: string, projects: number[]): Promise<Reply> => {
    const res = await fetch("/api/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ heard, projects }),
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
};
