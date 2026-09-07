import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphNode } from "@/lib/api";

// 判断の地図。**節の位置は毎回同じにする** — 開くたびに配置が変わると、
// 「あの辺にあったもの」で覚えられなくなる。d3-force を固定回数だけ回して止め、
// 乱数の種は節の id から作る（simulation の既定は Math.random で毎回変わる）。
type Placed = GraphNode & { x: number; y: number };

const SIZE = { decision: 26, option: 17, verification: 19, question: 17, boundary: 18 } as const;
const size = (kind: string): number => SIZE[kind as keyof typeof SIZE] ?? 14;

/** 節 1 つぶんの見た目。**種別は色ではなく形で分ける** — 色は極性に使うため。 */
function dotStyle(n: GraphNode): React.CSSProperties {
  const s = size(n.kind);
  const base: React.CSSProperties = { width: s, height: s, borderRadius: "50%" };
  if (n.kind === "decision") {
    return { ...base, background: "var(--do)", border: "3px solid var(--background)" };
  }
  if (n.kind === "option") {
    const rejected = n.subkind === "rejected";
    return {
      ...base,
      background: "var(--background)",
      // 採用しなかった案は輪郭を破線にする。形だけで「通らなかった道」が分かる。
      border: `2px ${rejected ? "dashed" : "solid"} ${rejected ? "var(--dont)" : "var(--do)"}`,
    };
  }
  if (n.kind === "verification") {
    return {
      ...base,
      background: "color-mix(in oklch, var(--do) 34%, transparent)",
      border: "1.5px solid var(--do)",
    };
  }
  if (n.kind === "boundary") {
    return {
      width: s,
      height: s,
      borderRadius: 3,
      border: "1px solid var(--dont)",
      background:
        "repeating-linear-gradient(45deg, var(--dont), var(--dont) 2px, var(--background) 2px, var(--background) 5px)",
    };
  }
  return { ...base, background: "var(--background)", border: "2px solid var(--muted-foreground)" };
}

const EDGE = {
  rejected: { stroke: "var(--dont)", width: 1.5, dash: "6 5", flow: true },
  considered: { stroke: "var(--do)", width: 1.3, dash: "0", flow: false },
  shares: { stroke: "var(--muted-foreground)", width: 1, dash: "0", flow: false },
} as const;

/** 節の id から決まる乱数。**同じ入力なら同じ配置**にするために要る。 */
function seeded(id: number): number {
  const x = Math.sin(id * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function layout(nodes: GraphNode[], edges: GraphEdge[], w: number, h: number): Placed[] {
  const sim = nodes.map((n) => ({
    ...n,
    x: w / 2 + (seeded(n.id) - 0.5) * w * 0.7,
    y: h / 2 + (seeded(n.id + 7919) - 0.5) * h * 0.7,
  }));
  const byId = new Map(sim.map((n) => [n.id, n]));
  const links = edges
    .filter((e) => byId.has(e.src) && byId.has(e.dst))
    .map((e) => ({ source: byId.get(e.src), target: byId.get(e.dst) }));

  // **辺の無い節が多い。**92 節に対し辺は 52 本で、半分近くはどこにも繋がらない。
  // forceCenter は重心を合わせるだけで散らばりを抑えないので、反発だけだと
  // 繋がっていない節が外周へ飛び、地図の中央が空く（実測でそうなった）。
  // 弱い forceX / forceY で中心へ引き戻す。
  forceSimulation(sim as never[])
    .force("charge", forceManyBody().strength(-170))
    .force(
      "link",
      forceLink(links as never[])
        .distance(110)
        .strength(0.75),
    )
    .force("x", forceX(w / 2).strength(0.07))
    .force("y", forceY(h / 2).strength(0.09))
    .force(
      "collide",
      forceCollide().radius((d) => size((d as unknown as GraphNode).kind) / 2 + 26),
    )
    .stop()
    .tick(340);

  return sim as Placed[];
}

/** 置いた節が実際に占める範囲。**固定の W/H で合わせると外側が切れる。** */
function bounds(placed: Placed[], pad = 120): { x: number; y: number; w: number; h: number } {
  const xs = placed.map((p) => p.x);
  const ys = placed.map((p) => p.y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
}

/** 地図に常に出す種別。**発言と出来事は出さない** — 判断が埋もれる。 */
const ALWAYS = new Set(["decision", "option", "boundary", "verification", "question"]);

// 札の見かけの大きさ（配置座標での目安）。当たり判定にだけ使う。
const LABEL_W = 160;
const LABEL_H = 34;
/** 札がぶつかったときに残す順。**決定と制約を優先する。** */
const PRIORITY: Record<string, number> = {
  decision: 0,
  boundary: 1,
  verification: 2,
  question: 3,
  option: 4,
};

export function Graph({
  nodes,
  edges,
  highlighted,
  selected,
  onSelect,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  highlighted: number[];
  selected: number | null;
  onSelect: (id: number | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  // 掴んだ瞬間の「指の位置」と「そのときの視点」を両方持つ。
  // **視点を描画時の値から引き算しない** — 途中で視点が入れ替わると、
  // 古い値との差が一気に効いて地図が飛ぶ（実測で 700px ほど飛んだ）。
  const drag = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null);
  const moved = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  const W = 1600;
  const H = 1100;
  // **配置は全部の節で計算し、描くのは一部にする。**引用のたびに配置し直すと
  // 地図が跳ねて「さっき見ていた場所」が分からなくなる。出さない節も場所を押さえておく。
  const placed = useMemo(() => layout(nodes, edges, W, H), [nodes, edges]);
  const pos = useMemo(() => new Map(placed.map((n) => [n.id, n])), [placed]);

  const lit = useMemo(() => new Set(highlighted), [highlighted]);

  // 選んだ節と、そこから直接つながっている節。**選択は答えより優先する** —
  // 答えを読んだあとに節を押すのは「この判断の周りを見たい」であって、
  // 答えの範囲へ戻りたいのではない。
  const near = useMemo(() => {
    if (selected === null) return null;
    const s = new Set<number>([selected]);
    for (const e of edges) {
      if (e.src === selected) s.add(e.dst);
      if (e.dst === selected) s.add(e.src);
    }
    return s;
  }, [selected, edges]);

  const active = near ?? (lit.size > 0 ? lit : null);
  const dim = active !== null;

  const shown = useMemo(
    () => placed.filter((n) => ALWAYS.has(n.kind) || lit.has(n.id) || active?.has(n.id)),
    [placed, lit, active],
  );
  const shownIds = useMemo(() => new Set(shown.map((n) => n.id)), [shown]);

  // 引用された節を囲む楕円。**強調を「点の集まり」ではなく「領域」に見せる。**
  const territory = useMemo(() => {
    const pts = highlighted.map((id) => pos.get(id)).filter((p): p is Placed => !!p);
    if (pts.length === 0) return null;
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const rx = Math.max(...pts.map((p) => Math.abs(p.x - cx))) + 190;
    const ry = Math.max(...pts.map((p) => Math.abs(p.y - cy))) + 160;
    return { cx, cy, rx, ry };
  }, [highlighted, pos]);

  /** 指定した節が収まるところまで寄せる。 */
  const fitTo = useCallback((target: Placed[], pad: number) => {
    const el = box.current;
    if (!el || target.length === 0) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const b = bounds(target, pad);
    const k = Math.min(r.width / b.w, r.height / b.h, 1.1);
    const next = { x: (r.width - b.w * k) / 2 - b.x * k, y: (r.height - b.h * k) / 2 - b.y * k, k };
    // **同じ値なら差し替えない。**毎回新しい物を入れると再描画が止まらない。
    setView((v) => (v.x === next.x && v.y === next.y && v.k === next.k ? v : next));
  }, []);

  const fitAll = useCallback(() => {
    const base = placed.filter((n) => ALWAYS.has(n.kind));
    fitTo(base.length > 0 ? base : placed, 120);
  }, [placed, fitTo]);

  // 開いたときに全部が収まるようにする。**節が 1 つも見えない状態で始めない。**
  // 答えが引いた節があるときは、そこへ寄せる。**遠くで 2 つ光っても気付けない。**
  // **節を押しただけでは寄せない。**押すたびに視点が飛ぶと、見ていた場所を見失う。
  useEffect(() => {
    const litNodes = placed.filter((n) => lit.has(n.id));
    if (litNodes.length > 0) fitTo(litNodes, 320);
    else fitAll();
  }, [placed, lit, fitTo, fitAll]);

  /** ある点を動かさずに拡大率だけ変える。**カーソルの下を固定するのが拡大の基本。** */
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView((v) => {
      const k = Math.min(3, Math.max(0.12, v.k * factor));
      if (k === v.k) return v;
      return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k };
    });
  }, []);

  const zoomCenter = useCallback(
    (factor: number) => {
      const r = box.current?.getBoundingClientRect();
      if (r) zoomAt(factor, r.width / 2, r.height / 2);
    },
    [zoomAt],
  );

  // ホイールは React の合成イベントだと passive で来て preventDefault が効かず、
  // 拡大のつもりがページごとスクロールする。**素の listener を passive:false で張る。**
  //
  // **2 本指のスクロールは移動、ピンチだけ拡大。**スクロールを全部拡大に割り当てると、
  // 地図を少し動かしたいだけで倍率が変わってしまう（ブラウザはピンチを ctrlKey 付きで送る）。
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // 札を出す節。**近い節どうしで文字が重なるので、ぶつかったら落とす。**
  // 全部出すと読めなくなり、読めない札は無いのと同じ（実測で 3 行が重なった）。
  // 薄くした節の札も出さない — 薄い文字が重なると、残したものが読みにくくなる。
  const labelled = useMemo(() => {
    const want = shown.filter((n) =>
      dim ? active?.has(n.id) === true : n.kind === "decision" || n.kind === "boundary",
    );
    const order = [...want].sort((a, b) => (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9) || a.id - b.id);
    const taken: { x: number; y: number }[] = [];
    const ok = new Set<number>();
    for (const n of order) {
      const cx = n.x;
      const cy = n.y + size(n.kind) / 2 + 8 + LABEL_H / 2;
      const hit = taken.some((t) => Math.abs(t.x - cx) < LABEL_W * 0.8 && Math.abs(t.y - cy) < LABEL_H);
      if (hit) continue;
      taken.push({ x: cx, y: cy });
      ok.add(n.id);
    }
    return ok;
  }, [shown, dim, active]);

  return (
    // 平行移動と拡大の受け皿。**節そのものは button なのでキーボードで辿れる。**
    <div
      ref={box}
      className="map-paper relative h-full w-full cursor-grab overflow-hidden active:cursor-grabbing"
      onPointerDown={(e) => {
        // 節の上で押したときは掴まない。選ぶ操作と平行移動を混ぜない。
        if ((e.target as HTMLElement).closest("button")) return;
        drag.current = { px: e.clientX, py: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
        moved.current = false;
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.px;
        const dy = e.clientY - d.py;
        // **数 px は押し間違いとして捨てる。**押しただけで地図が動くと、選ぶ操作が怖くなる。
        if (!moved.current && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        moved.current = true;
        setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
      }}
      onPointerUp={() => {
        // 何も無いところを押したら選択を解く。**閉じるボタンを探させない。**
        // 掴んでいないとき（節の上で押したとき）は何もしない。
        if (drag.current && !moved.current) onSelect(null);
        drag.current = null;
      }}
      onPointerLeave={() => {
        drag.current = null;
      }}
    >
      {/* 操作の目盛り。**倍率を数で見せる** — 迷ったら「全体」で必ず戻れる。 */}
      <div className="absolute right-4 bottom-4 z-10 flex items-center gap-1 rounded-md border bg-card p-1 shadow-sm">
        <button
          type="button"
          onClick={() => zoomCenter(1 / 1.25)}
          className="size-7 rounded-sm text-muted-foreground text-sm hover:bg-accent hover:text-foreground"
          aria-label="縮小"
        >
          −
        </button>
        <span className="w-12 text-center font-mono text-[11px] text-muted-foreground tabular-nums">
          {Math.round(view.k * 100)}%
        </span>
        <button
          type="button"
          onClick={() => zoomCenter(1.25)}
          className="size-7 rounded-sm text-muted-foreground text-sm hover:bg-accent hover:text-foreground"
          aria-label="拡大"
        >
          ＋
        </button>
        <span className="mx-0.5 h-4 w-px bg-border" />
        <button
          type="button"
          onClick={fitAll}
          className="rounded-sm px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          全体
        </button>
      </div>

      <div
        className="absolute origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, width: W, height: H }}
      >
        <svg width={W} height={H} className="pointer-events-none absolute inset-0" aria-hidden="true">
          <title>判断のつながり</title>
          <defs>
            <radialGradient id="territory">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.14" />
              <stop offset="60%" stopColor="var(--primary)" stopOpacity="0.05" />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
            </radialGradient>
          </defs>
          {territory && (
            <ellipse
              cx={territory.cx}
              cy={territory.cy}
              rx={territory.rx}
              ry={territory.ry}
              fill="url(#territory)"
            />
          )}
          {edges.map((e) => {
            const a = pos.get(e.src);
            const b = pos.get(e.dst);
            if (!a || !b || !shownIds.has(e.src) || !shownIds.has(e.dst)) return null;
            const st = EDGE[e.kind as keyof typeof EDGE] ?? EDGE.shares;
            const on = !dim || (active?.has(e.src) === true && active?.has(e.dst) === true);
            return (
              <line
                key={`${e.src}-${e.dst}-${e.kind}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={st.stroke}
                strokeWidth={st.width}
                strokeDasharray={st.dash}
                strokeLinecap="round"
                opacity={on ? 0.85 : 0.14}
                className={st.flow && dim && on ? "map-flow" : undefined}
              />
            );
          })}
        </svg>

        {shown.map((n) => {
          const on = !dim || active?.has(n.id) === true;
          const cite = highlighted.indexOf(n.id);
          return (
            <button
              type="button"
              key={n.id}
              onClick={() => onSelect(n.id)}
              className="absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer transition-opacity"
              style={{ left: n.x, top: n.y, opacity: on ? 1 : 0.2, zIndex: n.id === selected ? 3 : 2 }}
              title={n.text.slice(0, 120)}
            >
              {(n.id === selected || lit.has(n.id)) && (
                <span
                  className="map-halo pointer-events-none absolute top-1/2 left-1/2 rounded-full border border-primary border-dashed opacity-55"
                  style={{ width: 52, height: 52 }}
                />
              )}
              <span
                className="block transition-shadow"
                style={{
                  ...dotStyle(n),
                  boxShadow:
                    n.id === selected
                      ? "0 0 0 9px color-mix(in oklch, var(--primary) 22%, transparent), 0 0 0 1px var(--primary)"
                      : "0 1px 2px oklch(0.4 0.03 235 / 0.18)",
                }}
              />
              {cite >= 0 && (
                <span className="-top-2.5 -left-3 absolute flex size-[17px] items-center justify-center rounded-full bg-primary font-mono text-[10px] text-primary-foreground">
                  {cite + 1}
                </span>
              )}
              {/* 札の幅は固定する。**max-w だけだと、絶対配置の包含ブロックが点の幅（26px）に
                  なるため、和文が 1 文字ずつ縦に折り返す**（実測で縦書きのように見えた）。 */}
              {labelled.has(n.id) && (
                <span className="-translate-x-1/2 absolute top-full left-1/2 mt-2 line-clamp-2 block w-40 rounded-sm bg-background/85 px-1 py-0.5 text-center text-[11px] leading-tight">
                  {n.text.slice(0, 34)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
