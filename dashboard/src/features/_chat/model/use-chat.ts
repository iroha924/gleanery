import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useProject } from "@/lib/project";
import { askStream, type ChatSource, type PolishOption, polishTranscript, transcribe } from "../api/chat";

export type Turn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  error?: string;
  stopped?: boolean;
};

/**
 * チャットの状態。**会話は保存しない**（ブラウザを閉じれば消える）。作業場所を切り替えたら会話を捨てる —
 * 前の作業場所の答えを文脈に持ったまま、別の作業場所について聞かせない。
 */
export function useChat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [cost, setCost] = useState<number | null>(null);
  const { project, label: projectLabel } = useProject();
  const projects = project ? [project.id] : [];
  const abort = useRef<AbortController | null>(null);
  const pendingQuestion = useRef<string | null>(null);
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);
  const [hearing, setHearing] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [options, setOptions] = useState<PolishOption[]>([]);
  const [polishing, setPolishing] = useState(false);

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

  // 作業場所が変わったら、流している答えを止めて会話を捨てる。
  const projectId = project?.id ?? null;
  const shown = useRef(projectId);
  useEffect(() => {
    if (shown.current === projectId) return;
    shown.current = projectId;
    abort.current?.abort();
    setTurns([]);
    setCost(null);
    setOptions([]);
  }, [projectId]);

  useEffect(() => () => abort.current?.abort(), []);

  const ask = async (question: string) => {
    setOptions([]);
    if (!question.trim() || busy || projects.length === 0) return;
    setDraft("");
    setBusy(true);
    pendingQuestion.current = question;
    // 文脈にするのは答えまで返った往復の直近 4 往復だけ。止めた往復と失敗した往復は送らない。
    // サーバーの /api/chat は history を 8 件、1 件 50,000 字（UTF-16 の単位）までしか受けない（越えると以後の質問が
    // 全部 400 になる）。切り口で絵文字などのサロゲートペアを割らない。
    const clip = (text: string) => {
      const cut = text.slice(0, 50_000);
      return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
    };
    const history = turns
      .flatMap((turn, index) => {
        const question = turns[index - 1];
        if (turn.role !== "assistant" || !question || turn.stopped || turn.error || !turn.content) return [];
        return [
          { role: "user" as const, content: clip(question.content) },
          { role: "assistant" as const, content: clip(turn.content) },
        ];
      })
      .slice(-8);
    const id = crypto.randomUUID();
    setTurns((current) => [
      ...current,
      { id: `${id}-q`, role: "user", content: question },
      { id: `${id}-a`, role: "assistant", content: "" },
    ]);

    const controller = new AbortController();
    abort.current = controller;
    const patchLastTurn = (update: (turn: Turn) => Turn) =>
      setTurns((current) =>
        current.map((turn, index) => (index === current.length - 1 ? update(turn) : turn)),
      );

    try {
      await askStream(
        { question, history, projects },
        {
          sources: (sources) => patchLastTurn((turn) => ({ ...turn, sources })),
          text: (text) => patchLastTurn((turn) => ({ ...turn, content: turn.content + text })),
          error: (message) => patchLastTurn((turn) => ({ ...turn, error: message })),
          cost: setCost,
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
    projects,
    recorder,
    setDraft,
    setOptions,
    stop,
    turns,
  };
}
