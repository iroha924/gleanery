import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Artifact } from "../src/artifacts.ts";
import { collectDocs, commitOf, docHash, isAncestor, projectDocs, sections, syncDocs } from "../src/docs.ts";
import { knowledgeText } from "../src/knowledge.ts";
import { fakeDb } from "./fake-db.ts";

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
// 番号を付けた key が別の見出しと同じ文字列になると、1 つの upsert に同じ key が並んで同期ごと落ちる。
test("番号を付けた節の key が、同じ文字列の見出しと重ならない", () => {
  const out = sections("x.md", ["## 背景", "a", "## 背景", "b", "## 背景:2", "c"].join("\n"));
  assert.equal(new Set(out.map((s) => s.key)).size, out.length, out.map((s) => s.key).join(" / "));
});

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

/** 一時リポジトリを作り、fn に渡す。git は既定の設定を読まない。 */
async function withRepo(
  fn: (repo: string, git: (...a: string[]) => string) => void | Promise<void>,
): Promise<void> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-docs-")));
  try {
    const repo = path.join(dir, "repo");
    execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    fs.writeFileSync(path.join(dir, "outside.env"), "SECRET_TOKEN=sk-live-abc123\n");
    await fn(repo, git);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const put = (repo: string, rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), body);
};

// **追跡された symlink を辿ると、リポジトリの外が本文として保存される。**
// commit の tree では symlink は mode 120000 の項目で、ディレクトリの symlink の先はそもそも tree に無い。
// 取り込みは利用者が打つが、出力を読まないことも多い。ここが開くと気付かないまま資格情報が出ていく。
test("commit の tree から読み、symlink の先は本文に入れない", async () => {
  await withRepo((repo, git) => {
    put(repo, "docs/real.md", "# 本物\n中身\n");
    fs.symlinkSync("../../outside.env", path.join(repo, "docs", "leak.md"));
    fs.symlinkSync("../outside.env", path.join(repo, "dirlink"));
    git("add", "-A");
    git("commit", "-qm", "x");
    const { docs, skipped } = collectDocs(repo, commitOf(repo, false));
    assert.deepEqual(
      docs.map((d) => d.path),
      ["docs/real.md"],
    );
    assert.equal(skipped, 1);
    assert.ok(!JSON.stringify(docs).includes("SECRET_TOKEN"));
  });
});

// 作業ツリーを読むと、書きかけの本文や、承認を外している最中の成果物が DB に入る。
test("作業ツリーの未 commit の編集は読まず、commit した承認だけを見る", async () => {
  await withRepo((repo, git) => {
    put(repo, ".gleanery/project.json", JSON.stringify({ schema: "gleanery/project/1" }));
    put(
      repo,
      ".gleanery/changes/auth/change.json",
      JSON.stringify({ schema: "gleanery/change/1", title: "認証", requirements: { status: "approved" } }),
    );
    put(repo, ".gleanery/changes/auth/requirements.md", "# 要件\n承認した本文\n");
    put(repo, "README.md", "# 読んで\n公開した本文\n");
    git("add", "-A");
    git("commit", "-qm", "x");
    const head = commitOf(repo, false);
    // commit していない変更（draft へ戻して書き直し中、README の書きかけ）
    put(
      repo,
      ".gleanery/changes/auth/change.json",
      JSON.stringify({ schema: "gleanery/change/1", title: "認証", requirements: { status: "draft" } }),
    );
    put(repo, ".gleanery/changes/auth/requirements.md", "# 要件\n書きかけ\n");
    put(repo, "README.md", "# 読んで\n書きかけ\n");
    const { docs } = collectDocs(repo, head);
    const body = Object.fromEntries(docs.map((d) => [d.path, d.body]));
    assert.match(body["README.md"] ?? "", /公開した本文/);
    assert.match(body[".gleanery/changes/auth/requirements.md"] ?? "", /承認した本文/);
    assert.equal(docs.find((d) => d.path.endsWith("requirements.md"))?.kind, "requirements");
  });
});

test("commit の中の manifest が不正なら何も返さずに止め、fast-forward かどうかを祖先で見る", async () => {
  await withRepo((repo, git) => {
    put(repo, ".gleanery/project.json", JSON.stringify({ schema: "gleanery/project/1" }));
    put(repo, ".gleanery/changes/a/change.json", "{");
    put(repo, ".gleanery/changes/a/requirements.md", "# r\n");
    git("add", "-A");
    git("commit", "-qm", "a");
    const first = commitOf(repo, false);
    assert.throws(() => collectDocs(repo, first), /\.gleanery が不正/);
    put(repo, "README.md", "# x\n");
    git("add", "-A");
    git("commit", "-qm", "b");
    const second = commitOf(repo, false);
    assert.equal(isAncestor(repo, first, second), true);
    assert.equal(isAncestor(repo, second, first), false);
    assert.equal(isAncestor(repo, "0".repeat(40), second), false, "この clone に無い commit");
  });
});

test("大文字の拡張子の文書にも最終更新日が付き、大きすぎる manifest は大きさだけで止める", async () => {
  await withRepo(async (repo, git) => {
    put(repo, "README.MD", "# 読んで\n本文\n");
    git("add", "-A");
    git("commit", "-qm", "a");
    const { docs } = collectDocs(repo, commitOf(repo, false));
    assert.ok(docs.find((d) => d.path === "README.MD")?.at, "README.MD に日付が無い");

    put(repo, ".gleanery/project.json", JSON.stringify({ schema: "gleanery/project/1" }));
    put(repo, ".gleanery/changes/a/change.json", `{"schema": "gleanery/change/1"${" ".repeat(70 * 1024)}}`);
    put(repo, ".gleanery/changes/a/requirements.md", "# r\n");
    git("add", "-A");
    git("commit", "-qm", "b");
    assert.throws(() => collectDocs(repo, commitOf(repo, false)), /change\.json: 大きすぎる/);
  });
});

/**
 * 文書の connector に head だけを持つ偽の DB。書き込みの SQL が来たら失敗させる（この経路は何も書かない）。
 * onRead は connector を読んだ瞬間に走る（その間に別の同期が新しい commit を入れた、を再現する）。
 */
function headOnly(head: string, onRead: () => void = () => {}) {
  const { db, calls } = fakeDb((text) => {
    if (text.includes('insert into "gleanery"."connector"')) return [];
    if (text.includes('"head_oid"')) {
      onRead();
      return [{ id: "1", head_oid: head, snapshot_at: null }];
    }
    return new Error(`書かないはずの SQL: ${text}`);
  });
  return {
    get sql() {
      return calls.map((c) => c.sql);
    },
    client: db,
  };
}

// 同じ朝に 2 本の同期が走り、新しい commit を先に入れられた側が失敗を報告しない。巻き戻しと分岐は止めて、画面に出す。
test("取り直して前に入れた commit まで進んでいれば何も書かずに終え、巻き戻しと分岐は止める", async () => {
  await withRepo(async (repo, git) => {
    put(repo, "README.md", "# a\n");
    git("add", "-A");
    git("commit", "-qm", "a");
    const older = commitOf(repo, false);
    put(repo, "README.md", "# b\n");
    git("add", "-A");
    git("commit", "-qm", "b");
    const newer = commitOf(repo, false);

    git("checkout", "-q", older);
    const raced = headOnly(newer, () => git("checkout", "-q", newer));
    assert.match(
      await syncDocs(raced.client, 1, repo, { remote: false }),
      /新しい commit（.{8}）を先に入れていた/,
    );
    assert.ok(raced.sql.includes("commit"));

    git("checkout", "-q", older);
    await assert.rejects(syncDocs(headOnly(newer).client, 1, repo, { remote: false }), /fast-forward でない/);

    git("checkout", "-q", "-b", "other");
    put(repo, "README.md", "# c\n");
    git("add", "-A");
    git("commit", "-qm", "c");
    await assert.rejects(syncDocs(headOnly(newer).client, 1, repo, { remote: false }), /fast-forward でない/);
  });
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
test("成果物は承認済みだけを入れ、draft と .gleanery のそれ以外は入れない", () => {
  const req = ".gleanery/changes/auth/requirements.md";
  const artifact: Artifact = { kind: "requirements", change: "auth", changeTitle: "認証" };
  const bodies = new Map([
    ["README.md", "# 読んで\n\n本文\n"],
    [req, "# 要件\n\n## 背景\n### 経緯\n\n本文\n"],
    [".gleanery/changes/auth/design.md", "# 設計\n\n本文\n"],
    [".gleanery/notes.md", "# メモ\n\n本文\n"],
    // 承認の判定は根の .gleanery にしか無いので、入れ子の .gleanery は通常の文書として入れない
    ["sub/.gleanery/changes/x/requirements.md", "# 入れ子\n\n本文\n"],
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
  const req = ".gleanery/changes/a/requirements.md";
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
