// Renders AI responses (Markdown) as ANSI strings sized to the terminal. Passed straight to Ink's <Text>.
// marked-terminal 7.3.0 declares a peer of marked <16, but 18 is installed (.agents/skills/tui/SKILL.md). test/tui.test.ts fails if it breaks.

import { styleText } from "node:util";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { plain } from "../panel.ts";

const byWidth = new Map<number, Marked>();

const style = (format: Parameters<typeof styleText>[0]) => (text: string) => styleText(format, text);

export function renderMarkdown(text: string, width: number): string {
  const w = Math.max(20, Math.floor(width));
  let m = byWidth.get(w);
  if (!m) {
    // Leave wrapping to Ink. marked-terminal wraps by character count, so Japanese paragraphs become lines twice the width and Ink wraps them again.
    // The default colors (green headings, red table headers, yellow code) clash with the screen's color meanings (take, avoid, blocked),
    // so use bold, underline, and dim, which carry no meaning
    m = new Marked(
      markedTerminal({
        width: w,
        reflowText: false,
        tab: 2,
        showSectionPrefix: false,
        heading: style("bold"),
        firstHeading: style(["bold", "underline"]),
        codespan: style("underline"),
        code: (t: string) => t,
        blockquote: style(["dim", "italic"]),
        link: style("underline"),
        href: style(["dim", "underline"]),
        tableOptions: { style: { head: ["bold"], border: ["gray"] } },
      }),
      // Items in a tight list arrive as text tokens, but marked-terminal's text ignores their inline tokens and leaves
      // `**bold**` and link syntax as plain characters. Render them here only when inline tokens exist; otherwise leave it to marked-terminal
      {
        renderer: {
          text(token) {
            return "tokens" in token && token.tokens ? this.parser.parseInline(token.tokens) : false;
          },
        },
      },
    );
    byWidth.set(w, m);
  }
  const out = m.parse(text, { async: false });
  return colorsOnly(out).replace(/\n+$/, "");
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches only the color (SGR) sequences the renderer added
const SGR = /(\u001b\[[0-9;]*m)/;

/** Codes that hide or blink text (8 / 28 / 5 / 6). Unlike colors and bold, they can create invisible text */
const HIDING = new Set(["5", "6", "8", "28"]);

/**
 * Keeps only the colors the renderer added and drops other control characters. Markdown decodes character references
 * (&#13; and so on), so CR or ESC can appear after rendering even when the input went through plain.
 */
function colorsOnly(s: string): string {
  return s
    .split(SGR)
    .map((part, i) => {
      if (i % 2 === 0) return plain(part).replace(/\t/g, "  ");
      const params = part.slice(2, -1).split(";");
      // Values after 38 / 48 are color numbers or RGB values, not codes
      for (let j = 0; j < params.length; j++) {
        const x = params[j] ?? "";
        if (x === "38" || x === "48") j += params[j + 1] === "5" ? 2 : 4;
        else if (HIDING.has(x)) return "";
      }
      return part;
    })
    .join("");
}
