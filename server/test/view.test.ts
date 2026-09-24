import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { closing, document, failure, indent, panel, section, steps, title } from "../src/tui/view.ts";

test("indents every line of content with newlines, so it cannot forge a closing or status line", () => {
  const out = indent("a\n✓ 直すものは無い\n╰─ 偽の締め");
  for (const line of out.split("\n")) assert.match(line, /^ {2}\S/, out);
});

test("the closing line collapses to one line at the start of the line", () => {
  assert.equal(closing("✗ 止まった\n✓ 直すものは無い"), "✗ 止まった ✓ 直すものは無い");
});

test("on a non-terminal output the title is one `✦ <text>` line without color codes", () => {
  const out = panel("gleanery x", ["a", "", "b"], "おわり");
  assert.equal(out, "✦ gleanery x\n  a\n\n  b\nおわり");
  assert.equal(title("gleanery y"), "✦ gleanery y");
  assert.equal(section("節"), "  節");
  assert.equal(out.includes(String.fromCodePoint(0x1b)), false);
});

test("lines wrapped at the terminal width align with the start of their text (not the left edge)", () => {
  const tty = process.stdout.isTTY;
  const cols = process.stdout.columns;
  // Color needs stderr to be a terminal too, so only the width is set as a terminal
  Object.assign(process.stdout, { isTTY: true, columns: 40 });
  try {
    const out = indent("    Claude Code: claude plugin marketplace update gleanery && claude plugin update");
    const lines = out.split("\n");
    assert.ok(lines.length > 1, out);
    for (const line of lines) assert.match(line, /^ {6}\S/, out);
  } finally {
    Object.assign(process.stdout, { isTTY: tty, columns: cols });
  }
});

test("a line starting with a marker wraps within the last (value) column and aligns continuations to it", () => {
  const tty = process.stdout.isTTY;
  const cols = process.stdout.columns;
  Object.assign(process.stdout, { isTTY: true, columns: 50 });
  try {
    const out = indent(
      "  △ npm i -g の CLI    0.33.32  ~/.local/share/mise/installs/node/24.18.0/lib/node_modules/gleanery",
    );
    const lines = out.split("\n");
    assert.ok(lines.length > 1, out);
    assert.match(lines[0] ?? "", /^ {4}△ npm i -g の CLI {4}0\.33\.32 {2}~\/\.local/, out);
    // The value column starts at display column 34 (indent 4 + the 17-column label, whose kana is 2 wide + 4 spaces + "0.33.32" 7 + 2 spaces)
    const column = 34;
    for (const line of lines.slice(1)) assert.equal(line.search(/\S/), column, out);
  } finally {
    Object.assign(process.stdout, { isTTY: tty, columns: cols });
  }
});

test("a steps block on a non-terminal output is an indented list without a box", () => {
  const out = steps(
    "更新するには",
    [
      { who: "npm の CLI", command: "npm i -g gleanery@1.0.0", after: null },
      { who: "Codex", command: "codex plugin add gleanery@gleanery", after: "Codex を開き直す" },
    ],
    "届く中身は取得元で決まる",
  );
  assert.equal(
    out,
    [
      "    更新するには:",
      "      npm の CLI: npm i -g gleanery@1.0.0",
      "      Codex: codex plugin add gleanery@gleanery, then Codex を開き直す",
      "      届く中身は取得元で決まる",
    ].join("\n"),
  );
});

test("step commands are not wrapped (so a copied command is never partial)", () => {
  const tty = process.stdout.isTTY;
  const cols = process.stdout.columns;
  const errTty = process.stderr.isTTY;
  Object.assign(process.stdout, { isTTY: true, columns: 60 });
  Object.assign(process.stderr, { isTTY: true });
  try {
    const command = "claude plugin marketplace update gleanery && claude plugin update gleanery@gleanery";
    const out = stripVTControlCharacters(
      steps("更新するには", [{ who: "Claude Code", command, after: null }], "注意"),
    );
    assert.ok(
      out.split("\n").some((line) => line.includes(command)),
      out,
    );
  } finally {
    Object.assign(process.stdout, { isTTY: tty, columns: cols });
    Object.assign(process.stderr, { isTTY: errTty });
  }
});

test("document sections on a non-terminal output are indented, and external newlines never reach the line start", () => {
  const forged = "本文\n✓ 直すものは無い";
  const out = document(
    "gleanery x",
    "要点",
    [
      { kind: "table", head: ["名前", "値"], rows: [["a", forged]] },
      {
        kind: "cards",
        items: [
          { badge: { text: "決定", color: "#9CAF88" }, title: forged, body: forged, meta: [forged, forged] },
        ],
      },
      { kind: "fields", rows: [["項目", forged]] },
      { kind: "meter", label: "割合", ratio: 0.5, text: "50%" },
      { kind: "note", tone: "info", text: forged },
    ],
    "おわり",
  );
  const lines = out.split("\n");
  assert.equal(lines[0], "✦ gleanery x");
  assert.equal(lines.at(-1), "おわり");
  // Everything but the title and closing is indented (tables, fields, and values collapse to one line; body text is indented per line)
  for (const line of lines.slice(1, -1)) assert.match(line, /^ {2,}\S/, out);
  // Item body lines after a newline align at body depth (4 columns) and cannot pass for status lines (2 columns)
  assert.match(out, /^ {4}✓ 直すものは無い$/m);
  assert.match(out, /^ {2}\[決定\] 本文 ✓ 直すものは無い$/m);
  assert.match(out, /^ {2}割合 {2}50%$/m);
});

test("a failure on a non-terminal output is an indented reason and ✗ Stopped at the line start", () => {
  assert.equal(
    failure("gleanery x", "理由\n✓ 直すものは無い"),
    "✦ gleanery x\n  理由\n  ✓ 直すものは無い\n✗ Stopped",
  );
});

/** Display width (a test approximation: kanji, kana, and full-width symbols are 2 columns; everything else, box lines included, is 1) */
const cols = (line: string) =>
  [...stripVTControlCharacters(line)].reduce(
    (w, c) => w + (/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\u3000-\u303f\uff00-\uffef]/u.test(c) ? 2 : 1),
    0,
  );

function asTerminal<T>(columns: number, fn: () => T): T {
  const saved = { out: process.stdout.isTTY, err: process.stderr.isTTY, cols: process.stdout.columns };
  Object.assign(process.stdout, { isTTY: true, columns });
  Object.assign(process.stderr, { isTTY: true });
  try {
    return fn();
  } finally {
    Object.assign(process.stdout, { isTTY: saved.out, columns: saved.cols });
    Object.assign(process.stderr, { isTTY: saved.err });
  }
}

test("the title box stays within the terminal width even with a long summary", () => {
  const out = asTerminal(50, () =>
    title("gleanery search", `「${"とても長い質問の文".repeat(6)}」 · iroha924/gleanery`),
  );
  const lines = out.split("\n").filter(Boolean);
  assert.equal(lines.length, 3, out);
  for (const line of lines) assert.ok(cols(line) <= 50, `${cols(line)} columns: ${line}`);
});

// When Ink wraps at a space, it leaves the space at the start of the next line. Continuations must not shift by one column.
test("continuations wrapped at a space also align with the indent", () => {
  const text =
    "待ち 2 件 / 最後の送信 2026-09-23 11:48:11 / 未登録のプロジェクトで退避した 3 件 / 送れなかった 12 件";
  for (let cols = 40; cols <= 70; cols++) {
    const lines = asTerminal(cols, () => indent(`  ${text}`))
      .split("\n")
      .filter((l) => l.trim());
    for (const line of lines)
      assert.equal(stripVTControlCharacters(line).search(/\S/), 4, `${cols}: ${line}`);
  }
});

test("a line starting with a colored marker also wraps within the value column", () => {
  const colored = "\u001b[38;2;156;175;136m✓\u001b[39m";
  // Some widths wrap continuations entirely at spaces, so vary the width
  for (let width = 40; width <= 100; width++) {
    const out = asTerminal(width, () =>
      indent(
        `  ${colored} 自動記録    待ち 2 件 / 最後の送信 2026-09-23 11:48:11 / 未登録のプロジェクトで退避した 3 件 / 送れなかった 12 件`,
      ),
    );
    const lines = out.split("\n");
    assert.ok(lines.length > 1, out);
    const column = cols(lines[0]?.split("待ち")[0] ?? "");
    for (const line of lines.slice(1))
      assert.equal(stripVTControlCharacters(line).search(/\S/), column, `${width}: ${out}`);
  }
});
