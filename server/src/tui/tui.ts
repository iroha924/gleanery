// `gleanery dashboard` の本体（端末の画面。Web の画面から移した）。CLI の出力も Ink で描くので、Ink ごと cli.js に束ねる。

import { ThemeProvider } from "@inkjs/ui";
import { render } from "ink";
import { createElement as h } from "react";
import { reason } from "../text.ts";
import { App } from "./app.ts";
import { liveData } from "./data.ts";
import { earth } from "./theme.ts";
import { part } from "./view.ts";

export async function runTui(cwd: string): Promise<void> {
  // 画面を描けない出口（pipe・CI）では起動しない。読むだけの一覧は CLI が別に持つ
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "gleanery dashboard は端末の中でだけ動く。記録を引くだけなら `gleanery search <語>` を使う。",
    );
    process.exitCode = 1;
    return;
  }
  let live: Awaited<ReturnType<typeof liveData>>;
  try {
    live = await liveData(cwd);
  } catch (e) {
    throw new Error(`DB に繋げなかった（${reason(e)}）。\`gleanery doctor\` で鍵と接続を確かめる`);
  }
  const { data, close } = live;
  try {
    // @inkjs/ui の部品（読み込みの回転など）の色もアースカラーにする
    const app = render(part(ThemeProvider, { theme: earth }, h(App, { data })), {
      alternateScreen: true,
      exitOnCtrlC: true,
    });
    await app.waitUntilExit();
  } finally {
    await close();
  }
}
