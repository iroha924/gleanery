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
 * 読み込み中の表示が消えるまで待つ（上限 5 秒）。決め打ちの待ち時間だと、最初の描画が遅い CI で読み込みが間に合わない
 * （実測: GitHub Actions で最初の test だけ「読んでいる…」のまま落ちた）
 */
async function settle(r: { lastFrame?: () => string | undefined; frame?: () => string }): Promise<void> {
  const frame = () => r.lastFrame?.() ?? r.frame?.() ?? "";
  await tick();
  for (let i = 0; i < 125 && /Loading/.test(frame()); i++) await tick();
}
const ESC = "\u001b";
const TAB = "\t";
const ENTER = "\r";

test("記号は Unicode の標準の文字だけで、Nerd Font が無い端末でも描ける", () => {
  for (const [name, g] of [...Object.entries(ICONS), ...TWINKLE.map((t, i) => [`twinkle${i}`, t] as const)]) {
    const c = g.codePointAt(0) ?? 0;
    assert.equal([...g].length, 1, `${name} は 1 文字`);
    // 私用領域（U+E000〜U+F8FF、U+F0000 以降）は、その字を持つフォントが無いと □ になる
    assert.ok(!(c >= 0xe000 && c <= 0xf8ff) && c < 0xf0000, `${name} U+${c.toString(16)} が私用領域`);
    // 絵文字として描かれる字は幅が 2 桁になり、色も端末任せになる
    assert.doesNotMatch(g, /\p{Emoji_Presentation}/u, `${name} が絵文字として描かれる`);
  }
  // 作業の状態は blocked と avoid が同じ ✕ を使うほかは重ならない
  const codes = Object.entries(ICONS)
    .filter(([name]) => name !== "blocked")
    .map(([, g]) => g);
  assert.equal(new Set(codes).size, codes.length);
});

test("Markdown を端末向けに描く（marked 18 と marked-terminal 7.3.0 の組み合わせ）", () => {
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
  // 色の有無は端末で変わるので、色を落として中身を見る
  const plain = stripVTControlCharacters(out);
  for (const s of ["見出し", "強調", "schema.sql", "箇条の一つ目", "日本語", "abc", "const x: number = 1;"])
    assert.ok(plain.includes(s), `${s} が出ていない:\n${plain}`);
  assert.ok(!plain.includes("**強調**"), "強調の記号が残っている");
  assert.ok(!plain.includes("## 見出し"), "見出しの ## が残っている");
  assert.ok(plain.includes("┌") && plain.includes("┘"), "表が罫線で描かれていない");
});

test("箇条書きの中の強調・リンク・code も描く（記法を文字のまま残さない）", () => {
  const plain = stripVTControlCharacters(
    renderMarkdown("- **強い** と [リンク](http://x) と `code`\n- 二つ目", 60),
  );
  assert.ok(!plain.includes("**強い**"), plain);
  assert.ok(!plain.includes("[リンク](http://x)"), plain);
  assert.ok(!plain.includes("`code`"), plain);
  assert.ok(plain.includes("強い") && plain.includes("リンク") && plain.includes("code"), plain);
});

test("日本語の段落を Markdown の側で折らない（折り返しは Ink が端末の幅で行う）", () => {
  const paragraph = "端末の幅は全角で数える。".repeat(20);
  const out = stripVTControlCharacters(renderMarkdown(paragraph, 30));
  assert.equal(out.trim().split("\n").length, 1, `段落が文字数で折られた:\n${out}`);
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
          label: "[tried and failed]",
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

test("セッションの一覧を出し、Enter で詳細、Esc で戻る", async () => {
  const r = render(h(App, { data: fake() }));
  await settle(r);
  assert.match(r.lastFrame() ?? "", /認証を直すセッション/);
  assert.match(r.lastFrame() ?? "", /1 session\b/);
  r.stdin.write(ENTER);
  await settle(r);
  const frame = r.lastFrame() ?? "";
  assert.match(frame, /認証を直して/);
  assert.match(frame, /トークン/);
  assert.doesNotMatch(frame, /\*\*トークン\*\*/, "AI の応答の Markdown が描かれていない");
  assert.match(frame, /src\/auth\.ts/);
  assert.match(frame, /\[decision\] 期限はサーバーで見る/);
  r.stdin.write(ESC);
  await settle(r);
  assert.match(r.lastFrame() ?? "", /1 session\b/);
  r.unmount();
});

test("読み込み中・空・失敗をそれぞれ出す", async () => {
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

test("作業の一覧が上限で切れたら、切れたことを画面に出す", async () => {
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

test("Tab で作業の画面へ移り、作業を開くと通ってはいけない道まで出る", async () => {
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
  assert.match(frame, /\[tried and failed\] 端末の時計で判定/);
  r.unmount();
});

test("/ で検索へ移って打ち、Enter で引き、結果を開くと全文を読む", async () => {
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

test("詳細から Esc で戻っても、検索の語と結果、一覧で選んだ行が残る", async () => {
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
  assert.deepEqual(data.searched, ["期限"], "戻っただけで引き直している");
  r.unmount();
});

test("本文の終わりを越えて下へ進まない（画面が空にならない）", async () => {
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
  assert.match(frame, /行 72/, `最後まで行った後も、画面いっぱいに本文が残る:\n${frame}`);
  r.unmount();
});

// 消えた記録や選んだプロジェクトの外の記録は、本文としてではなく、セッション・作業の詳細と同じ「無い」の表示で見せる。
test("全文の先が無ければ、無いと出す", async () => {
  const r = renderAt(60, 16, fake({ read: async () => null }));
  await settle(r);
  for (const key of ["/", "期限", ENTER, ENTER]) {
    r.write(key);
    await settle(r);
  }
  const frame = r.frame();
  assert.ok(frame.includes("This record does not exist"), frame);
  r.unmount();
});

test("打っている間の q は文字として入り、終わらない", async () => {
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

/** 端末の大きさを決めて描く。ink-testing-library は大きさを変えられないので、Ink に偽の stdout と stdin を渡す。 */
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
    // unmount の後始末の書き出しを拾わないよう、枠を含む最後の 1 枚を取る
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

test("狭い端末でも上の枠は 3 行で、画面が端末の高さを超えない", async () => {
  const many = fake({
    here: { project: 1, name: "iroha924/gleanery" },
    projects: async () => [
      {
        id: 1,
        key: "git:github.com/iroha924/gleanery",
        name: "iroha924/gleanery",
        sessions: 1,
        knowledge: 1,
        connectors: [],
      },
    ],
  });
  for (const columns of [40, 60, 120]) {
    const lines = (await frameAt(columns, 10, many)).split("\n");
    assert.equal(lines.length, 10, `${columns} 桁で ${lines.length} 行になった`);
    assert.match(lines[0] ?? "", /^╭/, `${columns} 桁で上の罫線が押し出された`);
    assert.match(lines[2] ?? "", /^╰/, `${columns} 桁で上の枠が 3 行に収まっていない`);
    assert.match(lines.slice(8).join("\n"), /q quit/, `${columns} 桁で終わり方の案内が切れた`);
  }
  // 80 桁では案内が 2 行に分かれ、どのキーも切れない
  const at80 = (await frameAt(80, 12, many)).split("\n");
  assert.equal(at80.length, 12);
  const help = at80.slice(10).join("\n");
  for (const key of ["q quit", "/ search", "g G ends", "p project"])
    assert.ok(help.includes(key), `80 桁で ${key} が見えない\n${help}`);
});

// 案内を 2 行にすると一覧に 3 行が残らない高さでは、案内を 1 行に戻し、選んだ行を画面に残す。
test("低い端末でも、端へ動いた後の選んだ行が見える", async () => {
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
    assert.match(frame, /❯/, `${rows} 行で選んだ行が見えない:\n${frame}`);
    r.unmount();
  }
});

test("プロジェクトを切り替えると、セッションの一覧は 1 ページ目から読み直す", async () => {
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
  assert.match(r.lastFrame() ?? "", /page 3 of 3/);
  r.stdin.write("p");
  await settle(r);
  assert.deepEqual(pages.at(-1), [1, 1]);
  assert.match(r.lastFrame() ?? "", /題 1 0/);
  assert.doesNotMatch(r.lastFrame() ?? "", /No recorded sessions/);
  r.unmount();
});

test("AI の応答の地の文に罫線の文字があっても、段落を 1 行で切らない（切るのは表の行だけ）", async () => {
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
  // 6 回繰り返した最後の文まで出ていれば、段落は折り返されている
  assert.equal(frame.split("中身は字下げする").length - 1, 6, frame);
  r.unmount();
});

test("AI の応答の表は、端末より広くても折らずに行ごとに切る（罫線が崩れない）", async () => {
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
  for (const line of lines) assert.match(line.trim(), /^[┌├└│]/, `表の行が折れた:\n${lines.join("\n")}`);
  r.unmount();
});

test("プロジェクトの一覧を読めないとき、狭い端末でも「読めなかった」が見える", async () => {
  const data = fake({ projects: async () => Promise.reject(new Error("接続できない")) });
  for (const columns of [50, 80]) {
    const frame = await frameAt(columns, 12, data);
    assert.match(frame.split("\n")[1] ?? "", /Could not read the project list/, frame);
  }
});

// 語に切れない問い（ひらがなだけ）は引かずに 0 件になる。「当たらなかった」と出すと、無いと読み違える。
test("引ける語の無い問いは、当たらなかったとは別の案内を出す", async () => {
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

// 狭い幅でも案内は行数と幅に収まり、キーと説明の組を割らない（入らない組は後ろから落とす）。
test("操作の案内は、どの幅でも行数と幅に収まり、組を割らない", () => {
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
      assert.ok(out.length <= lines, `${columns}: ${out.length} 行`);
      for (const line of out) assert.ok(width(line) <= columns, `${columns}: ${line}`);
      for (const line of out)
        for (const pair of line.split("  ")) assert.ok(items.includes(pair), `${columns}: ${pair}`);
    }
});

// 記録された PR・issue の本文や会話は第三者が書ける。端末の制御列を落とさずに出すと、画面を書き換えられる。
const HOSTILE = "\u001b[2J\u001b]0;pwn\u0007\r偽の行";
const hostile = (s: string) => `${s}${HOSTILE}`;
/** 注入した制御列が残っているか。画面の色（SGR）の ESC は Ink が付けるので、それ以外の列だけを見る */
const controlled = (frame: string) =>
  ["\u001b[2J", "\u001b]", "\u0007", "\r", "\u001b[8m"].some((c) => frame.includes(c));

test("外から来た文字の制御列を、どの画面にも出さない", async () => {
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
        // Markdown は文字参照を戻すので、描いた後にも制御文字が生まれうる
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
  // 各画面が実際に開いたこと（開かなければ制御列が無いのは当然になる）
  for (const [i, want] of [
    [0, "題"],
    [1, "src/auth.ts"],
    [3, "認証の作り直し"],
    [4, "Goal"],
    [8, "期限はサーバーで見る"],
    [9, "k:9 の全文"],
  ] as const)
    assert.ok(frames[i]?.includes(want), `画面 ${i} に ${want} が無い:\n${frames[i]}`);
  assert.ok(
    frames.some((f) => f.includes("偽の行")),
    "外から来た文字そのものは出る",
  );
  for (const [i, f] of frames.entries()) assert.ok(!controlled(f), `画面 ${i}`);
});

test("読み込みに失敗したときのエラー文の制御列も出さない", async () => {
  const r = render(
    h(App, { data: fake({ sessions: async () => Promise.reject(new Error(hostile("接続できない"))) }) }),
  );
  await settle(r);
  assert.match(r.lastFrame() ?? "", /接続できない/);
  assert.ok(!controlled(r.lastFrame() ?? ""));
  r.unmount();
});

test("作業の一覧が切れた案内は 1 行に収め、狭い端末でも端へ動いた後の選んだ行が見える", async () => {
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
    assert.match(frame, /❯ .*作業 99/, `${columns}×${rows} で選んだ行が見えない:\n${frame}`);
    assert.match(frame, /older work omitted/, `${columns}×${rows} で切れた案内が見えない:\n${frame}`);
    r.unmount();
  }
});
