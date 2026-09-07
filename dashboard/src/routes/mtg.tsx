import { createFileRoute } from "@tanstack/react-router";
import { MicIcon, SquareIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Spinner } from "@/components/ui/spinner";
import { api, type Reply } from "@/lib/api";
import { type Heard, listen } from "@/lib/listen";
import { useProject } from "@/lib/project";

export const Route = createFileRoute("/mtg")({ component: Mtg });

/** `systemAudio` はまだ TS の DOM 型に無い。Chrome 141 以降・macOS 14.2 以降で効く。 */
type ShareOptions = DisplayMediaStreamOptions & { systemAudio?: "include" | "exclude" };

type Who = "me" | "them";
type Line = { key: string; who: Who; at: number; text: string; done: boolean };

const clock = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * 会議のかんぺ。**話者を推定せず、記憶でも答えない。**
 *
 * 自分の声はマイクから、相手の声は画面共有の音声から、別々に流す。混ざった 1 本を後から
 * 分けようとすると当たらない（実測: OpenAI の diarize は文字起こしが崩れ、6.6 倍遅い）。
 * 分けて流せば、声が重なっても誰の発言かは事実として分かる。
 *
 * 返信案は記録にあることだけで作る。**無いときは「無い」と出す** — その場しのぎの案は、
 * 会議のあとで訂正する羽目になるので価値が負になる。
 */
function Mtg() {
  const [lines, setLines] = useState<Line[]>([]);
  const [on, setOn] = useState(false);
  const [reply, setReply] = useState<Reply | null>(null);
  const [thinking, setThinking] = useState(false);
  const closers = useRef<(() => void)[]>([]);
  const streams = useRef<MediaStream[]>([]);
  const t0 = useRef(0);
  const { scopeIds: picked, label: projectLabel } = useProject();
  const scopeIds = picked ?? [];

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
    if (who === "them" && h.done && h.text.trim() && scopeIds.length > 0) {
      setThinking(true);
      api
        .reply(h.text, scopeIds)
        .then((r) => {
          // 問われていない発言なら、いま出ている案を消さずに置く。
          if (r.asked) setReply(r);
        })
        .catch(() => {})
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
    setReply(null);
    setOn(true);
    closers.current = [
      listen(them, token, (h) => heard("them", h), toast.error),
      listen(me, token, (h) => heard("me", h), toast.error),
    ];
  };

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)]">
      {/* かんぺが主。**会議中に読むのはこちらで、文字起こしは確認用。** */}
      <div className="flex min-w-0 flex-1 flex-col gap-4 px-8 py-5">
        <header className="flex flex-none items-center gap-3">
          <Button
            type="button"
            onClick={on ? stop : start}
            disabled={!on && scopeIds.length === 0}
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
          <span className="ml-auto rounded-md border px-2 py-1 font-mono text-[9px] text-muted-foreground">
            {projectLabel}
          </span>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {reply?.asked ? (
            <div className="space-y-5">
              <div>
                <Marker className="font-mono text-[9px] uppercase tracking-[0.14em]">
                  <MarkerContent>いま聞かれています</MarkerContent>
                </Marker>
                <h2 className="mt-1.5 font-extrabold text-[1.4rem] leading-[1.6]">{reply.asked}</h2>
              </div>

              {reply.missing || reply.replies.length === 0 ? (
                // **無いことを隠さない。**ここで曖昧に埋めると、会議のあとで訂正することになる。
                <div className="rounded-xl border border-dont/40 border-dashed p-4">
                  <p className="font-medium text-[15px] text-dont">記録にありません</p>
                  <p className="mt-1.5 text-[13px] text-muted-foreground leading-[1.9]">
                    その場で作らず、「確認して後で返します」と言うほうが安全です。
                  </p>
                </div>
              ) : (
                <ol className="space-y-3">
                  {reply.replies.map((r) => (
                    <li key={r.text} className="rounded-xl border bg-card p-4">
                      <p className="text-[15px] leading-[1.95]">{r.text}</p>
                      {r.sources.length > 0 && (
                        <ul className="mt-3 space-y-1.5 border-t pt-2.5">
                          {r.sources.map((n) => {
                            const f = reply.facts.find((x) => x.n === n);
                            return f ? (
                              <li key={n} className="flex gap-2 text-[11.5px] leading-[1.8]">
                                <span className="flex-none font-mono text-muted-foreground">{n}</span>
                                <span className="min-w-0 text-muted-foreground">
                                  <span className="text-foreground/70">{f.label}</span>
                                  {f.text.slice(0, 90)}
                                </span>
                              </li>
                            ) : null;
                          })}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <h1 className="font-extrabold text-2xl">{on ? "聞いています" : "会議を聞き取る"}</h1>
              <p className="max-w-[30rem] text-muted-foreground text-sm leading-[2]">
                {on ? (
                  <>
                    相手に何か聞かれると、ここに
                    <strong className="font-medium text-foreground">記録で裏の取れた案</strong>
                    を出します。記録に無ければ、無いと言います。
                  </>
                ) : scopeIds.length === 0 ? (
                  "左でプロジェクトを選んでください"
                ) : (
                  <>
                    共有を選ぶとき、
                    <strong className="font-medium text-foreground">音声を一緒に共有</strong>してください。
                    Google Meet ならそのタブ、Zoom や Teams ならそのウィンドウを選びます。
                  </>
                )}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* 文字起こしは従。**合っているかを目の端で確かめるためのもの。** */}
      <aside className="flex w-[22rem] flex-none flex-col gap-3 border-l bg-secondary/25 px-5 py-5">
        <Marker className="flex-none font-mono text-[9px] uppercase tracking-[0.14em]">
          <MarkerContent>聞こえたこと</MarkerContent>
          {thinking && <Spinner className="size-3" />}
          <span className="ml-auto font-mono text-[10px] tabular-nums">{lines.length}</span>
        </Marker>
        <ol className="min-h-0 flex-1 space-y-2.5 overflow-y-auto">
          {lines.map((l) => (
            <li key={l.key} className="flex gap-2">
              <span className="w-8 flex-none pt-0.5 text-right font-mono text-[9px] text-muted-foreground tabular-nums">
                {clock(l.at)}
              </span>
              <p
                className={`min-w-0 text-[12px] leading-[1.85] ${
                  l.who === "them" ? "text-foreground" : "text-muted-foreground"
                } ${l.done ? "" : "opacity-55"}`}
              >
                {l.text}
              </p>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
