import { api, type Stance } from "@/lib/api";

/** 答えの根拠。n は本文の [n] に対応する。ref は全文を読むときに /api/read へ渡す。 */
export type ChatSource = {
  n: number;
  ref: string;
  label: string;
  stance: Stance;
  text: string;
  speaker: string | null;
  project: string;
  at: string | null;
  url: string | null;
};

/** 1 往復。画面の状態でも履歴の保存の形でもあるので、境界のこちら側に置く。 */
export type Turn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  error?: string;
  stopped?: boolean;
};

export type PolishOption = {
  label: string;
  text: string;
  changed: string[];
};

export async function polishTranscript(text: string): Promise<PolishOption[]> {
  const res = await fetch("/api/polish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const json = (await res.json()) as { options?: PolishOption[]; error?: string };
  if (!res.ok) throw new Error(json.error ?? `整形が ${res.status}`);
  return json.options ?? [];
}

export async function transcribe(audio: Blob): Promise<string> {
  const form = new FormData();
  form.append("audio", audio, "a.webm");
  // FormData の content-type は境界文字列を含むためブラウザに決めさせる。
  const res = await fetch("/api/transcribe", { method: "POST", body: form });
  const json = (await res.json()) as { text?: string; error?: string };
  if (!res.ok) throw new Error(json.error ?? `文字起こしが ${res.status}`);
  return json.text ?? "";
}

/** 質問を送り、答えを流して受け取る。**会話は保存されない**（履歴は画面が持って次の質問と一緒に送る）。 */
export async function askStream(
  body: {
    question: string;
    history: { role: "user" | "assistant"; content: string }[];
    projects: number[];
  },
  on: {
    sources: (sources: ChatSource[]) => void;
    text: (text: string) => void;
    error: (message: string) => void;
    cost?: (question: number) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof json.error === "string" ? json.error : `チャットが ${res.status}`);
  }
  if (!res.body) throw new Error("応答が空");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE は空行で区切られ、行の途中で切れた末尾は次の chunk へ持ち越す。
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const event = part.match(/^event: (.+)$/m)?.[1];
      const raw = part.match(/^data: (.+)$/m)?.[1];
      if (!event || !raw) continue;
      const data = JSON.parse(raw);
      if (event === "sources") on.sources(data.sources);
      else if (event === "text") on.text(data.text);
      else if (event === "cost") on.cost?.(data.question);
      else if (event === "error") on.error(data.message);
    }
  }
}

/** 参照の全文。作業場所の外は「無い」と返る（サーバー側で絞る）。 */
export const readFull = (ref: string, projects: number[]): Promise<string> => api.read(ref, projects);
