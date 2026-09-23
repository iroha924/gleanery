// AI の応答（Markdown）を、端末の幅に合わせた ANSI の文字列にする。Ink の <Text> へそのまま渡す。
// marked-terminal 7.3.0 の peer は marked <16 だが、18 を入れている（.agents/skills/tui/SKILL.md）。壊れたら test/tui.test.ts が落ちる。

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
    // 折り返しは Ink に任せる。marked-terminal は文字数で折るので、日本語の段落が幅の 2 倍の行になり、Ink が二重に折る。
    // 既定の色（見出しが緑、表の見出しが赤、code が黄）は画面の色の意味（採る・避ける・止まっている）とぶつかるので、
    // 意味を持たない太字・下線・薄字に寄せる
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
      // 詰めた箇条書きの中身は text の token で来るが、marked-terminal の text は中の inline の token を読まず、
      // `**強調**` やリンクの記法が文字のまま残る。inline の token を持つときだけ描かせ、それ以外は marked-terminal に任せる
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: 描画器が付けた色（SGR）の列だけを見分ける
const SGR = /(\u001b\[[0-9;]*m)/;

/** 文字を隠す・点滅させる指定（8 / 28 / 5 / 6）。色や太字と違い、見えない文を作れる */
const HIDING = new Set(["5", "6", "8", "28"]);

/**
 * 描画器が付けた色だけを残し、ほかの制御文字を落とす。Markdown は文字参照（&#13; など）を戻すので、
 * 入力を plain に通しても、描いた後に CR や ESC が生まれうる。
 */
function colorsOnly(s: string): string {
  return s
    .split(SGR)
    .map((part, i) => {
      if (i % 2 === 0) return plain(part).replace(/\t/g, "  ");
      const params = part.slice(2, -1).split(";");
      // 38 / 48 の後ろは色の番号や RGB の値なので、指定として読まない
      for (let j = 0; j < params.length; j++) {
        const x = params[j] ?? "";
        if (x === "38" || x === "48") j += params[j + 1] === "5" ? 2 : 4;
        else if (HIDING.has(x)) return "";
      }
      return part;
    })
    .join("");
}
