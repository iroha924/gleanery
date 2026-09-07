import type { GraphNode } from "@/lib/api";

const KIND_LABEL: Record<string, string> = {
  decision: "決めたこと",
  option: "検討した案",
  boundary: "触らない制約",
  verification: "確かめたこと",
  question: "未解決の問い",
  event: "分かったこと",
  utterance: "発言",
};

/** 地図で選んだ節。**地図の上に浮かせる** — 列を足すと地図が狭くなる。
 *  聞くと探すの両方が同じものを出す。 */
export function Focus({ node, links, onClose }: { node: GraphNode; links: number; onClose: () => void }) {
  const rejected = node.kind === "option" && node.subkind === "rejected";
  return (
    <div className="absolute top-4 right-4 w-72 rounded-md border bg-card p-4 shadow-lg">
      <div className="flex items-center gap-2">
        <span
          className={`font-mono text-[10px] tracking-widest ${rejected || node.kind === "boundary" ? "text-dont" : "text-muted-foreground"}`}
        >
          {rejected ? "棄却された案" : (KIND_LABEL[node.kind] ?? node.kind)}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-muted-foreground text-xs hover:text-foreground"
        >
          閉じる
        </button>
      </div>
      <p className="mt-2 text-sm leading-relaxed">{node.text.slice(0, 320)}</p>
      <dl className="mt-3 space-y-1.5 border-t pt-3 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">つながり</dt>
          <dd className="font-mono">{links} 本</dd>
        </div>
        {node.at && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">いつ</dt>
            <dd className="font-mono">{node.at.slice(0, 10)}</dd>
          </div>
        )}
        {node.actor_name && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">誰が</dt>
            <dd className="truncate">{node.actor_name}</dd>
          </div>
        )}
        {node.pr !== null && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">出どころ</dt>
            <dd className="font-mono">PR #{node.pr}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
