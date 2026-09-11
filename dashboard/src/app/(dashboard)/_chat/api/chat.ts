import type { Polarity } from "@/lib/api";
import { authed, get } from "@/lib/api-client";

export type ChatSource = {
  n: number;
  actor: string | null;
  label: string;
  text: string;
  polarity: Polarity;
  recordId: string;
  recordTitle: string;
  scope: string;
  at: string | null;
  url?: string | null;
};

type ChatDetail = {
  id: string;
  title: string | null;
  scope_ids: number[];
  scope_name: string | null;
  messages: { role: "user" | "assistant"; content: string; sources: ChatSource[]; at: string }[];
};

export type PolishOption = {
  label: string;
  text: string;
  changed: string[];
};

export const loadChat = (id: string) => get<ChatDetail>(`/api/chats/${encodeURIComponent(id)}`);

export async function polishTranscript(text: string): Promise<PolishOption[]> {
  const res = await fetch("/api/polish", {
    method: "POST",
    headers: await authed({ "content-type": "application/json" }),
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
  const res = await fetch("/api/transcribe", { method: "POST", body: form, headers: await authed() });
  const json = (await res.json()) as { text?: string; error?: string };
  if (!res.ok) throw new Error(json.error ?? `文字起こしが ${res.status}`);
  return json.text ?? "";
}

export async function askStream(
  body: {
    question: string;
    history: { role: "user" | "assistant"; content: string }[];
    scopeIds: number[];
    chatId?: string;
    scopeName?: string;
  },
  on: {
    sources: (sources: ChatSource[]) => void;
    text: (text: string) => void;
    error: (message: string) => void;
    saved?: (chatId: string) => void;
    cost?: (question: number, month: number | null) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: await authed({ "content-type": "application/json" }),
    body: JSON.stringify(body),
    signal,
  });
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
      else if (event === "saved") on.saved?.(data.chatId);
      else if (event === "cost") on.cost?.(data.question, data.month);
      else if (event === "error") on.error(data.message);
    }
  }
}
