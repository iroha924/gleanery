import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { render as inkRender } from "ink";
import { render } from "ink-testing-library";
import { createElement as h } from "react";
import { width } from "../src/panel.ts";
import type { Hit } from "../src/search.ts";
import type { SessionDetail, SessionRow } from "../src/sessions.ts";
import { App, helpLines } from "../src/tui/app.ts";
import type { Data } from "../src/tui/data.ts";
import { ICONS, TWINKLE } from "../src/tui/icons.ts";
import { renderMarkdown } from "../src/tui/markdown.ts";

const at = new Date("2026-09-20T01:00:00Z");
const tick = () => new Promise((r) => setTimeout(r, 40));

/**
 * Waits until the loading indicator is gone (up to 5 seconds). A fixed wait is too short in CI, where the first render is slow
 * (measured: on GitHub Actions only the first test failed while still loading)
 */
async function settle(r: { lastFrame?: () => string | undefined; frame?: () => string }): Promise<void> {
  const frame = () => r.lastFrame?.() ?? r.frame?.() ?? "";
  await tick();
  for (let i = 0; i < 125 && /Loading/.test(frame()); i++) await tick();
}
const ESC = "\u001b";
const TAB = "\t";
const ENTER = "\r";

test("icons are standard Unicode characters that render without a Nerd Font", () => {
  for (const [name, g] of [...Object.entries(ICONS), ...TWINKLE.map((t, i) => [`twinkle${i}`, t] as const)]) {
    const c = g.codePointAt(0) ?? 0;
    assert.equal([...g].length, 1, `${name} is one character`);
    // Private use areas (U+E000 to U+F8FF, U+F0000 and up) show as □ without a font that has the glyph
    assert.ok(
      !(c >= 0xe000 && c <= 0xf8ff) && c < 0xf0000,
      `${name} U+${c.toString(16)} is in a private use area`,
    );
    // Characters drawn as emoji take two columns and their color is up to the terminal
    assert.doesNotMatch(g, /\p{Emoji_Presentation}/u, `${name} is drawn as emoji`);
  }
  // Work states do not overlap, except that blocked and avoid share ✕
  const codes = Object.entries(ICONS)
    .filter(([name]) => name !== "blocked")
    .map(([, g]) => g);
  assert.equal(new Set(codes).size, codes.length);
});

test("renders Markdown for the terminal (marked 18 with marked-terminal 7.3.0)", () => {
  const out = renderMarkdown(
    [
      "## 見出し",
      "",
      "本文の **強調** と `schema.sql`。",
      "",
      "- 箇条の一つ目",
      "- 二つ目",
      "",
      "| 列A | 列B |",
      "|---|---|",
      "| 日本語 | abc |",
      "",
      "```ts",
      "const x: number = 1;",
      "```",
    ].join("\n"),
    60,
  );
  // Color depends on the terminal, so strip it and check the content
  const plain = stripVTControlCharacters(out);
  for (const s of ["見出し", "強調", "schema.sql", "箇条の一つ目", "日本語", "abc", "const x: number = 1;"])
    assert.ok(plain.includes(s), `${s} is missing:\n${plain}`);
  assert.ok(!plain.includes("**強調**"), "bold markers remain");
  assert.ok(!plain.includes("## 見出し"), "heading ## remains");
  assert.ok(plain.includes("┌") && plain.includes("┘"), "table is not drawn with box lines");
});

test("renders bold, links, and code inside list items (no raw markup left)", () => {
  const plain = stripVTControlCharacters(
    renderMarkdown("- **強い** と [リンク](http://x) と `code`\n- 二つ目", 60),
  );
  assert.ok(!plain.includes("**強い**"), plain);
  assert.ok(!plain.includes("[リンク](http://x)"), plain);
  assert.ok(!plain.includes("`code`"), plain);
  assert.ok(plain.includes("強い") && plain.includes("リンク") && plain.includes("code"), plain);
});

test("does not wrap a Japanese paragraph in Markdown (Ink wraps at the terminal width)", () => {
  const paragraph = "端末の幅は全角で数える。".repeat(20);
  const out = stripVTControlCharacters(renderMarkdown(paragraph, 30));
  assert.equal(out.trim().split("\n").length, 1, `paragraph was wrapped by character count:\n${out}`);
});

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: "00000000-0000-4000-8000-000000000001",
  origin: "claude-code",
  sessionId: "s1",
  branch: "main",
  startedAt: at,
  project: "o/r",
  lastAt: at,
  title: "認証を直すセッション",
  said: 3,
  traced: 1,
  files: 2,
  ...over,
});

const detail: SessionDetail = {
  id: "00000000-0000-4000-8000-000000000001",
  origin: "claude-code",
  sessionId: "s1",
  branch: "main",
  startedAt: at,
  projectId: 1,
  project: "o/r",
  projectKey: "git:github.com/o/r",
  title: "認証を直すセッション",
  messages: [
    {
      id: "m1",
      speaker: "self",
      body: "認証を直して",
      sentAt: at,
      truncated: false,
      originalBytes: 18,
      files: [],
    },
    {
      id: "m2",
      speaker: "assistant",
      body: "直した。**トークン**の期限を見る。",
      sentAt: at,
      truncated: false,
      originalBytes: 40,
      files: [{ path: "src/auth.ts", action: "edit" }],
    },
  ],
  knowledge: [
    {
      id: 5,
      kind: "decision",
      status: "accepted",
      stance: "do",
      body: "期限はサーバーで見る",
      reason: "端末の時計は信用しない",
      confirmation: null,
      downsides: [],
      at,
      decisionId: null,
      label: "[decision]",
    },
  ],
  work: [],
};

const hit: Hit = {
  ref: "k:9",
  kind: "decision",
  status: "accepted",
  stance: "do",
  label: "[decision]",
  heading: null,
  text: "期限はサーバーで見る",
  reason: null,
  confirmation: null,
  downsides: [],
  successor: null,
  project: "o/r",
  at,
  speaker: null,
  context: null,
  url: null,
  path: null,
  truncated: false,
  originalBytes: null,
};

function fake(over: Partial<Data> = {}): Data & { searched: string[] } {
  const searched: string[] = [];
  return {
    searched,
    here: { project: 1, name: "o/r" },
    projects: async () => [
      { id: 1, key: "git:github.com/o/r", name: "o/r", sessions: 1, knowledge: 1, connectors: [] },
    ],
    sessions: async () => ({ items: [session()], total: 1, page: 1, pageSize: 50, pages: 1 }),
    session: async () => detail,
    works: async () => ({
      more: false,
      items: [
        {
          ref: "w:3",
          project: "o/r",
          title: "認証の作り直し",
          goal: "期限切れで落ちない",
          current: "サーバー側を直した",
          next: ["端末側の表示"],
          status: "active",
          updatedAt: at,
        },
      ],
    }),
    work: async () => ({
      ref: "w:3",
      project: "o/r",
      title: "認証の作り直し",
      goal: "期限切れで落ちない",
      current: "サーバー側を直した",
      next: ["端末側の表示"],
      status: "active",
      updatedAt: at,
      questions: [],
      walls: [
        {
          ...hit,
          ref: "k:10",
          kind: "dead_end",
          stance: "dont",
          label: "[dead end]",
          text: "端末の時計で判定",
        },
      ],
    }),
    search: async (q) => {
      searched.push(q);
      return [hit];
    },
    read: async (ref) => `${ref} の全文\n二行目`,
    ...over,
  };
}

test("lists sessions, opens details with Enter, and goes back with Esc", async () => {
  const r = render(h(App, { data: fake() }));
  await settle(r);
  assert.match(r.lastFrame() ?? "", /認証を直すセッション/);
  assert.match(r.lastFrame() ?? "", /1 session\b/);
  r.stdin.write(ENTER);
  await settle(r);
  const frame = r.lastFrame() ?? "";
  assert.match(frame, /認証を直して/);
  assert.match(frame, /トークン/);
  assert.doesNotMatch(frame, /\*\*トークン\*\*/, "Markdown in the AI reply is not rendered");
  assert.match(frame, /src\/auth\.ts/);
  assert.match(frame, /\[decision\] 期限はサーバーで見る/);
  r.stdin.write(ESC);
  await settle(r);
  assert.match(r.lastFrame() ?? "", /1 session\b/);
  r.unmount();
});

test("shows loading, empty, and failed states", async () => {
  let resolve: (v: Awaited<ReturnType<Data["sessions"]>>) => void = () => {};
  const pending = render(h(App, { data: fake({ sessions: () => new Promise((r) => (resolve = r)) }) }));
  await tick();
  assert.match(pending.lastFrame() ?? "", /Loading sessions/);
  resolve({ items: [], total: 0, page: 1, pageSize: 50, pages: 0 });
  await tick();
  assert.match(pending.lastFrame() ?? "", /No recorded sessions/);
  pending.unmount();

  const failed = render(
    h(App, { data: fake({ sessions: async () => Promise.reject(new Error("接続できない")) }) }),
  );
  await tick();
  assert.match(failed.lastFrame() ?? "", /Could not read sessions: 接続できない/);
  failed.unmount();
});

test("shows when the work list is cut at the limit", async () => {
  const base = await fake().works(1);
  const r = render(h(App, { data: fake({ works: async () => ({ ...base, more: true }) }) }));
  await settle(r);
  r.stdin.write(TAB);
  await settle(r);
  const frame = r.lastFrame() ?? "";
  assert.match(frame, /認証の作り直し/);
  assert.match(frame, /Latest 1 \(older work omitted\)/);
  r.unmount();
});

test("Tab moves to the work screen, and opening work shows paths not to take", async () => {
  const r = render(h(App, { data: fake() }));
  await settle(r);
  r.stdin.write(TAB);
  await settle(r);
  assert.match(r.lastFrame() ?? "", /認証の作り直し/);
  r.stdin.write(ENTER);
  await settle(r);
  const frame = r.lastFrame() ?? "";
  assert.match(frame, /Goal: 期限切れで落ちない/);
  assert.match(frame, /端末側の表示/);
  assert.match(frame, /\[dead end\] 端末の時計で判定/);
  r.unmount();
});

test("/ opens search, Enter runs it, and opening a result reads the full text", async () => {
  const data = fake();
  const r = render(h(App, { data }));
  await settle(r);
  r.stdin.write("/");
  await settle(r);
  r.stdin.write("期限");
  await settle(r);
  r.stdin.write(ENTER);
  await settle(r);
  assert.deepEqual(data.searched, ["期限"]);
  assert.match(r.lastFrame() ?? "", /\[decision\] 期限はサーバーで見る/);
  r.stdin.write(ENTER);
  await settle(r);
  assert.match(r.lastFrame() ?? "", /k:9 の全文/);
  r.unmount();
});

test("going back from details with Esc keeps the query, results, and selected row", async () => {
  const data = fake({
    sessions: async () => ({
      items: [
        session(),
        session({ id: "00000000-0000-4000-8000-000000000002", title: "二つ目のセッション" }),
      ],
      total: 2,
      page: 1,
      pageSize: 50,
      pages: 1,
    }),
  });
  const r = render(h(App, { data }));
  await settle(r);
  r.stdin.write("j");
  await settle(r);
  r.stdin.write(ENTER);
  await settle(r);
  r.stdin.write(ESC);
  await settle(r);
  assert.match(r.lastFrame() ?? "", /❯ 二つ目のセッション/);

  r.stdin.write("/");
  await settle(r);
  r.stdin.write("期限");
  await settle(r);
  r.stdin.write(ENTER);
  await settle(r);
  r.stdin.write(ENTER);
  await settle(r);
  r.stdin.write(ESC);
  await settle(r);
  assert.match(r.lastFrame() ?? "", /"期限"/);
  assert.match(r.lastFrame() ?? "", /期限はサーバーで見る/);
  assert.deepEqual(data.searched, ["期限"], "going back ran the search again");
  r.unmount();
});

test("does not scroll past the end of the text (the screen never goes blank)", async () => {
  const long = Array.from({ length: 80 }, (_, i) => `行 ${i}`).join("\n");
  const r = renderAt(60, 16, fake({ read: async () => long }));
  await settle(r);
  for (const key of ["/", "期限", ENTER, ENTER, "G"]) {
    r.write(key);
    await settle(r);
  }
  for (let i = 0; i < 10; i++) {
    r.write("j");
    await settle(r);
  }
  const frame = r.frame();
  assert.match(frame, /行 79/, frame);
  assert.match(frame, /行 72/, `after reaching the end, the text should still fill the screen:\n${frame}`);
  r.unmount();
});

// A deleted record, or one outside the chosen projects, shows the same not-found message as session and work details, not as body text.
test("shows not found when the full text is missing", async () => {
  const r = renderAt(60, 16, fake({ read: async () => null }));
  await settle(r);
  for (const key of ["/", "期限", ENTER, ENTER]) {
    r.write(key);
    await settle(r);
  }
  const frame = r.frame();
  assert.ok(
    frame
      .replace(/\s+/g, " ")
      .includes("This record does not exist (it was deleted, or it is outside the selected project)"),
    frame,
  );
  r.unmount();
});

test("q while typing is entered as text and does not quit", async () => {
  const data = fake();
  const r = render(h(App, { data }));
  await settle(r);
  r.stdin.write("/");
  await settle(r);
  r.stdin.write("q");
  await settle(r);
  r.stdin.write(ENTER);
  await settle(r);
  assert.deepEqual(data.searched, ["q"]);
  r.unmount();
});

/** Renders at a fixed terminal size. ink-testing-library cannot set the size, so pass Ink a fake stdout and stdin. */
function renderAt(columns: number, rows: number, data: Data) {
  const out = Object.assign(new EventEmitter(), {
    columns,
    rows,
    isTTY: true,
    frames: [] as string[],
    write(s: string) {
      out.frames.push(s);
      return true;
    },
  });
  let pending: string | null = null;
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {},
    setEncoding() {},
    resume() {},
    pause() {},
    ref() {},
    unref() {},
    read: () => {
      const d = pending;
      pending = null;
      return d;
    },
  });
  const app = inkRender(h(App, { data }), {
    stdout: out as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    write(d: string) {
      pending = d;
      stdin.emit("readable");
      stdin.emit("data", d);
    },
    // Take the last frame with the border so the cleanup output from unmount is not picked up
    frame: () => out.frames.findLast((f) => f.includes("╭")) ?? "",
    unmount: () => app.unmount(),
  };
}

async function frameAt(columns: number, rows: number, data: Data): Promise<string> {
  const r = renderAt(columns, rows, data);
  await settle(r);
  const frame = r.frame();
  r.unmount();
  return frame;
}

test("the top box stays 3 lines on a narrow terminal and the screen fits the terminal height", async () => {
  const many = fake({
    here: { project: 1, name: "iroha924/sphica" },
    projects: async () => [
      {
        id: 1,
        key: "git:github.com/iroha924/sphica",
        name: "iroha924/sphica",
        sessions: 1,
        knowledge: 1,
        connectors: [],
      },
    ],
  });
  for (const columns of [40, 60, 120]) {
    const lines = (await frameAt(columns, 10, many)).split("\n");
    assert.equal(lines.length, 10, `${columns} columns gave ${lines.length} lines`);
    assert.match(lines[0] ?? "", /^╭/, `${columns} columns pushed out the top border`);
    assert.match(lines[2] ?? "", /^╰/, `${columns} columns: the top box is not 3 lines`);
    assert.match(lines.slice(8).join("\n"), /q quit/, `${columns} columns cut off the quit hint`);
  }
  // At 80 columns the help splits into 2 lines and no key is cut off
  const at80 = (await frameAt(80, 12, many)).split("\n");
  assert.equal(at80.length, 12);
  const help = at80.slice(10).join("\n");
  for (const key of ["q quit", "/ search", "g G ends", "p project"])
    assert.ok(help.includes(key), `${key} is not visible at 80 columns\n${help}`);
});

// When 2 help lines would leave fewer than 3 list rows, the help goes back to 1 line and the selected row stays on screen.
test("the selected row stays visible after jumping to an end on a short terminal", async () => {
  const many = fake({
    sessions: async () => ({
      items: Array.from({ length: 30 }, (_, i) =>
        session({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, title: `題 ${i}` }),
      ),
      total: 30,
      page: 1,
      pageSize: 50,
      pages: 1,
    }),
  });
  for (const rows of [6, 7]) {
    const r = renderAt(60, rows, many);
    await settle(r);
    r.write("G");
    await settle(r);
    const frame = r.frame();
    assert.equal(frame.split("\n").length, rows, frame);
    assert.match(frame, /❯/, `selected row not visible at ${rows} rows:\n${frame}`);
    r.unmount();
  }
});

test("switching projects reloads the session list from the first page", async () => {
  const pages: [number | null, number][] = [];
  const data = fake({
    here: { project: null, name: null },
    sessions: async (project, page) => {
      pages.push([project, page]);
      const total = project === null ? 120 : 3;
      const all = Array.from({ length: total }, (_, i) =>
        session({
          id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          title: `題 ${project ?? "全部"} ${i}`,
        }),
      );
      return {
        items: all.slice((page - 1) * 50, page * 50),
        total,
        page,
        pageSize: 50,
        pages: Math.ceil(total / 50),
      };
    },
  });
  const r = render(h(App, { data }));
  await settle(r);
  r.stdin.write("l");
  await settle(r);
  r.stdin.write("l");
  await settle(r);
  assert.match(r.lastFrame() ?? "", /page 3\/3/);
  r.stdin.write("p");
  await settle(r);
  assert.deepEqual(pages.at(-1), [1, 1]);
  assert.match(r.lastFrame() ?? "", /題 1 0/);
  assert.doesNotMatch(r.lastFrame() ?? "", /No recorded sessions/);
  r.unmount();
});

test("box characters in AI reply prose do not cut a paragraph to one line (only table rows are cut)", async () => {
  const long = "左の `│` と締めの `╰─` をやめ、中身は字下げする。".repeat(6);
  const data = fake({
    session: async () => ({
      ...detail,
      messages: [{ ...detail.messages[1], id: "m9", body: long } as SessionDetail["messages"][number]],
    }),
  });
  const r = render(h(App, { data }));
  await settle(r);
  r.stdin.write(ENTER);
  await settle(r);
  const frame = r.lastFrame() ?? "";
  // If the last of the 6 repeated sentences shows, the paragraph was wrapped
  assert.equal(frame.split("中身は字下げする").length - 1, 6, frame);
  r.unmount();
});

test("a table in an AI reply wider than the terminal is cut per row instead of wrapped (box lines stay intact)", async () => {
  const wide = "とても長い列の中身".repeat(8);
  const table = `| 列A | 列B |\n|---|---|\n| ${wide} | ${wide} |\n`;
  const data = fake({
    session: async () => ({
      ...detail,
      messages: [{ ...detail.messages[1], id: "m8", body: table } as SessionDetail["messages"][number]],
    }),
  });
  const r = render(h(App, { data }));
  await settle(r);
  r.stdin.write(ENTER);
  await settle(r);
  const lines = stripVTControlCharacters(r.lastFrame() ?? "")
    .split("\n")
    .filter((l) => /[┌├└│]/.test(l) && !/^[│╭╰]/.test(l));
  assert.ok(lines.length >= 5, lines.join("\n"));
  for (const line of lines) assert.match(line.trim(), /^[┌├└│]/, `a table row wrapped:\n${lines.join("\n")}`);
  r.unmount();
});

test("the read failure for the project list is visible on a narrow terminal", async () => {
  const data = fake({ projects: async () => Promise.reject(new Error("接続できない")) });
  for (const columns of [50, 80]) {
    const frame = await frameAt(columns, 12, data);
    assert.match(frame.split("\n")[1] ?? "", /Could not read the project list/, frame);
  }
});

// A question with no searchable terms (only hiragana) returns 0 hits without searching. Saying "no matches" would read as "none exist".
test("a question with no searchable terms shows a different message from no matches", async () => {
  const data = fake({ search: async () => [] });
  const r = render(h(App, { data }));
  await settle(r);
  r.stdin.write("/");
  await settle(r);
  r.stdin.write("やめた");
  await settle(r);
  r.stdin.write(ENTER);
  await settle(r);
  assert.match(r.lastFrame() ?? "", /No searchable terms/);
  r.stdin.write(ESC);
  await settle(r);
  r.stdin.write("/");
  await settle(r);
  r.stdin.write("期限");
  await settle(r);
  r.stdin.write(ENTER);
  await settle(r);
  assert.match(r.lastFrame() ?? "", /No matches/);
  r.unmount();
});

// Even at narrow widths the help fits the line count and width without splitting a key from its label (pairs that do not fit drop from the end).
test("the key help fits the lines and width at every width without splitting pairs", () => {
  const items = [
    "q 終わる",
    "Enter 開く",
    "↑↓ j k 選ぶ",
    "PgUp PgDn めくる",
    "Tab S-Tab 画面",
    "/ 検索",
    "g G 端へ",
  ];
  for (let columns = 1; columns <= 120; columns++)
    for (const lines of [1, 2]) {
      const out = helpLines(items, columns, lines);
      assert.ok(out.length <= lines, `${columns}: ${out.length} lines`);
      for (const line of out) assert.ok(width(line) <= columns, `${columns}: ${line}`);
      for (const line of out)
        for (const pair of line.split("  ")) assert.ok(items.includes(pair), `${columns}: ${pair}`);
    }
});

// Third parties can write recorded PR and issue bodies and conversations. Printing terminal control sequences would let them rewrite the screen.
const HOSTILE = "\u001b[2J\u001b]0;pwn\u0007\r偽の行";
const hostile = (s: string) => `${s}${HOSTILE}`;
/** Whether an injected control sequence remains. Ink adds ESC for colors (SGR), so only other sequences count */
const controlled = (frame: string) =>
  ["\u001b[2J", "\u001b]", "\u0007", "\r", "\u001b[8m"].some((c) => frame.includes(c));

test("no screen prints control sequences from external text", async () => {
  const works = await fake().works(1);
  const work = await fake().work("w:3", 1);
  const data = fake({
    projects: async () => [
      { id: 1, key: "git:github.com/o/r", name: hostile("o/r"), sessions: 1, knowledge: 1, connectors: [] },
    ],
    sessions: async () => ({
      items: [session({ title: hostile("題") })],
      total: 1,
      page: 1,
      pageSize: 50,
      pages: 1,
    }),
    session: async () => ({
      ...detail,
      title: hostile("題"),
      project: hostile("o/r"),
      branch: hostile("main"),
      messages: detail.messages.map((m) => ({
        ...m,
        // Markdown decodes character references, so control characters can appear after rendering
        body: `${hostile(m.body)} &#13;偽の行 &#27;[2J &#27;[8m隠した文字`,
        files: m.files.map((f) => ({ ...f, path: hostile(f.path) })),
      })),
      knowledge: detail.knowledge.map((k) => ({ ...k, body: hostile(k.body) })),
    }),
    works: async () => ({
      ...works,
      items: works.items.map((w) => ({ ...w, title: hostile(w.title), current: hostile(w.current) })),
    }),
    work: async () =>
      work && {
        ...work,
        title: hostile(work.title),
        project: hostile(work.project),
        goal: hostile(work.goal),
        current: hostile(work.current),
        next: work.next.map(hostile),
        walls: work.walls.map((x) => ({ ...x, text: hostile(x.text) })),
      },
    search: async () => [
      {
        ...hit,
        text: hostile(hit.text),
        project: hostile("o/r"),
        url: "https://example.invalid/\u0007\u001b[2J",
      },
    ],
    read: async (ref) => hostile(`${ref} の全文`),
  });
  const r = render(h(App, { data }));
  const frames: string[] = [];
  const see = async () => {
    await settle(r);
    frames.push(r.lastFrame() ?? "");
  };
  await see();
  r.stdin.write(ENTER);
  await see();
  r.stdin.write(ESC);
  await see();
  r.stdin.write(TAB);
  await see();
  r.stdin.write(ENTER);
  await see();
  r.stdin.write(ESC);
  await see();
  r.stdin.write("/");
  await see();
  r.stdin.write("期限");
  await see();
  r.stdin.write(ENTER);
  await see();
  r.stdin.write(ENTER);
  await see();
  r.unmount();
  // Each screen actually opened (otherwise the absence of control sequences proves nothing)
  for (const [i, want] of [
    [0, "題"],
    [1, "src/auth.ts"],
    [3, "認証の作り直し"],
    [4, "Goal"],
    [8, "期限はサーバーで見る"],
    [9, "k:9 の全文"],
  ] as const)
    assert.ok(frames[i]?.includes(want), `screen ${i} is missing ${want}:\n${frames[i]}`);
  assert.ok(
    frames.some((f) => f.includes("偽の行")),
    "the external text itself is shown",
  );
  for (const [i, f] of frames.entries()) assert.ok(!controlled(f), `screen ${i}`);
});

test("the error message of a failed load has no control sequences either", async () => {
  const r = render(
    h(App, { data: fake({ sessions: async () => Promise.reject(new Error(hostile("接続できない"))) }) }),
  );
  await settle(r);
  assert.match(r.lastFrame() ?? "", /接続できない/);
  assert.ok(!controlled(r.lastFrame() ?? ""));
  r.unmount();
});

test("the cut work list notice fits one line, and the selected row stays visible after jumping on a narrow terminal", async () => {
  const many = fake({
    works: async () => ({
      more: true,
      items: Array.from({ length: 100 }, (_, i) => ({
        ref: `w:${i}`,
        project: "o/r",
        title: `作業 ${i}`,
        goal: "目的",
        current: "いま",
        next: [],
        status: "active",
        updatedAt: at,
      })),
    }),
  });
  for (const [columns, rows] of [
    [40, 10],
    [50, 10],
    [40, 6],
  ] as const) {
    const r = renderAt(columns, rows, many);
    await settle(r);
    r.write(TAB);
    await settle(r);
    r.write("G");
    await settle(r);
    const frame = r.frame();
    assert.equal(frame.split("\n").length, rows, frame);
    assert.match(frame, /❯ .*作業 99/, `selected row not visible at ${columns}×${rows}:\n${frame}`);
    assert.match(frame, /older work omitted/, `cut notice not visible at ${columns}×${rows}:\n${frame}`);
    r.unmount();
  }
});
