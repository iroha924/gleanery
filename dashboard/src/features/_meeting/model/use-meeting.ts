import { useRef, useState } from "react";
import { toast } from "sonner";
import { type Heard, listen } from "@/lib/listen";
import { useProject } from "@/lib/project";
import { askReply, type Reply, realtimeToken } from "../api/meeting";

/** `systemAudio` はまだ TS の DOM 型に無い。Chrome 141 以降・macOS 14.2 以降で効く。 */
type ShareOptions = DisplayMediaStreamOptions & { systemAudio?: "include" | "exclude" };

export type Who = "me" | "them";
export type Line = { key: string; who: Who; at: number; text: string; done: boolean };

export const clock = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * 会議のかんぺの状態。話者を推定せず、記憶でも答えない。
 *
 * 自分の声はマイクから、相手の声は画面共有の音声から、別々に流す。混ざった 1 本を後から
 * 分けようとすると当たらない（実測: OpenAI の diarize は文字起こしが崩れ、6.6 倍遅い）。
 */
export function useMeeting() {
  const [lines, setLines] = useState<Line[]>([]);
  const [on, setOn] = useState(false);
  const [reply, setReply] = useState<Reply | null>(null);
  const [replyFailed, setReplyFailed] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const closers = useRef<(() => void)[]>([]);
  const streams = useRef<MediaStream[]>([]);
  const t0 = useRef(0);
  const { project, label: projectLabel } = useProject();
  const projects = project ? [project.id] : [];

  const stop = () => {
    for (const c of closers.current) c();
    for (const s of streams.current) for (const t of s.getTracks()) t.stop();
    closers.current = [];
    streams.current = [];
    setOn(false);
  };

  /** 発話 1 つを更新する。delta は継ぎ足し、completed は全文で置き換わる。 */
  const heard = (who: Who, h: Heard) => {
    const key = `${who}:${h.itemId}`;
    setLines((ls) => {
      const i = ls.findIndex((l) => l.key === key);
      if (i === -1) {
        return [...ls, { key, who, at: (Date.now() - t0.current) / 1000, text: h.text, done: h.done }];
      }
      const prev = ls[i];
      if (!prev) return ls;
      const next = { ...prev, text: h.done ? h.text : prev.text + h.text, done: h.done };
      return [...ls.slice(0, i), next, ...ls.slice(i + 1)];
    });
    // **相手の発話が確定したときだけ引く。**途中の delta で引くと、言い終える前の
    // 半端な文で検索することになり、当たらないうえ課金だけ増える。
    if (who === "them" && h.done && h.text.trim() && projects.length > 0) {
      setThinking(true);
      setReplyFailed(null);
      askReply(h.text, projects)
        .then((r) => {
          // 問われていない発言なら、いま出ている案を消さずに置く。
          if (r.asked) setReply(r);
        })
        .catch((e) => setReplyFailed(e instanceof Error ? e.message : String(e)))
        .finally(() => setThinking(false));
    }
  };

  const start = async () => {
    let them: MediaStream;
    try {
      them = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        systemAudio: "include",
      } as ShareOptions);
    } catch {
      toast.error("画面の共有が始まらなかった");
      return;
    }
    // 音声のない共有は使えない。映像だけ取れても相手の声が入らない。
    if (them.getAudioTracks().length === 0) {
      for (const t of them.getTracks()) t.stop();
      toast.error("音声が共有されていません。共有するとき「音声を共有」を入れてください");
      return;
    }
    let me: MediaStream;
    try {
      me = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      for (const t of them.getTracks()) t.stop();
      toast.error(`マイクを使えなかった（${e instanceof Error ? e.message : String(e)}）`);
      return;
    }
    // ブラウザ側の「共有を停止」で終わったときも畳む。
    const video = them.getVideoTracks()[0];
    if (video) video.onended = stop;

    t0.current = Date.now();
    streams.current = [them, me];
    setLines([]);
    setReply(null);
    setReplyFailed(null);
    setOn(true);
    // 鍵は listen が要るたびに取り直す。10 分で切れるので、渡し切りにしない。
    closers.current = [
      listen(them, realtimeToken, (h) => heard("them", h), toast.error),
      listen(me, realtimeToken, (h) => heard("me", h), toast.error),
    ];
  };

  return {
    lines,
    on,
    reply,
    replyFailed,
    thinking,
    projectLabel,
    canStart: projects.length > 0,
    start,
    stop,
  };
}
