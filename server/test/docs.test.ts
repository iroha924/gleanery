import assert from "node:assert/strict";
import { test } from "node:test";
import { sections, sectionText } from "../src/docs.ts";

// **コードフェンスの中の `#` は見出しではない。**シェルのコメントで節が割れると、
// 説明と、その説明が指すコマンドが別々の断片になる。
test("コードフェンスの中の見出しでは割らない", () => {
  const out = sections(
    "a.md",
    ["## 使い方", "", "```bash", "# これはコメント", "run --now", "```", "", "続き"].join("\n"),
  );
  assert.equal(out.length, 1);
  assert.match(out[0]?.text ?? "", /# これはコメント/);
  assert.match(out[0]?.text ?? "", /続き/);
});

test("チルダのフェンスも見る", () => {
  const out = sections("a.md", ["## 節", "~~~", "### 中の見出し", "~~~"].join("\n"));
  assert.equal(out.length, 1);
});

// **同じ題が 1 つのファイルに何度も出る。**key が衝突すると unique (record_id, kind, key) で
// 後勝ちになり、先に書かれた節が黙って消える。
test("同じ題の節でも key が衝突しない", () => {
  const out = sections("a.md", ["## 背景", "いち", "## 判断", "に", "## 背景", "さん"].join("\n"));
  assert.equal(out.length, 3);
  assert.equal(new Set(out.map((s) => s.key)).size, 3);
});

// 中身は子が持っている。見出しは子の trail に残るので、落としても失われない。
test("見出しだけの節は置かない", () => {
  const out = sections("a.md", ["## 親", "", "### 子", "中身"].join("\n"));
  assert.deepEqual(
    out.map((s) => s.title),
    ["子"],
  );
  assert.match(out[0]?.trail ?? "", /親 > 子/);
});

// リポジトリが消えた後は原文を取り直せない。切り落とすと永久に失われる。
test("長い節は切り捨てずに続きへ回す", () => {
  const body = Array.from({ length: 60 }, (_, i) => `段落${i}。${"あ".repeat(200)}`).join("\n\n");
  const out = sections("a.md", `## 長い節\n\n${body}`);
  assert.ok(out.length > 1, "分割されていない");
  for (const s of out) assert.ok(s.text.length <= 4000, `${s.text.length} 字の節がある`);
  const joined = out.map((s) => s.text).join("");
  assert.ok(joined.includes("段落0"), "先頭が落ちた");
  assert.ok(joined.includes("段落59"), "末尾が落ちた");
});

// 埋め込みには構造から文脈を付ける（github.ts の PR 題と同じ発想）。
test("埋め込む文にはどの文書のどの節かが前置される", () => {
  const out = sections("docs/adr/0001-x.md", ["# 決定", "## Context", "背景の説明"].join("\n"));
  const s = out.find((x) => x.title === "Context");
  assert.ok(s);
  assert.equal(sectionText(s), "docs/adr/0001-x.md > 決定 > Context\n## Context\n背景の説明");
});

// 見出しの無い文書（README の冒頭だけ、CLAUDE.md の `@AGENTS.md` など）も落とさない。
test("見出しの無い本文も 1 件になる", () => {
  const out = sections("CLAUDE.md", "@AGENTS.md\n");
  assert.equal(out.length, 1);
  assert.equal(out[0]?.text, "@AGENTS.md");
  assert.equal(out[0]?.key, "CLAUDE.md#claude.md");
});
