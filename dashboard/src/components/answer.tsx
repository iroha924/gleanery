import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// 答えは Markdown で返る。**素のまま出すと `**太字**` も表もそのまま見える**ので描画する。
// GFM を入れるのは表を使うため（「どこで解決しているか」の比較が表で返ってくる）。
//
// リンクは**新しいタブ**で開く。いまの会話を捨てさせないため。
// `rel` は付ける — target="_blank" だけだと開いた先から window.opener を触れる。
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground underline underline-offset-2 hover:text-primary"
    >
      {children}
    </a>
  ),
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
  code: ({ children, className }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
    ),
  pre: ({ children }) => (
    // 長い行で画面が横に伸びないよう、ここだけ横スクロールさせる。
    <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs">{children}</pre>
  ),
  // 表は幅が読めないので、はみ出す分はこの中でスクロールさせる。
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b px-2 py-1 align-top">{children}</td>,
  h1: ({ children }) => <h1 className="font-semibold text-base">{children}</h1>,
  h2: ({ children }) => <h2 className="font-semibold text-base">{children}</h2>,
  h3: ({ children }) => <h3 className="font-medium text-sm">{children}</h3>,
};

export function Answer({ text }: { text: string }) {
  return (
    <div className="space-y-3 text-sm">
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
}
