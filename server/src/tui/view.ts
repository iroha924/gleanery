// CLI の出力を Ink で描く。1 回出して終わる出力なので renderToString で塊ごとに文字列にし、console へ渡す。
// **中身は必ず字下げし、締めの行だけを行頭に置く。**外から来た文字（PR の題、DB に残ったエラー文）が改行を含んでも、
// 行頭の締めの行や状態の行を偽造できない（以前は各行の頭の │ がこの役を持っていた。test/cli.test.ts が見る）。
// 自動記録のフックは CLI ではなく Ink を読み込まないので、server/src/panel.ts の形のまま出す。

import { Alert, Badge, ProgressBar, StatusMessage, ThemeProvider } from "@inkjs/ui";
import { Box, renderToString, Text } from "ink";
import { type FC, createElement as h, type ReactNode } from "react";
import { PALETTE } from "../palette.ts";
import { mark, width } from "../panel.ts";
import { ICONS } from "./icons.ts";
import { earth } from "./theme.ts";

/** 色は標準出力と標準エラーの両方が端末のときだけ（panel.ts の mark と同じ条件）。pipe では AI が読むので飾りを足さない */
const colored = () => Boolean(process.stdout.isTTY && process.stderr.isTTY) && !process.env.NO_COLOR;

/** 端末なら端末の幅で折り返す。pipe では折らない（パスや URL が途中で切れると、読む側が繋ぎ直せない） */
const columns = () => (process.stdout.isTTY ? Math.max(40, process.stdout.columns ?? 100) : 10_000);

// @inkjs/ui の部品の色もアースカラーにするため、テーマを掛けて描く
const draw = (node: ReactNode): string =>
  renderToString(part(ThemeProvider, { theme: earth }, node), { columns: columns() });

/**
 * 1 行にする。制御文字は落とさない — 印の色（panel.ts の mark）の ESC まで消えて `[32m` が残る。
 * 外から来た文字は、呼び出し側が plain / inline を通してから渡す。
 */
const oneLine = (text: string) => text.replace(/\r\n?|[\n\v\f\u0085\u2028\u2029]/g, " ");

/**
 * 見出し。端末では角丸の枠で囲み、要点（meta）を薄く添え、後ろに空行を置く。
 * pipe では `✦ <text>` の 1 行（要点は締めの行に出す。読むのは AI で、枠の文字は読む量を増やすだけ）。
 */
export function title(text: string, meta?: string): string {
  const t = oneLine(text);
  if (!colored()) return draw(h(Text, null, `✦ ${t}`));
  const name = `${ICONS.brand} ${t}`;
  const extra = meta ? `  ${oneLine(meta)}` : "";
  // 枠は中身の幅に合わせ、端末の幅を越えるなら端末の幅で止めて要点の末尾を省く（越えると端末が罫線を折り返して崩れる）
  const inner = width(name) + width(extra);
  return `${draw(
    h(
      Box,
      {
        borderStyle: "round",
        borderColor: PALETTE.terracotta,
        paddingX: 1,
        width: Math.min(inner + 4, columns()),
      },
      h(Box, { flexShrink: 0 }, h(Text, { bold: true, color: PALETTE.terracotta }, name)),
      extra
        ? h(Box, { flexShrink: 1, minWidth: 0 }, h(Text, { dimColor: true, wrap: "truncate-end" }, extra))
        : null,
    ),
  )}\n`;
}

/** 節の見出し（中身と同じだけ字下げし、太字にする） */
export function section(text: string): string {
  return draw(h(Box, { paddingLeft: 2 }, h(Text, { bold: true }, oneLine(text))));
}

/** 印（panel.ts の mark。色の制御文字が前に付くことがある）で始まる行。ラベル・バージョン・値のような列を持つ */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 印の前に付く色の制御文字を読み飛ばす
const MARKED = /^(?:\u001b\[[0-9;]*m)*[✓△✗○](?:\u001b\[[0-9;]*m)* /;

/**
 * 中身の行。全部の行が 2 桁以上下がる。行頭の空白は余白に移すので、端末の幅で折り返した行もその行の文字の頭に揃う
 * （空白を文字のまま渡すと、折り返した 2 行目が 2 桁目へ戻り、どの項目の続きか分からなくなる）。印で始まる行は、2 つ以上
 * 続く空白を列の区切りとみなし、最後の列（値）の中で折り返す。空行は空行のまま
 */
/** Ink は空白で折り返すと、その空白を続きの行の頭に残す（wrap-ansi の trim: false）。続きの行を列に揃えるため 1 つ落とす */
const flush = (out: string, column: number): string =>
  out
    .split("\n")
    .map((l, i) => (i > 0 && l.search(/\S/) === column + 1 ? l.slice(0, column) + l.slice(column + 1) : l))
    .join("\n");

export function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const body = line.trimStart();
      if (body === "") return "";
      const lead = line.length - body.length;
      const cells = MARKED.test(body) ? /^(.*\S\s{2,})(\S.*)$/.exec(body) : null;
      if (cells?.[1] && cells[2]) {
        const row = (value: string) =>
          draw(
            h(
              Box,
              { paddingLeft: 2 + lead },
              h(Box, { flexShrink: 0 }, h(Text, null, cells[1])),
              h(Box, { flexShrink: 1, flexGrow: 1 }, h(Text, { wrap: "wrap" }, value)),
            ),
          );
        const out = row(cells[2]);
        if (!out.includes("\n")) return out;
        // 値の列の位置は、空白を持たない値を同じ配置で描いたときの続きの行の字下げ（記号の幅を自分で数えない）
        const column =
          row("x".repeat(columns() * 2))
            .split("\n")[1]
            ?.search(/\S/) ?? 0;
        return flush(out, column);
      }
      return flush(draw(h(Box, { paddingLeft: 2 + lead }, h(Text, { wrap: "wrap" }, body))), 2 + lead);
    })
    .join("\n");
}

/** 締めの行。行頭に置く唯一の行なので、改行を潰して 1 行にする（偽の行を作らせない）。端末では前に空行を置く */
export function closing(text: string): string {
  const line = draw(h(Text, { bold: true }, oneLine(text)));
  return colored() ? `\n${line}` : line;
}

/** 見出し・中身・締めの 1 塊 */
export function panel(head: string, lines: string[], end: string): string {
  return document(head, undefined, lines.length ? [{ kind: "lines", lines }] : [], end);
}

/** 文書の中の 1 項目。Badge（色は palette.ts の kindColor）・題・本文・出所（行ごとに薄く出し、切らない） */
export type Card = { badge?: { text: string; color: string }; title: string; body?: string; meta?: string[] };

/**
 * 文書の節。どれも端末では部品で描き、pipe では字下げした文字で出す。外から来た文字は、枠かセルか字下げの中にだけ入る。
 *   lines 字下げした行 / table 表 / cards Badge 付きの項目 / fields 項目と値 / meter 割合の棒 / note 印付きの 1 行
 */
export type Block =
  | { kind: "lines"; lines: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "cards"; items: Card[] }
  | { kind: "fields"; rows: [string, string][] }
  | { kind: "meter"; label: string; ratio: number; text: string }
  | { kind: "note"; tone: "info" | "warning" | "error" | "success"; text: string };

/** 見出し・節・締めの文書。端末では節の間に空行を置く */
export function document(head: string, meta: string | undefined, blocks: Block[], end: string): string {
  const fancy = colored();
  const body = blocks.map((b) => (fancy ? drawBlock(b) : plainBlock(b)));
  return [title(head, meta), ...(fancy ? [body.join("\n\n")] : body), closing(end)]
    .filter((x) => x !== "")
    .join("\n");
}

/** 失敗の文書。端末では赤の枠（Alert。印は Alert が付ける）に理由を入れ、pipe では字下げした理由と行頭の `✗ 止まった` */
export function failure(head: string, reason: string): string {
  if (!colored()) return [title(head), indent(reason), closing(`${mark("fail")} 止まった`)].join("\n");
  return [
    title(head),
    draw(
      h(
        Box,
        { paddingLeft: 2, flexDirection: "column" },
        part(Alert, { variant: "error", title: "止まった" }, reason),
      ),
    ),
  ].join("\n");
}

const cell = (text: string) => oneLine(text).trim();

/** @inkjs/ui の部品は型が children を props の必須にしているので、children を props に入れて渡す */
export function part<P extends { children: ReactNode }>(
  C: FC<P>,
  props: Omit<P, "children">,
  children: ReactNode,
) {
  return h(C, { ...props, children } as P);
}

function drawBlock(b: Block): string {
  switch (b.kind) {
    case "lines":
      return b.lines.map(indent).join("\n");
    case "table": {
      // 最後の列以外は、その列の最も長いセルの幅（上限 40）に揃える。最後の列は残りの幅で切る
      const widths = b.head.map((_, i) =>
        Math.min(40, Math.max(...[b.head, ...b.rows].map((r) => width(cell(r[i] ?? ""))))),
      );
      const row = (cells: string[], head: boolean, key: string) =>
        h(
          Box,
          { key },
          ...cells.map((c, i) =>
            i === cells.length - 1
              ? h(
                  Box,
                  { key: i, flexGrow: 1, flexShrink: 1 },
                  h(Text, { wrap: "truncate-end", bold: head, dimColor: head }, cell(c)),
                )
              : h(
                  Box,
                  { key: i, width: (widths[i] ?? 0) + 3, flexShrink: 0 },
                  h(Text, { wrap: "truncate-end", bold: head || i === 0, dimColor: head }, cell(c)),
                ),
          ),
        );
      return draw(
        h(
          Box,
          { paddingLeft: 2, flexDirection: "column" },
          row(b.head, true, "head"),
          ...b.rows.map((r, i) => row(r, false, String(i))),
        ),
      );
    }
    case "cards":
      // Badge を左の列に置き、題・本文・出所を右の列に揃える（折り返しても Badge の下へ回り込まない）
      return draw(
        h(
          Box,
          { paddingLeft: 2, flexDirection: "column", gap: 1 },
          ...b.items.map((c, i) =>
            h(
              Box,
              { key: i },
              c.badge
                ? h(
                    Box,
                    { flexShrink: 0, marginRight: 1 },
                    part(Badge, { color: c.badge.color }, cell(c.badge.text)),
                  )
                : null,
              h(
                Box,
                { flexDirection: "column", flexShrink: 1, flexGrow: 1 },
                h(Text, { bold: true, wrap: "wrap" }, cell(c.title)),
                c.body ? h(Text, { wrap: "wrap" }, c.body) : null,
                ...(c.meta ?? []).map((m, j) =>
                  h(Text, { key: `m${j}`, dimColor: true, wrap: "wrap" }, cell(m)),
                ),
              ),
            ),
          ),
        ),
      );
    case "fields": {
      const w = Math.max(...b.rows.map(([k]) => width(cell(k))));
      return draw(
        h(
          Box,
          { paddingLeft: 2, flexDirection: "column" },
          ...b.rows.map(([k, v], i) =>
            h(
              Box,
              { key: i },
              h(Box, { width: w + 3, flexShrink: 0 }, h(Text, { dimColor: true }, cell(k))),
              h(Box, { flexShrink: 1 }, h(Text, { bold: true, wrap: "wrap" }, cell(v))),
            ),
          ),
        ),
      );
    }
    case "meter":
      return draw(
        h(
          Box,
          { paddingLeft: 2, gap: 2 },
          h(Box, { flexShrink: 0 }, h(Text, { dimColor: true }, cell(b.label))),
          // 棒は端末の幅に合わせて縮める（固定の幅だと、狭い端末で見出しと棒が次の行へ折れる）
          h(
            Box,
            {
              width: Math.max(8, Math.min(30, columns() - width(cell(b.label)) - width(cell(b.text)) - 8)),
              flexShrink: 0,
            },
            h(ProgressBar, { value: Math.max(0, Math.min(100, b.ratio * 100)) }),
          ),
          h(Text, { bold: true }, cell(b.text)),
        ),
      );
    case "note":
      return draw(h(Box, { paddingLeft: 2 }, part(StatusMessage, { variant: b.tone }, cell(b.text))));
  }
}

function plainBlock(b: Block): string {
  switch (b.kind) {
    case "lines":
      return b.lines.map(indent).join("\n");
    case "table":
      return [b.head, ...b.rows].map((r) => indent(r.map(cell).join("  "))).join("\n");
    case "cards":
      return b.items
        .map((c) =>
          [
            indent(`${c.badge ? `【${cell(c.badge.text)}】` : ""}${cell(c.title)}`),
            ...(c.body ? c.body.split("\n").map((l) => indent(`  ${l}`)) : []),
            ...(c.meta ?? []).map((m) => indent(`  ${cell(m)}`)),
          ].join("\n"),
        )
        .join("\n");
    case "fields":
      return b.rows.map(([k, v]) => indent(`${cell(k)}  ${cell(v)}`)).join("\n");
    case "meter":
      return indent(`${cell(b.label)}  ${cell(b.text)}`);
    case "note":
      return indent(cell(b.text));
  }
}

/** 打つ command の手順の 1 項目。after は打った後にすること */
export type Step = { who: string; command: string; after: string | null };

/**
 * 打つ command の手順の塊。端末では角丸の枠で囲み、command を色付きの 1 行で出す（そのまま写せるように）。
 * pipe では枠を付けず、字下げした一覧にする（読むのは AI で、枠の文字は読む量を増やすだけ）。
 */
export function steps(heading: string, items: Step[], note: string): string {
  // 枠の中（字下げ 4・枠と余白 4・項目の字下げ 2）に command が 1 行で入らなければ枠を付けない。Ink は枠の幅で command を
  // 折り、写すと途中までの command になる。枠の無い形は Ink を通さず、折り返しを端末に任せる（写しても 1 行のまま取れる）
  const room = columns() - 10;
  if (!colored() || items.some((x) => width(x.command) > room))
    return [
      `    ${oneLine(heading)}:`,
      ...items.map((x) => `      ${x.who}: ${x.command}${x.after ? ` の後、${x.after}` : ""}`),
      `      ${oneLine(note)}`,
    ].join("\n");
  return draw(
    h(
      Box,
      {
        marginLeft: 4,
        borderStyle: "round",
        borderColor: PALETTE.taupe,
        paddingX: 1,
        flexDirection: "column",
        alignSelf: "flex-start",
      },
      h(Text, { bold: true }, oneLine(heading)),
      ...items.map((x) =>
        h(
          Box,
          { key: x.who, flexDirection: "column", marginTop: 1 },
          h(Text, { bold: true }, x.who),
          h(Box, { paddingLeft: 2 }, h(Text, { color: PALETTE.sand, wrap: "wrap" }, x.command)),
          x.after
            ? h(Box, { paddingLeft: 2 }, h(Text, { dimColor: true, wrap: "wrap" }, `その後: ${x.after}`))
            : null,
        ),
      ),
      h(Box, { marginTop: 1 }, h(Text, { dimColor: true, wrap: "wrap" }, note)),
    ),
  );
}
