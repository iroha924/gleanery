import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Artifact } from "../src/artifacts.ts";
import { docHash, markdownFiles, projectDocs, sections } from "../src/docs.ts";
import { knowledgeText } from "../src/knowledge.ts";

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

// 4 つのバッククォートの例の中の 3 つのバッククォートで閉じたと読むと、例の中の見出しが節になる。
test("フェンスは同じ文字で同じ長さ以上の、info の無い行でだけ閉じる", () => {
  const md = ["## 書き方", "````md", "```ts", "# 例の中の見出し", "```", "````", "", "## 次", "本文"].join(
    "\n",
  );
  const out = sections("a.md", md);
  assert.deepEqual(
    out.map((s) => s.title),
    ["書き方", "次"],
  );
  assert.equal(sections("b.md", ["## a", "```ts", "```ts", "# 中", "```"].join("\n")).length, 1);
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

// 埋め込みには構造から文脈を付ける。どの文書のどの節かが前置されないと、節だけでは何の話か分からない。
test("埋め込む文にはどの文書のどの節かが前置される", () => {
  const out = sections("docs/adr/0001-x.md", ["# 決定", "## Context", "背景の説明"].join("\n"));
  const s = out.find((x) => x.title === "Context");
  assert.ok(s);
  assert.equal(
    knowledgeText({ kind: "document", heading: s.trail, body: s.text, reason: null }),
    "docs/adr/0001-x.md > 決定 > Context / 文書\n## Context\n背景の説明",
  );
});

// 見出しの無い文書（README の冒頭だけ、CLAUDE.md の `@AGENTS.md` など）も落とさない。
test("見出しの無い本文も 1 件になる", () => {
  const out = sections("CLAUDE.md", "@AGENTS.md\n");
  assert.equal(out.length, 1);
  assert.equal(out[0]?.text, "@AGENTS.md");
  assert.equal(out[0]?.key, "doc:CLAUDE.md#claude.md");
});

// **追跡された symlink を辿ると、リポジトリの外が本文として保存される。**
// `.gitignore` は参照先にしか効かないので、symlink 自体は追跡できてしまう。
// 日次同期は無人で走るので、ここが開くと誰も見ていないところで資格情報が出ていく。
test("追跡された symlink は読む対象に入れない", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mitos-docs-"));
  try {
    fs.writeFileSync(path.join(dir, "outside.env"), "SECRET_TOKEN=sk-live-abc123\n");
    const repo = path.join(dir, "repo");
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    fs.writeFileSync(path.join(repo, "docs", "real.md"), "# 本物\n中身\n");
    fs.symlinkSync("../../outside.env", path.join(repo, "docs", "leak.md"));
    fs.symlinkSync("/etc/hosts", path.join(repo, "docs", "abs.md"));
    git("add", "-A");
    git("commit", "-qm", "x");

    const got = markdownFiles(repo);
    assert.deepEqual(got.files, ["docs/real.md"]);
    assert.equal(got.symlinks, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// **末端の lstat だけでは足りない。**`docs/` 自体が外への symlink だと、
// `docs/notes.md` の末端は普通のファイルに見えて素通りする。
// git は index を見るので、作業ツリー側の形が変わっても列挙は続く。
test("途中のディレクトリが symlink でも外へ出られない", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mitos-docs2-"));
  try {
    fs.mkdirSync(path.join(dir, "outside"));
    fs.writeFileSync(path.join(dir, "outside", "notes.md"), "SECRET_TOKEN=sk-live-xyz\n");
    const repo = path.join(dir, "repo");
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    fs.writeFileSync(path.join(repo, "docs", "notes.md"), "# 本物\n中身\n");
    fs.writeFileSync(path.join(repo, "keep.md"), "# 残る\n中身\n");
    git("add", "-A");
    git("commit", "-qm", "x");

    // docs/ ごと外への symlink に差し替える。git の index は変わらない。
    fs.rmSync(path.join(repo, "docs"), { recursive: true });
    fs.symlinkSync(path.join(dir, "outside"), path.join(repo, "docs"));

    const got = markdownFiles(repo);
    assert.deepEqual(got.files, ["keep.md"], "外の実体を読む対象に入れた");
    assert.equal(got.symlinks, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// **JS の `.` は `\r` を行終端として扱う。**CRLF の見出しに `/^(#{1,3}) +(\S.*)$/` が
// 一致せず、Windows で書かれた文書だけが 1 本まるごと 1 つのベクトルに潰れる。
test("CRLF と BOM でも見出しで割れる", () => {
  const want = ["背景", "決定"];
  const lf = "# 設計\n\n## 背景\n本文\n\n## 決定\nこちら\n";
  assert.deepEqual(
    sections("a.md", lf.replace(/\n/g, "\r\n")).map((s) => s.title),
    want,
    "CRLF で割れなかった",
  );
  assert.deepEqual(
    sections("a.md", `﻿${lf}`).map((s) => s.title),
    want,
    "BOM で先頭の見出しが落ちた",
  );
});

// **承認済みの成果物だけを入れる。**draft を入れると、未承認の AI 生成物が次の生成の根拠として引かれる。
test("成果物は承認済みだけを入れ、draft と .mitos のそれ以外は入れない", () => {
  const req = ".mitos/changes/auth/requirements.md";
  const artifact: Artifact = { kind: "requirements", change: "auth", changeTitle: "認証" };
  const bodies = new Map([
    ["README.md", "# 読んで\n\n本文\n"],
    [req, "# 要件\n\n## 背景\n### 経緯\n\n本文\n"],
    [".mitos/changes/auth/design.md", "# 設計\n\n本文\n"],
    [".mitos/notes.md", "# メモ\n\n本文\n"],
    // 承認の判定は根の .mitos にしか無いので、入れ子の .mitos は通常の文書として入れない
    ["sub/.mitos/changes/x/requirements.md", "# 入れ子\n\n本文\n"],
  ]);
  const got = projectDocs(bodies, new Map([[req, artifact]]), new Map());
  assert.deepEqual(
    got.map((d) => [d.path, d.kind, d.title]),
    [
      ["README.md", "document", "読んで"],
      [req, "requirements", "要件"],
    ],
  );
  assert.equal(got[1]?.artifact, artifact);
});

// 節は見出しだけの節を落とすので、連結しても元に戻らない。画面が出す原文は読んだ本文をそのまま持つ。
test("原文は見出しだけの節・コードフェンス・末尾の改行を含めて元の本文と一致する", () => {
  const req = ".mitos/changes/a/requirements.md";
  const body = "# 題\n\n## 見出しだけ\n### 子\n\n```sh\n# コメント\n```\n\n末尾\n\n";
  const [doc] = projectDocs(
    new Map([[req, body]]),
    new Map([[req, { kind: "requirements", change: "a", changeTitle: "a" }]]),
    new Map(),
  );
  assert.equal(doc?.body, body);
  assert.notEqual(doc?.sections.map((s) => s.text).join("\n"), body, "節の連結で戻るなら原文は要らない");
});

// **本文が同じ文書には書かない。**毎日の同期で全節を書き直すと、索引と埋め込みの行が膨らむ（実測で 2 万回の書き換え）。
test("文書の hash は本文と承認の状態で決まり、同じなら同じ値になる", () => {
  const bodies = new Map([["a.md", "# a\n\n本文\n"]]);
  const [x] = projectDocs(bodies, new Map(), new Map([["a.md", "2026-09-01T00:00:00+09:00"]]));
  const [y] = projectDocs(bodies, new Map(), new Map([["a.md", "2026-09-01T00:00:00+09:00"]]));
  const [z] = projectDocs(new Map([["a.md", "# a\n\n本文を変えた\n"]]), new Map(), new Map());
  assert.ok(x && y && z);
  assert.ok(docHash(x).equals(docHash(y)));
  assert.ok(!docHash(x).equals(docHash(z)));
});

test("中身の無い文書は入れない", () => {
  assert.deepEqual(projectDocs(new Map([["empty.md", "  \n"]]), new Map(), new Map()), []);
});
