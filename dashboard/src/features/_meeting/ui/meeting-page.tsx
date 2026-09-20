import { cn } from "cn";
import { MicIcon, SquareIcon } from "lucide-react-motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Spinner } from "@/components/ui/spinner";
import { clock, useMeeting } from "../model/use-meeting";

/**
 * 会議のかんぺ。記録にあることだけで返信案を作る。
 * 無いときは「無い」と出す — その場しのぎの案は、会議のあとで訂正する羽目になるので価値が負になる。
 */
export function MeetingPage() {
  const { lines, on, reply, replyFailed, thinking, projectLabel, canStart, start, stop } = useMeeting();

  return (
    <div className="flex h-full min-h-0">
      {/* かんぺが主。会議中に読むのはこちらで、文字起こしは確認用。 */}
      <div className="flex min-w-0 flex-1 flex-col gap-4 px-8 py-5">
        <header className="flex flex-none items-center gap-3">
          <Button
            type="button"
            onClick={on ? stop : start}
            disabled={!on && !canStart}
            className={cn("rounded-md", on && "bg-live text-white hover:bg-live/90")}
            aria-label={on ? "録音を終了する" : "会議の録音を始める"}
          >
            {on ? <SquareIcon className="size-3.5" /> : <MicIcon className="size-4" />}
            {on ? "終了" : "会議を録る"}
          </Button>
          {on && (
            <span className="flex items-center gap-2 text-muted-foreground text-sm">
              <span className="size-1.5 animate-pulse rounded-full bg-live" aria-hidden />
              聞いています
            </span>
          )}
          <Badge variant="outline" className="ml-auto font-mono">
            {projectLabel}
          </Badge>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {replyFailed ? (
            <p
              role="alert"
              className="rounded-md border border-error/40 bg-error/5 px-4 py-2.5 text-base text-error leading-[1.9]"
            >
              返信案を引けませんでした。
              <span className="text-muted-foreground text-sm">（{replyFailed}）</span>
            </p>
          ) : reply?.asked ? (
            <div className="space-y-5">
              <div>
                <Marker className="font-mono text-xs uppercase tracking-[0.14em]">
                  <MarkerContent>いま聞かれています</MarkerContent>
                </Marker>
                <h2 className="mt-1.5 font-semibold text-lg leading-[1.6] tracking-[-0.01em]">
                  {reply.asked}
                </h2>
              </div>

              {reply.missing || reply.replies.length === 0 ? (
                // **無いことを隠さない。**ここで曖昧に埋めると、会議のあとで訂正することになる。
                <div className="rounded-md border border-muted-foreground/40 border-dashed p-4">
                  <p className="font-medium text-base text-muted-foreground">記録にありません</p>
                  <p className="mt-1.5 text-sm text-muted-foreground leading-[1.9]">
                    その場で作らず、「確認して後で返します」と言うほうが安全です。
                  </p>
                </div>
              ) : (
                <ol className="space-y-3">
                  {reply.replies.map((r) => (
                    <li key={r.text} className="rounded-md border bg-card p-4">
                      <p className="text-base leading-[1.95]">{r.text}</p>
                      {r.sources.length > 0 && (
                        <ul className="mt-3 space-y-1.5 border-t pt-2.5">
                          {r.sources.map((n) => {
                            const f = reply.facts.find((x) => x.n === n);
                            return f ? (
                              <li key={n} className="flex gap-2 text-sm leading-[1.8]">
                                <span className="flex-none font-mono text-muted-foreground">{n}</span>
                                <span className="min-w-0 text-muted-foreground">
                                  <span className="text-foreground/70">{f.label}</span>
                                  {f.speaker && `${f.speaker}: `}
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
              <h1 className="font-semibold text-lg tracking-[-0.01em]">
                {on ? "聞いています" : "会議を聞き取る"}
              </h1>
              <p className="max-w-[30rem] text-muted-foreground text-base leading-[2]">
                {on ? (
                  <>
                    相手に何か聞かれると、ここに
                    <strong className="font-medium text-foreground">記録で裏の取れた案</strong>
                    を出します。記録に無ければ、無いと言います。
                  </>
                ) : !canStart ? (
                  "サイドバーで作業場所を 1 つ選んでください"
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

      {/* 文字起こしは従。合っているかを目の端で確かめるためのもの。 */}
      <aside className="flex w-[22rem] flex-none flex-col gap-3 border-l bg-secondary/25 px-5 py-5">
        <Marker className="flex-none font-mono text-xs uppercase tracking-[0.14em]">
          <MarkerContent>聞こえたこと</MarkerContent>
          {thinking && <Spinner className="size-3" />}
          <span className="ml-auto font-mono text-xs tabular-nums">{lines.length}</span>
        </Marker>
        <ol
          className="min-h-0 flex-1 space-y-2.5 overflow-y-auto"
          aria-live="polite"
          aria-label="聞こえたこと"
        >
          {lines.map((l) => (
            <li key={l.key} className="flex gap-2">
              <span className="w-8 flex-none pt-0.5 text-right font-mono text-xs text-muted-foreground tabular-nums">
                {clock(l.at)}
              </span>
              <p
                className={cn(
                  "min-w-0 text-sm leading-[1.85]",
                  l.who === "them" ? "text-foreground" : "text-muted-foreground",
                  !l.done && "opacity-55",
                )}
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
