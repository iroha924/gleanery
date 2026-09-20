import { cn } from "cn";
import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Table } from "@/components/ui/table";

const JAPANESE_URL_PAIRS = [
  ["（", "）"],
  ["［", "］"],
  ["｛", "｝"],
  ["「", "」"],
  ["『", "』"],
  ["【", "】"],
  ["〈", "〉"],
  ["《", "》"],
  ["〔", "〕"],
] as const;
const JAPANESE_TEXT_START =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}、。，．！？；：（）［］｛｝「」『』【】〈〉《》〔〕]/u;

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

/** `git:github.com/owner/repo` から、その repository の URL を組み立てる。取れなければ null。 */
export function repoUrlOf(projectKey: string | undefined): string | null {
  const at = projectKey?.startsWith("git:") ? projectKey.slice(4) : null;
  return at?.includes("/") ? `https://${at}` : null;
}

// 本文の `#123` を issue へ繋ぐ。GitHub は /issues/N を PR にも当てるので、どちらかを判る必要が無い。
// **リンクとコードの中は触らない。**前後が語の一部のもの（`abc#46`、`#46a`）も拾わない。
const ISSUE_REF = /(?<![\w#])#(\d{1,6})(?![\w-])/gu;

function refsToLinks(value: string, repo: string): MarkdownNode[] | null {
  const out: MarkdownNode[] = [];
  let last = 0;
  for (const m of value.matchAll(ISSUE_REF)) {
    const at = m.index;
    if (at > last) out.push({ type: "text", value: value.slice(last, at) });
    out.push({ type: "link", url: `${repo}/issues/${m[1]}`, children: [{ type: "text", value: m[0] }] });
    last = at + m[0].length;
  }
  if (out.length === 0) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

// remark は渡されたものを attacher として呼び、その戻り値を transformer に使う。
// **transformer を直に返さない** —— tree を受け取れず undefined.children で落ちる。
function remarkIssueRefs(repo: string) {
  return () => (tree: MarkdownNode) => {
    const walk = (parent: MarkdownNode) => {
      const children = parent.children;
      if (!children) return;
      for (let i = 0; i < children.length; i += 1) {
        const node = children[i];
        if (node.type === "link") continue;
        if (node.type !== "text") {
          walk(node);
          continue;
        }
        const replaced = refsToLinks(node.value ?? "", repo);
        if (replaced) {
          children.splice(i, 1, ...replaced);
          i += replaced.length - 1;
        }
      }
    };
    walk(tree);
  };
}

// 保存済み記録には `**強調**https://...（補足）` という区切りのない本文がある。
// 構文木で隣接関係を確かめ、コードと正規の日本語 URL は書き換えない。
function remarkStoredMarkdown() {
  return (tree: MarkdownNode, file: { value?: unknown }) => {
    const source = String(file.value ?? "");
    const visit = (parent: MarkdownNode) => {
      const children = parent.children;
      if (!children) return;

      for (let i = 0; i < children.length; i += 1) {
        const node = children[i];
        if (node.type !== "link" || node.children?.length !== 1 || node.children[0].type !== "text") continue;

        const label = node.children[0].value ?? "";
        const following = children[i + 1]?.type === "text" ? (children[i + 1].value ?? "") : "";
        const pairedSuffixAt = JAPANESE_URL_PAIRS.reduce((found, [open, close]) => {
          const at = label.indexOf(open);
          return at > 0 && following.includes(close) && (found === -1 || at < found) ? at : found;
        }, -1);
        const japaneseAt = label.search(JAPANESE_TEXT_START);
        const followsAsciiOrigin = japaneseAt > 0 && /^https?:\/\/[^/?#]+$/u.test(label.slice(0, japaneseAt));
        const suffixAt =
          followsAsciiOrigin && (pairedSuffixAt === -1 || japaneseAt < pairedSuffixAt)
            ? japaneseAt
            : pairedSuffixAt;
        const linkStart = node.position?.start.offset;
        const linkEnd = node.position?.end.offset;
        const literalLink =
          linkStart !== undefined && linkEnd !== undefined && source.slice(linkStart, linkEnd) === label;
        if (literalLink && suffixAt > 0 && node.url?.startsWith(label.slice(0, suffixAt))) {
          const suffix = label.slice(suffixAt);
          node.url = label.slice(0, suffixAt);
          node.children[0].value = node.url;
          children.splice(i + 1, 0, { type: "text", value: suffix });
        }

        const previous = children[i - 1];
        const strong = previous?.type === "text" ? previous.value?.match(/^\*\*([^*\n]+)\*\*$/u) : null;
        const start = previous?.position?.start.offset;
        const end = previous?.position?.end.offset;
        const raw = start === undefined || end === undefined ? "" : source.slice(start, end);
        const adjacent = end !== undefined && end === node.position?.start.offset;
        let closingSlashes = 0;
        for (let j = raw.length - 3; j >= 0 && raw[j] === "\\"; j -= 1) closingSlashes += 1;
        if (
          !strong ||
          !adjacent ||
          !raw.startsWith("**") ||
          !raw.endsWith("**") ||
          closingSlashes % 2 === 1
        ) {
          continue;
        }

        children.splice(i - 1, 1, { type: "strong", children: [{ type: "text", value: strong[1] }] });
      }

      for (const child of children) visit(child);
    };
    visit(tree);
  };
}

// 素のまま出すと `**太字**` も表もそのまま見えるので描画する。
// GFM は表のため（「どこで解決しているか」の比較が表で返ってくる）。
// リンクは新しいタブで開き、いまの会話を捨てさせない。`rel` が無いと開いた先から window.opener を触れる。
const COMPONENTS: Components = {
  // 取り込んだ記録には第三者由来の Markdown もある。画像 URL は閲覧だけで外部へ通信するため表示しない。
  img: ({ alt }) => (
    <span className="text-muted-foreground">{alt ? `画像: ${alt}` : "画像（表示しません）"}</span>
  ),
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
  // 記事として読ませる。**和文の長文は行間を広く取らないと目が滑る。**
  p: ({ children }) => <p className="text-base leading-7 tracking-[0.01em]">{children}</p>,
  ul: ({ children }) => <ul className="list-disc space-y-1.5 pl-5 text-base leading-7">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1.5 pl-5 text-base leading-7">{children}</ol>,
  code: ({ children, className }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm wrap-anywhere">{children}</code>
    ),
  pre: ({ children }) => (
    // 長い行で画面が横に伸びないよう、ここだけ横スクロールさせる。
    // 言語の無いフェンスは code に className が付かないので、inline 用の地がブロック全体に当たる。
    <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-sm [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  // 幅が読めないので、はみ出す分は Table のラッパーの中でスクロールさせる。
  table: ({ children }) => <Table className="border-collapse">{children}</Table>,
  th: ({ children }) => <th className="border-b px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b px-2 py-1 align-top">{children}</td>,
  h1: ({ children }) => <h1 className="text-base font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="text-base font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="font-medium text-base">{children}</h3>,
};

const COMPACT_COMPONENTS: Components = {
  ...COMPONENTS,
  p: ({ children }) => <p className="leading-7">{children}</p>,
  ul: ({ children }) => <ul className="list-disc space-y-1.5 pl-5 leading-7">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1.5 pl-5 leading-7">{children}</ol>,
  h1: ({ children }) => <h1 className="text-lg font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="text-base font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="text-base font-medium">{children}</h3>,
};

const INLINE_COMPONENTS: Components = {
  ...COMPACT_COMPONENTS,
  p: ({ children }) => <>{children}</>,
};

const INLINE_TEXT_COMPONENTS: Components = {
  ...INLINE_COMPONENTS,
  a: ({ children }) => <>{children}</>,
};

export function MarkdownText({
  text,
  className,
  repo,
}: {
  text: string;
  className?: string;
  /** 渡すと本文の `#123` がその repository の issue へのリンクになる。 */
  repo?: string | null;
}) {
  return (
    <div className={cn("min-w-0 space-y-3 break-words text-base leading-7", className)}>
      <Markdown
        remarkPlugins={
          repo ? [remarkGfm, remarkStoredMarkdown, remarkIssueRefs(repo)] : [remarkGfm, remarkStoredMarkdown]
        }
        components={COMPACT_COMPONENTS}
      >
        {text}
      </Markdown>
    </div>
  );
}

export function MarkdownInline({
  text,
  className,
  disableLinks = false,
}: {
  text: string;
  className?: string;
  disableLinks?: boolean;
}) {
  return (
    <span className={cn("break-words", className)}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkStoredMarkdown]}
        components={disableLinks ? INLINE_TEXT_COMPONENTS : INLINE_COMPONENTS}
        allowedElements={["a", "br", "code", "del", "em", "strong"]}
        unwrapDisallowed
      >
        {text}
      </Markdown>
    </span>
  );
}

export function Answer({ text }: { text: string }) {
  return (
    <div className="space-y-3 text-base">
      <Markdown remarkPlugins={[remarkGfm, remarkStoredMarkdown]} components={COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
}
