import { createFileRoute } from "@tanstack/react-router";
import { MicIcon, SquareIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { type Heard, listen } from "@/lib/listen";

export const Route = createFileRoute("/mtg")({ component: Mtg });

/** `systemAudio` はまだ TS の DOM 型に無い。Chrome 141 以降・macOS 14.2 以降で効く。 */
type ShareOptions = DisplayMediaStreamOptions & { systemAudio?: "include" | "exclude" };

type Who = "me" | "them";
type Line = { key: string; who: Who; at: number; text: string; done: boolean };

const clock = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * 会議のかんぺ。**話者を推定しない。**
 *
 * 自分の声はマイクから、相手の声は画面共有の音声から、別々に流す。混ざった 1 本を後から
 * 分けようとすると当たらない（実測: OpenAI の diarize は文字起こしが崩れ、6.6 倍遅い）。
 * 分けて流せば、声が重なっても誰の発言かは事実として分かる。
 */
function Mtg() {
  const [lines, setLines] = useState<Line[]>([]);
  const [on, setOn] = useState(false);
  const closers = useRef<(() => void)[]>([]);
  const streams = useRef<MediaStream[]>([]);
  const t0 = useRef(0);

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
    // **音声のない共有は使えない。**映像だけ取れても相手の声が入らない。
    if (them.getAudioTracks().length === 0) {
      for (const t of them.getTracks()) t.stop();
      toast.error("音声が共有されていません。共有するとき「音声を共有」を入れてください");
      return;
    }
    let me: MediaStream;
    let token: string;
    try {
      me = await navigator.mediaDevices.getUserMedia({ audio: true });
      token = await api.realtimeToken();
    } catch (e) {
      for (const t of them.getTracks()) t.stop();
      toast.error(e instanceof Error ? e.message : "マイクを使えなかった");
      return;
    }
    // ブラウザ側の「共有を停止」で終わったときも畳む。
    const video = them.getVideoTracks()[0];
    if (video) video.onended = stop;

    t0.current = Date.now();
    streams.current = [them, me];
    setLines([]);
    setOn(true);
    closers.current = [
      listen(them, token, (h) => heard("them", h), toast.error),
      listen(me, token, (h) => heard("me", h), toast.error),
    ];
  };

  return (
    <div className="mx-auto flex h-[calc(100vh-3.5rem)] w-full max-w-[52rem] min-w-0 flex-col gap-4">
      <header className="flex flex-none items-center gap-3">
        <Button
          type="button"
          onClick={on ? stop : start}
          className={`rounded-full ${on ? "bg-dont text-white hover:bg-dont/90" : ""}`}
        >
          {on ? <SquareIcon className="size-3.5" /> : <MicIcon className="size-4" />}
          {on ? "終了" : "会議を録る"}
        </Button>
        {on && (
          <span className="flex items-center gap-2 text-muted-foreground text-xs">
            <span className="size-1.5 animate-pulse rounded-full bg-dont" />
            聞いています
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
          {lines.length} 発言
        </span>
      </header>

      {!on && lines.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <h1 className="font-extrabold text-2xl">会議を聞き取る</h1>
          <p className="max-w-[30rem] text-muted-foreground text-sm leading-[2]">
            相手の声は画面共有の音声から、自分の声はマイクから、別々に聞きます。
            <strong className="font-medium text-foreground">誰が話したかを推定しません。</strong>
            <br />
            共有を選ぶとき、<strong className="font-medium text-foreground">音声を一緒に共有</strong>
            してください。Google Meet ならそのタブ、Zoom や Teams ならそのウィンドウを選びます。
          </p>
        </div>
      ) : (
        <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-6">
          {lines.map((l) => (
            <li key={l.key} className="flex gap-3">
              <span className="w-10 flex-none pt-1 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                {clock(l.at)}
              </span>
              <span
                className={`w-12 flex-none pt-0.5 font-mono text-[10px] tracking-wide ${
                  l.who === "them" ? "text-link" : "text-muted-foreground"
                }`}
              >
                {l.who === "them" ? "相手" : "あなた"}
              </span>
              <p
                className={`min-w-0 text-[14px] leading-[2] ${
                  l.who === "them" ? "text-foreground" : "text-foreground/70"
                } ${l.done ? "" : "opacity-60"}`}
              >
                {l.text}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
