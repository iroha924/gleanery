// 人へ出す表示の形。見出しは ✦、中身は行頭の │、締めは ╰─。フックの表示・CLI・Skill の報告で同じ形を使う。
// 右端を持たないのは、フックからは画面の幅が分からず、決め打ちの幅だと狭い画面で折り返して崩れるため。
// MCP の結果と trace context は AI が読むものなので、この形にしない。

import { styleText } from "node:util";

/** ✓ 良い・△ 見る・✗ 壊れている・○ 無い／不明。review の台帳（実行・打ち切り・不能・未実行）とも同じ印を使う。 */
export type Mark = "ok" | "warn" | "fail" | "none";

const MARKS = {
  ok: ["✓", "green"],
  warn: ["△", "yellow"],
  fail: ["✗", "red"],
  none: ["○", "gray"],
} as const;

/** 色は端末へ出すときだけ付く（styleText が出力先と NO_COLOR を見る。launchd のログやフックには付かない）。 */
export const mark = (m: Mark, stream: NodeJS.WriteStream = process.stdout): string =>
  styleText(MARKS[m][1], MARKS[m][0], { stream });

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

/** 端末での表示幅（全角は 2 桁）。length と padEnd は全角も 1 桁に数えるので列がずれる。 */
export const width = (text: string): number =>
  [...text].reduce((w, c) => w + ((c.codePointAt(0) ?? 0) > 0xff ? 2 : 1), 0);

export const pad = (text: string, to: number): string => text + " ".repeat(Math.max(1, to - width(text)));
