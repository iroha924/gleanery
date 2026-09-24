// Draws CLI output with Ink. Output is printed once, so each block is rendered to a string with renderToString and passed to console.
// **Content is always indented; only the closing line starts at column 0.** Text from outside (PR titles, errors stored in the
// database) cannot forge a closing or status line even with newlines (the │ at each line start used to do this; test/cli.test.ts checks).
// Recording hooks are not the CLI and do not load Ink, so they keep the server/src/panel.ts format.

import { Alert, Badge, ProgressBar, StatusMessage, ThemeProvider } from "@inkjs/ui";
import { Box, renderToString, Text } from "ink";
import { type FC, createElement as h, type ReactNode } from "react";
import { PALETTE } from "../palette.ts";
import { mark, width } from "../panel.ts";
import { ICONS } from "./icons.ts";
import { earth } from "./theme.ts";

/** Color only when both stdout and stderr are terminals (the same condition as panel.ts mark). In pipes an AI reads it, so no decoration */
const colored = () => Boolean(process.stdout.isTTY && process.stderr.isTTY) && !process.env.NO_COLOR;

/** Wrap at the terminal width in a terminal. Never wrap in pipes (a path or URL cut midway cannot be rejoined by the reader) */
const columns = () => (process.stdout.isTTY ? Math.max(40, process.stdout.columns ?? 100) : 10_000);

// Render with the theme so @inkjs/ui parts use the earth tones too
const draw = (node: ReactNode): string =>
  renderToString(part(ThemeProvider, { theme: earth }, node), { columns: columns() });

/**
 * Joins into one line. Control characters are kept — dropping them would remove the ESC of the mark color (panel.ts mark) and leave `[32m`.
 * Callers pass outside text through plain / inline first.
 */
const oneLine = (text: string) => text.replace(/\r\n?|[\n\v\f\u0085\u2028\u2029]/g, " ");

/**
 * A heading. In a terminal it is boxed with rounded corners, with the summary (meta) dimmed beside it and a blank line after.
 * In pipes it is one `✦ <text>` line (the summary goes to the closing line; an AI reads it, and box characters only add length).
 */
export function title(text: string, meta?: string): string {
  const t = oneLine(text);
  if (!colored()) return draw(h(Text, null, `✦ ${t}`));
  const name = `${ICONS.brand} ${t}`;
  const extra = meta ? `  ${oneLine(meta)}` : "";
  // The box fits the content; wider than the terminal, it stops at the terminal width and trims the summary (a wider box wraps and breaks)
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

/** A section heading (indented like the content, in bold) */
export function section(text: string): string {
  return draw(h(Box, { paddingLeft: 2 }, h(Text, { bold: true }, oneLine(text))));
}

/** A line starting with a mark (panel.ts mark; a color control sequence may precede it). Has columns such as label, version, value */
// biome-ignore lint/suspicious/noControlCharactersInRegex: skips the color control sequence before the mark
const MARKED = /^(?:\u001b\[[0-9;]*m)*[✓△✗○](?:\u001b\[[0-9;]*m)* /;

/**
 * Content lines. Every line is indented by 2 or more. Leading spaces become padding, so lines wrapped at the terminal width align
 * with the start of that line's text (as plain spaces, the wrapped second line returns to column 2 and loses its item). In lines
 * starting with a mark, two or more spaces separate columns, and wrapping happens inside the last column (the value). Blank lines stay blank
 */
/** When Ink wraps at a space it keeps that space at the start of the next line (wrap-ansi trim: false). Drop one to align with the column */
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
        // The value column starts where a value without spaces would continue in the same layout (symbol widths are not counted by hand)
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

/** The closing line. It is the only line at column 0, so newlines are collapsed into one line (no forged lines). A blank line precedes it in terminals */
export function closing(text: string): string {
  const line = draw(h(Text, { bold: true }, oneLine(text)));
  return colored() ? `\n${line}` : line;
}

/** One block of heading, content, and closing */
export function panel(head: string, lines: string[], end: string): string {
  return document(head, undefined, lines.length ? [{ kind: "lines", lines }] : [], end);
}

/** One item in a document: Badge (color from palette.ts kindColor), title, body, and sources (each dimmed on its own line, never cut) */
export type Card = { badge?: { text: string; color: string }; title: string; body?: string; meta?: string[] };

/**
 * Document sections. Terminals draw them with parts; pipes print indented text. Outside text only goes inside boxes, cells, or indentation.
 *   lines indented lines / table a table / cards items with a Badge / fields labels and values / meter a ratio bar / note one line with a mark
 */
export type Block =
  | { kind: "lines"; lines: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "cards"; items: Card[] }
  | { kind: "fields"; rows: [string, string][] }
  | { kind: "meter"; label: string; ratio: number; text: string }
  | { kind: "note"; tone: "info" | "warning" | "error" | "success"; text: string };

/** A document of heading, sections, and closing. Terminals put a blank line between sections */
export function document(head: string, meta: string | undefined, blocks: Block[], end: string): string {
  const fancy = colored();
  const body = blocks.map((b) => (fancy ? drawBlock(b) : plainBlock(b)));
  return [title(head, meta), ...(fancy ? [body.join("\n\n")] : body), closing(end)]
    .filter((x) => x !== "")
    .join("\n");
}

/** A failure document. Terminals show the reason in a red box (Alert, which adds the mark); pipes print the indented reason and a `✗ Stopped` line at column 0 */
export function failure(head: string, reason: string): string {
  if (!colored()) return [title(head), indent(reason), closing(`${mark("fail")} Stopped`)].join("\n");
  return [
    title(head),
    draw(
      h(
        Box,
        { paddingLeft: 2, flexDirection: "column" },
        part(Alert, { variant: "error", title: "Stopped" }, reason),
      ),
    ),
  ].join("\n");
}

const cell = (text: string) => oneLine(text).trim();

/** @inkjs/ui parts type children as a required prop, so children are passed in props */
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
      // Every column but the last is as wide as its longest cell (up to 40). The last column is cut to the remaining width
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
      // The Badge sits in the left column and the title, body, and sources align in the right column (wrapped lines stay clear of the Badge)
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
          // The bar shrinks to the terminal width (a fixed width pushes the heading and bar onto the next line in narrow terminals)
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
            indent(`${c.badge ? `[${cell(c.badge.text)}] ` : ""}${cell(c.title)}`),
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

/** One step of a command to run. after is what to do once it has run */
export type Step = { who: string; command: string; after: string | null };

/**
 * Steps of commands to run. Terminals draw a rounded box with each command on one colored line (so it can be copied as is).
 * Pipes print an indented list without a box (an AI reads it, and box characters only add length).
 */
export function steps(heading: string, items: Step[], note: string): string {
  // No box when a command does not fit on one line inside it (indent 4, box and padding 4, item indent 2). Ink would wrap the
  // command at the box width and a copy would be cut. The boxless form skips Ink and lets the terminal wrap (a copy stays one line)
  const room = columns() - 10;
  if (!colored() || items.some((x) => width(x.command) > room))
    return [
      `    ${oneLine(heading)}:`,
      ...items.map((x) => `      ${x.who}: ${x.command}${x.after ? `, then ${x.after}` : ""}`),
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
            ? h(Box, { paddingLeft: 2 }, h(Text, { dimColor: true, wrap: "wrap" }, `Then: ${x.after}`))
            : null,
        ),
      ),
      h(Box, { marginTop: 1 }, h(Text, { dimColor: true, wrap: "wrap" }, note)),
    ),
  );
}
