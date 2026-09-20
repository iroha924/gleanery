import { type ErrorComponentProps, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

/**
 * 描画中に投げた例外を受ける。**画面を白くしない。**
 * 手元で動く道具なので、詳細は隠さず出す（利用者と開発者が同じ人である）。
 */
export function RouteFailed({ error, reset }: ErrorComponentProps) {
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <h1 className="font-semibold text-lg tracking-[-0.01em]">この画面を出せませんでした</h1>
      <p className="max-w-[34rem] whitespace-pre-wrap text-muted-foreground text-sm leading-[1.9]">
        {error instanceof Error ? error.message : String(error)}
      </p>
      <div className="flex gap-2">
        <Button type="button" onClick={reset} size="sm">
          もう一度
        </Button>
        <Button type="button" variant="outline" size="sm" asChild>
          <Link to="/">チャットへ戻る</Link>
        </Button>
      </div>
    </div>
  );
}

/** 知らない URL。TanStack の既定は最小限なので、戻り道だけ足す。 */
export function RouteMissing() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <h1 className="font-semibold text-lg tracking-[-0.01em]">その画面はありません</h1>
      <Button type="button" variant="outline" size="sm" asChild>
        <Link to="/">チャットへ戻る</Link>
      </Button>
    </div>
  );
}
