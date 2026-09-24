import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { closing, document, failure, indent, panel, section, steps, title } from "../src/tui/view.ts";

test("中身は改行を含んでも全部の行を字下げし、行頭の偽の締めや状態の行を作らせない", () => {
  const out = indent("a\n✓ 直すものは無い\n╰─ 偽の締め");
  for (const line of out.split("\n")) assert.match(line, /^ {2}\S/, out);
});

test("締めの行は 1 行に潰し、行頭に置く", () => {
  assert.equal(closing("✗ 止まった\n✓ 直すものは無い"), "✗ 止まった ✓ 直すものは無い");
});

test("端末でない出力先では、見出しは `✦ <text>` の 1 行で、色の制御文字を混ぜない", () => {
  const out = panel("gleanery x", ["a", "", "b"], "おわり");
  assert.equal(out, "✦ gleanery x\n  a\n\n  b\nおわり");
  assert.equal(title("gleanery y"), "✦ gleanery y");
  assert.equal(section("節"), "  節");
  assert.equal(out.includes(String.fromCodePoint(0x1b)), false);
});

test("端末の幅で折り返した行は、その行の文字の頭に揃う（左端へ戻らない）", () => {
  const tty = process.stdout.isTTY;
  const cols = process.stdout.columns;
  // 色は標準エラーも端末のときだけなので、幅だけを端末にする
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

test("印で始まる行は、最後の列（値）の中で折り返し、続きを値の列に揃える", () => {
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
    // 値の列は表示の上で 34 桁目（字下げ 4 + 「△ npm i -g の CLI」17（「の」は 2 桁）+ 空白 4 + 「0.33.32」7 + 空白 2）
    const column = 34;
    for (const line of lines.slice(1)) assert.equal(line.search(/\S/), column, out);
  } finally {
    Object.assign(process.stdout, { isTTY: tty, columns: cols });
  }
});

test("手順の塊は、端末でない出力先では枠を付けず字下げした一覧にする", () => {
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

test("手順の command は折らない（写したときに途中までの command にならない）", () => {
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

test("文書の節は、端末でない出力先では字下げした文字になり、外から来た改行は行頭に出ない", () => {
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
  // 見出しと締め以外は全部字下げされている（表・項目・値は 1 行に潰れ、本文は行ごとに字下げされる）
  for (const line of lines.slice(1, -1)) assert.match(line, /^ {2,}\S/, out);
  // 項目の本文は、改行の後の行も本文の深さ（4 桁）に揃い、状態の行（2 桁）と紛れない
  assert.match(out, /^ {4}✓ 直すものは無い$/m);
  assert.match(out, /^ {2}\[決定\] 本文 ✓ 直すものは無い$/m);
  assert.match(out, /^ {2}割合 {2}50%$/m);
});

test("失敗は、端末でない出力先では字下げした理由と行頭の ✗ 止まった", () => {
  assert.equal(
    failure("gleanery x", "理由\n✓ 直すものは無い"),
    "✦ gleanery x\n  理由\n  ✓ 直すものは無い\n✗ Stopped",
  );
});

/** 表示の幅（test 用の近似: 漢字・かな・全角の記号は 2 桁、罫線を含むほかは 1 桁） */
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

test("見出しの枠は、要点が長くても端末の幅を越えない", () => {
  const out = asTerminal(50, () =>
    title("gleanery search", `「${"とても長い質問の文".repeat(6)}」 · iroha924/gleanery`),
  );
  const lines = out.split("\n").filter(Boolean);
  assert.equal(lines.length, 3, out);
  for (const line of lines) assert.ok(cols(line) <= 50, `${cols(line)} 桁: ${line}`);
});

// Ink は空白で折り返すと、その空白を続きの行の頭に残す。続きの行が 1 桁ずれないこと。
test("空白で折り返した続きの行も、字下げの位置に揃う", () => {
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

test("色の付いた印で始まる行も、値の列の中で折り返す", () => {
  const colored = "\u001b[38;2;156;175;136m✓\u001b[39m";
  // 続きの行が全部空白で折り返される幅もあるので、幅を振る
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
