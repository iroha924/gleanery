import { createFileRoute } from "@tanstack/react-router";
import { MicIcon, SquareIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

export const Route = createFileRoute("/mtg")({ component: Mtg });

/** `systemAudio` はまだ TS の DOM 型に無い。Chrome 141 以降・macOS 14.2 以降で効く。 */
type ShareOptions = DisplayMediaStreamOptions & { systemAudio?: "include" | "exclude" };

type Line = { id: string; who: "me" | "them"; at: number; text: string };

/** 何秒ごとに区切って文字にするか。**webm は途中のチャンクだけでは読めない**ので、録音そのものを区切る。 */
const SLICE = 20_000;

const clock = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * 会議のかんぺ。**話者を推定しない。**
 *
 * 自分の声はマイクから、相手の声は画面共有の音声から、別々に録る。混ざった 1 本を
 * 後から分けようとすると当たらない（実測: OpenAI の diarize は文字起こしが崩れ、6.6 倍遅い）。
 * 分けて録れば、声が重なっても誰の発言かは事実として分かる。
 */
function Mtg() {
  const [lines, setLines] = useState<Line[]>([]);
  const [on, setOn] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const alive = useRef(false);
  const streams = useRef<MediaStream[]>([]);
  const t0 = useRef(0);

  const stop = () => {
    alive.current = false;
    for (const s of streams.current) for (const t of s.getTracks()) t.stop();
    streams.current = [];
    setOn(false);
  };

  /** 1 系統を録り続ける。**次の区間を先に始めてから**投げるので、間が空かない。 */
  const listen = (stream: MediaStream, who: Line["who"]) => {
    const audio = new MediaStream(stream.getAudioTracks());
    const step = () => {
      if (!alive.current) return;
      const m = new MediaRecorder(audio, { audioBitsPerSecond: 24_000 });
      const chunks: Blob[] = [];
      const at = (Date.now() - t0.current) / 1000;
      m.ondataavailable = (e) => chunks.push(e.data);
      m.onstop = async () => {
        step();
        setWaiting((n) => n + 1);
        try {
          const text = await api.transcribe(new Blob(chunks, { type: m.mimeType }));
          if (text) setLines((ls) => [...ls, { id: crypto.randomUUID(), who, at, text }]);
        } catch {
          // 1 区間の失敗で会議を止めない。落ちた区間が空くだけで、続きは録れている。
        } finally {
          setWaiting((n) => n - 1);
        }
      };
      m.start();
      setTimeout(() => {
        if (m.state !== "inactive") m.stop();
      }, SLICE);
    };
    step();
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
    try {
      me = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      for (const t of them.getTracks()) t.stop();
      toast.error("マイクを使えなかった");
      return;
    }
    // ブラウザ側の「共有を停止」で終わったときも畳む。
    const video = them.getVideoTracks()[0];
    if (video) video.onended = stop;

    t0.current = Date.now();
    streams.current = [them, me];
    alive.current = true;
    setLines([]);
    setOn(true);
    listen(them, "them");
    listen(me, "me");
  };

  const ordered = [...lines].sort((a, b) => a.at - b.at);

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
            {waiting > 0 && <Spinner className="size-3" />}
            {SLICE / 1000} 秒ごとに文字にしています
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
          {ordered.length} 発言
        </span>
      </header>

      {!on && ordered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <h1 className="font-extrabold text-2xl">会議を聞き取る</h1>
          <p className="max-w-[30rem] text-muted-foreground text-sm leading-[2]">
            相手の声は画面共有の音声から、自分の声はマイクから、別々に録ります。
            <strong className="font-medium text-foreground">誰が話したかを推定しません。</strong>
            <br />
            共有を選ぶとき、<strong className="font-medium text-foreground">音声を一緒に共有</strong>
            してください。Google Meet ならそのタブ、Zoom や Teams ならそのウィンドウを選びます。
          </p>
        </div>
      ) : (
        <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-6">
          {ordered.map((l) => (
            <li key={l.id} className="flex gap-3">
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
                }`}
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
