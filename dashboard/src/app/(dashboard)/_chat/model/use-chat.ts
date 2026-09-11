"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useProject } from "@/lib/project";
import {
  askStream,
  type ChatSource,
  loadChat,
  type PolishOption,
  polishTranscript,
  transcribe,
} from "../api/chat";

export type Turn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  error?: string;
  stopped?: boolean;
};

export function useChat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [cost, setCost] = useState<{ question: number; month: number | null } | null>(null);
  const { scopeIds: picked, label: projectLabel } = useProject();
  const scopeIds = picked ?? [];
  const abort = useRef<AbortController | null>(null);
  const pendingQuestion = useRef<string | null>(null);
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);
  const [hearing, setHearing] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [options, setOptions] = useState<PolishOption[]>([]);
  const [polishing, setPolishing] = useState(false);
  const searchParams = useSearchParams();
  const chatId = searchParams.get("chat") || undefined;
  const loaded = useRef<string | undefined>(undefined);
  const activeChatId = useRef(chatId);
  const queryClient = useQueryClient();

  const setChatId = (id: string | undefined) => {
    activeChatId.current = id;
    window.history.pushState(null, "", id ? `/?chat=${encodeURIComponent(id)}` : "/");
  };

  const stop = () => {
    const controller = abort.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    const question = pendingQuestion.current;
    if (question !== null) {
      setDraft((current) => current || question);
      pendingQuestion.current = null;
    }
    setTurns((previous) =>
      previous.map((turn, index) => (index >= previous.length - 2 ? { ...turn, stopped: true } : turn)),
    );
  };

  const listen = async () => {
    if (recorder) {
      recorder.stop();
      return;
    }
    if (preparing) return;
    setPreparing(true);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setPreparing(false);
      toast.error("マイクを使えなかった");
      return;
    }
    // 25MB の API 上限内で長時間の会議を録れる一方、音声認識には十分なビットレート。
    const nextRecorder = new MediaRecorder(stream, { audioBitsPerSecond: 24_000 });
    const chunks: Blob[] = [];
    nextRecorder.ondataavailable = (event) => chunks.push(event.data);
    nextRecorder.onstop = async () => {
      for (const track of stream.getTracks()) track.stop();
      setRecorder(null);
      setHearing(true);
      try {
        const text = await transcribe(new Blob(chunks, { type: nextRecorder.mimeType }));
        if (!text) {
          toast.error("何も聞き取れなかった");
          return;
        }
        setDraft((current) => (current ? `${current} ${text}` : text));
        setPolishing(true);
        polishTranscript(text)
          .then(setOptions)
          .catch(() => {})
          .finally(() => setPolishing(false));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setHearing(false);
      }
    };
    // 録音開始イベントより前に録音中と表示すると、話し始めの音が欠ける。
    nextRecorder.onstart = () => {
      setPreparing(false);
      setRecorder(nextRecorder);
    };
    nextRecorder.start();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && abort.current && !abort.current.signal.aborted) {
        event.preventDefault();
        stop();
        return;
      }
      if (event.key.toLowerCase() === "k" && event.shiftKey && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        listen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (abort.current && activeChatId.current !== chatId) abort.current.abort();
    activeChatId.current = chatId;
    if (!chatId) {
      if (loaded.current) {
        loaded.current = undefined;
        setTurns([]);
      }
      return;
    }
    if (loaded.current === chatId) return;
    loaded.current = chatId;
    loadChat(chatId)
      .then((chat) =>
        setTurns(
          chat.messages.map((message, index) => ({
            id: `${chat.id}-${index}`,
            role: message.role,
            content: message.content,
            sources: message.sources,
          })),
        ),
      )
      .catch(() => toast.error("会話を開けなかった"));
  }, [chatId]);

  useEffect(() => () => abort.current?.abort(), []);

  const ask = async (question: string) => {
    setOptions([]);
    if (!question.trim() || busy || scopeIds.length === 0) return;
    setDraft("");
    setBusy(true);
    pendingQuestion.current = question;
    const history = turns
      .filter((turn) => !turn.stopped)
      .map((turn) => ({ role: turn.role, content: turn.content }));
    const id = crypto.randomUUID();
    setTurns((current) => [
      ...current,
      { id: `${id}-q`, role: "user", content: question },
      { id: `${id}-a`, role: "assistant", content: "" },
    ]);

    const controller = new AbortController();
    const requestChatId = activeChatId.current;
    abort.current = controller;
    const patchLastTurn = (update: (turn: Turn) => Turn) =>
      setTurns((current) =>
        current.map((turn, index) => (index === current.length - 1 ? update(turn) : turn)),
      );

    try {
      await askStream(
        { question, history, scopeIds, chatId: activeChatId.current, scopeName: projectLabel },
        {
          sources: (sources) => patchLastTurn((turn) => ({ ...turn, sources })),
          text: (text) => patchLastTurn((turn) => ({ ...turn, content: turn.content + text })),
          error: (message) => patchLastTurn((turn) => ({ ...turn, error: message })),
          cost: (questionCost, month) => setCost({ question: questionCost, month }),
          saved: (savedChatId) => {
            if (abort.current === controller) {
              abort.current = null;
              pendingQuestion.current = null;
              setBusy(false);
            }
            if (window.location.pathname === "/" && activeChatId.current === requestChatId) {
              loaded.current = savedChatId;
              if (savedChatId !== requestChatId) setChatId(savedChatId);
            }
            queryClient.invalidateQueries({ queryKey: ["chats"] });
          },
        },
        controller.signal,
      );
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        patchLastTurn((turn) => ({
          ...turn,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    } finally {
      if (abort.current === controller) {
        abort.current = null;
        pendingQuestion.current = null;
        setBusy(false);
      }
    }
  };

  return {
    ask,
    busy,
    cost,
    draft,
    hearing,
    listen,
    options,
    polishing,
    preparing,
    projectLabel,
    recorder,
    scopeIds,
    setDraft,
    setOptions,
    stop,
    turns,
  };
}
