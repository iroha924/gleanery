// 人へ出す表示の形。見出しは ✦、中身は行頭の │、締めは ╰─。フックの表示と CLI はこの形で出し、Skill の報告も同じ
// 見出しと印でそろえる。右端を持たないのは、フックからは画面の幅が分からず、決め打ちの幅だと狭い画面で崩れるため。
// 人も AI も読む CLI の出力（search・check・trace check / save）もこの形にする。AI だけが読む MCP の結果と
// trace context はこの形にしない。

import { styleText } from "node:util";

/** ✓ 良い・△ 見る・✗ 壊れている・○ 情報（無い・不明・待っているだけ）。review の台帳の 4 状態も同じ印を使う。 */
export type Mark = "ok" | "warn" | "fail" | "none";

// review Skill の台帳が同じ印を書く（Skill からはこのファイルを読めない）。scripts/check-pairs.mjs が突き合わせる。
const MARKS = {
  ok: ["✓", "green"],
  warn: ["△", "yellow"],
  fail: ["✗", "red"],
  none: ["○", "gray"],
} as const;

/**
 * 色は標準出力と標準エラーの両方が端末で、NO_COLOR が無いときだけ付ける。どちらかをファイルやパイプへ流したら、
 * どちらの行にも付けない（styleText の判定は 1 本の出力先しか見ないので、ここで両方を見る）。
 */
const colored = (): boolean => Boolean(process.stdout.isTTY && process.stderr.isTTY) && !process.env.NO_COLOR;

export const mark = (m: Mark): string =>
  colored() ? styleText(MARKS[m][1], MARKS[m][0], { validateStream: false }) : MARKS[m][0];

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
 * 外から来た文字（PR・issue の本文、DB に残ったエラー文）を枠の中へ出せる形にする。CR で行頭の │ を上書きしたり、
 * 制御文字で端末を乱したりさせない。改行（CR・VT・FF・NEL・行区切り）は LF にし、制御文字と書式文字を落とす。
 * 書式文字には見えないもの（タグ文字・ゼロ幅・双方向の制御）があり、端末の人に見えない指示をエージェントへ届けられる。
 * 旗の絵文字やソフトハイフンも崩れるが、落とす側を取る。文字の結合に要る ZWJ・ZWNJ だけ残す。
 */
export const plain = (s: string): string =>
  s.replace(/\r\n?|[\v\f\u0085\p{Zl}\p{Zp}]/gu, "\n").replace(/(?![\t\n\u200c\u200d])[\p{Cc}\p{Cf}]/gu, "");

/**
 * 端末での表示幅の近似。U+00FF を超える文字を 2 桁と数えるので、全角は合い、ラテン拡張や記号は多めに数える
 * （列が少しずれるだけ）。length と padEnd は全角も 1 桁に数えるので、全角の混じる列がずれる。
 */
export const width = (text: string): number =>
  [...text].reduce((w, c) => w + ((c.codePointAt(0) ?? 0) > 0xff ? 2 : 1), 0);

export const pad = (text: string, to: number): string => text + " ".repeat(Math.max(1, to - width(text)));
