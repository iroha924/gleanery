// `gleanery dashboard` (the terminal screen, moved from the web screen). CLI output is also drawn with Ink, so Ink is bundled into cli.js.

import { ThemeProvider } from "@inkjs/ui";
import { render } from "ink";
import { createElement as h } from "react";
import { reason } from "../text.ts";
import { App } from "./app.ts";
import { liveData } from "./data.ts";
import { earth } from "./theme.ts";
import { part } from "./view.ts";

export async function runTui(cwd: string): Promise<void> {
  // Do not start where the screen cannot be drawn (pipes, CI). The CLI has separate read-only listings
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "gleanery dashboard runs only in a terminal. To look up records, use `gleanery search <terms>`.",
    );
    process.exitCode = 1;
    return;
  }
  let live: Awaited<ReturnType<typeof liveData>>;
  try {
    live = await liveData(cwd);
  } catch (e) {
    throw new Error(
      `Could not open the database (${reason(e)}). Check the DB section of \`gleanery doctor\`.`,
    );
  }
  const { data, close } = live;
  try {
    // Use the earth tones for @inkjs/ui parts (such as the loading spinner) too
    const app = render(part(ThemeProvider, { theme: earth }, h(App, { data })), {
      alternateScreen: true,
      exitOnCtrlC: true,
    });
    await app.waitUntilExit();
  } finally {
    await close();
  }
}
