// 人へ出す表示の形。見出しは ✦、中身は行頭の │、締めは ╰─。フックの表示と CLI はこの形で出し、Skill の報告も同じ
// 見出しと印でそろえる。右端を持たないのは、フックからは画面の幅が分からず、決め打ちの幅だと狭い画面で崩れるため。
// 人も AI も読む CLI の出力（search・check・trace check / save）もこの形にする。AI だけが読む MCP の結果と
// trace context はこの形にしない。

import { styleText } from "node:util";
import { visible } from "./text.ts";

/** ok は良い、warn は見る、fail は壊れている、none は情報（無い・不明・待っているだけ）。印の字は MARKS にだけ書く。 */
export type Mark = "ok" | "warn" | "fail" | "none";

// review Skill の台帳が同じ印を書く（Skill からはこのファイルを読めない）。scripts/check-pairs.mjs が突き合わせる。
const MARKS = {
  ok: ["✓", "green"],
  warn: ["△", "yellow"],
  fail: ["✗", "red"],
  none: ["○", "gray"],
} as const;

/**
 * 色は標準出力と標準エラーの両方が端末のときだけ付ける（どちらかをファイルやパイプへ流したら、どちらの行にも付けない）。
 * 両方が端末なら、NO_COLOR・FORCE_COLOR=0・TERM=dumb などは styleText が見る。
 */
export const mark = (m: Mark): string =>
  process.stdout.isTTY && process.stderr.isTTY
    ? styleText(MARKS[m][1], MARKS[m][0], { stream: process.stdout })
    : MARKS[m][0];

export const title = (text: string): string => `✦ ${text}`;

/** 中身の行。複数行はそれぞれに印を付け、空行は印だけにする（行末に空白を残さない）。 */
export const rule = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line ? `│ ${line}` : "│"))
    .join("\n");

export const foot = (text: string): string => `╰─ ${text}`;

export const panel = (head: string, lines: string[], end: string): string =>
  [title(head), ...lines.map(rule), foot(end)].join("\n");

/**
 * 外から来た文字（PR・issue の本文、DB に残ったエラー文）を、端末に出す枠の中へ入れられる形にする。CR で行頭の │ を
 * 上書きしたり、制御文字で端末を乱したりさせない。改行（CR・VT・FF・NEL・行区切り）は LF にし、制御文字を落とし、
 * 見えない文字を visible で落とす（端末の人に見えない文を、この出力を読むエージェントにだけ読ませない）。
 */
export const plain = (s: string): string =>
  visible(s.replace(/\r\n?|[\v\f\u0085\p{Zl}\p{Zp}]/gu, "\n").replace(/(?![\t\n])\p{Cc}/gu, ""));

/**
 * 1 行に収める文字（呼び名など）。外から来た文字を plain に通し、改行とタブを空白 1 つにする。ほかの空白（全角空白など）は
 * 保存したとおりに残す。改行・タブ・制御文字と、visible が落とす見えない文字を含まない名前なら、表示を写して --said や
 * mitos who に渡すと、保存した名前と一致する。
 */
export const inline = (s: string): string => plain(s).replace(/[\n\t]+/g, " ");

/**
 * 端末での表示幅の近似。U+00FF を超える文字を 2 桁と数えるので、全角は合い、ラテン拡張や記号は多めに数える
 * （列が少しずれるだけ）。length と padEnd は全角も 1 桁に数えるので、全角の混じる列がずれる。
 */
export const width = (text: string): number =>
  [...text].reduce((w, c) => w + ((c.codePointAt(0) ?? 0) > 0xff ? 2 : 1), 0);

export const pad = (text: string, to: number): string => text + " ".repeat(Math.max(1, to - width(text)));
