import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { grepCode, type Root, readCode } from "../src/code.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mitos-code-"));
const repo = path.join(tmp, "repo");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.writeFileSync(
  path.join(repo, "src", "billing.ts"),
  "export const RATE = 0.15;\n// 呼称は Cube 側で解決する\n",
);
fs.writeFileSync(path.join(repo, ".env"), "SECRET_TOKEN=absolutely-not-for-you\n");
// **dotfile ではないもので確かめる。**rg は隠しファイルを既定で読まないので、
// `.env` を置いても SECRET が効いているかは分からない（外しても通ってしまう）。
fs.writeFileSync(
  path.join(repo, "src", "gcp-credentials.json"),
  '{"private_key": "absolutely-not-for-you"}\n',
);
fs.writeFileSync(
  path.join(repo, "src", "many-a.ts"),
  `${Array.from({ length: 7 }, (_, i) => `// 反復する語 ${i}`).join("\n")}\n`,
);
fs.writeFileSync(
  path.join(repo, "src", "many-b.ts"),
  `${Array.from({ length: 5 }, (_, i) => `// 反復する語 ${i}`).join("\n")}\n`,
);
fs.mkdirSync(path.join(repo, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(repo, "dist", "many-a.js"),
  `${Array.from({ length: 7 }, (_, i) => `// 反復する語 ${i}`).join("\n")}\n`,
);
// 名前だけ一致するファイルと、実装を持つファイル。**枠の取り合いを再現する。**
for (const n of ["auth-a.ts", "auth-b.ts", "auth-c.ts"])
  fs.writeFileSync(path.join(repo, "src", n), "// 名前だけ\n");
fs.writeFileSync(path.join(repo, "src", "impl.ts"), "export function checkAuth() {}\n");
fs.writeFileSync(path.join(tmp, "outside.txt"), "この中身は返してはいけない\n");
fs.symlinkSync(path.join(tmp, "outside.txt"), path.join(repo, "escape.txt"));

const roots: Root[] = [{ label: "test/repo", dir: repo }];
// root は chmod 000 を無視して読めてしまうので、権限に依存する検査を飛ばす。
const root = process.getuid?.() === 0;

test("語で探せる", () => {
  const { hits } = grepCode(roots, { query: "呼称" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.path, "src/billing.ts");
  assert.equal(hits[0]?.line, 2);
});

// **切ったことが見えないと、返った分が全部として読まれる。**
test("上限で切っても一致の総数は返る", () => {
  const r = grepCode(roots, { query: "反復する語", limit: 3 });
  assert.equal(r.hits.length, 3, "limit までしか返さない");
  assert.equal(r.matched.lines, 12, "総数は上限を掛けずに数える");
  assert.equal(r.matched.files, 2, "またがったファイルも数える");
  // 行は返しきれなくても、**どのファイルかは全部返せる。**
  assert.deepEqual(r.matched.paths.toSorted(), ["test/repo/src/many-a.ts", "test/repo/src/many-b.ts"]);
});

// **名前だけの一致が枠を食うと、実装を持つファイルが返らない**（実測: limit 2 で本文一致 0 件）。
test("名前だけの一致は、本文一致の枠を食わない", () => {
  const r = grepCode(roots, { query: "auth", limit: 2 });
  assert.equal(r.names.length, 3, "名前一致は limit と別枠で全部返る");
  assert.ok(
    r.hits.some((h) => h.path === "src/impl.ts"),
    "実装を持つファイルが押し出されない",
  );
});

// 名前の一致は本文検索と別の経路なので、**そちらにも同じ除外が要る。**
test("資格情報はファイル名の一致でも出ない", () => {
  const r = grepCode(roots, { query: "credentials" });
  assert.equal(r.names.length, 0);
});

// 生成物は source と同じ実装を二度見せる。
test("生成物は探索に出ない", () => {
  const r = grepCode(roots, { query: "反復する語" });
  assert.equal(r.matched.files, 2, "dist の写しは数えない");
  assert.ok(!r.hits.some((h) => h.path.includes("dist/")), "本文にも出さない");
});

// **除外より呼び出し側の指定が勝つ。**生成物そのものを見たいときに見られなくなる。
test("glob を明示すれば生成物も見られる", () => {
  const r = grepCode(roots, { query: "反復する語", glob: "dist/*.js" });
  assert.equal(r.matched.files, 1);
  assert.deepEqual(r.matched.paths, ["test/repo/dist/many-a.js"]);
});

// 総数は別の rg 呼び出しで数えるので、**そちらにも同じ除外が要る。**
test("資格情報のファイルは総数にも入らない", () => {
  const r = grepCode(roots, { query: "absolutely" });
  assert.equal(r.hits.length, 0, "本文にも出さない");
  assert.equal(r.matched.lines, 0, "総数にも数えない");
  assert.equal(r.matched.files, 0);
});

test("読める", () => {
  const r = readCode(roots, { repo: "test/repo", path: "src/billing.ts" });
  assert.ok("text" in r);
  assert.match(r.text, /RATE = 0\.15/);
  assert.match(r.text, /^1\t/, "行番号が付く");
});

// **ここが唯一の信頼境界。**抜けると任意のファイルが読める。
test("根の外は読めない", () => {
  for (const p of ["../outside.txt", "/etc/hosts", "src/../../outside.txt"]) {
    const r = readCode(roots, { repo: "test/repo", path: p });
    assert.ok("error" in r, `${p} が読めてしまった`);
  }
});

// `..` を弾くだけでは足りない。symlink の先が外ということがある。
test("symlink で外へ出られない", () => {
  const r = readCode(roots, { repo: "test/repo", path: "escape.txt" });
  assert.ok("error" in r, "symlink 経由で外が読めてしまった");
});

test("資格情報の入りうるファイルは読まない", () => {
  const r = readCode(roots, { repo: "test/repo", path: ".env" });
  assert.ok("error" in r);
});

test("見ていない範囲のリポジトリは読めない", () => {
  const r = readCode(roots, { repo: "べつのリポジトリ", path: "src/billing.ts" });
  assert.ok("error" in r);
});

// **探せなかったことは、0 件と同じ形で返してはいけない。**同じにすると
// 「その語はコードに無い」と答え、探せていないことが誰にも見えない。
//
// **PATH を空文字にしない。**POSIX では零長要素がカレントディレクトリを意味するので、
// 探索対象のリポジトリに `rg` という実行ファイルがあるとそれが走る（実測で走った）。
// 実在しないディレクトリだけを置けば、rg は必ず見つからない。
test("rg を起動できないときは 0 件ではなく、探せないことを返す", () => {
  const before = process.env.PATH;
  process.env.PATH = "/nonexistent-dir";
  try {
    const r = grepCode(roots, { query: "呼称" });
    assert.equal(r.hits.length, 0);
    assert.equal(r.unsearched.length, 1, "探せなかったことが出ていない");
    assert.match(r.unsearched[0] ?? "", /rg を起動できない/);
  } finally {
    if (before === undefined) delete process.env.PATH;
    else process.env.PATH = before;
  }
});

// **PATH の零長要素で、探索対象のリポジトリに置かれた rg が走らないこと。**
test("PATH に空要素があっても、リポジトリ内の rg は実行しない", () => {
  const planted = path.join(repo, "rg");
  fs.writeFileSync(planted, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(planted, 0o755);
  const before = process.env.PATH;
  process.env.PATH = `/nonexistent-dir${path.delimiter}`;
  try {
    const r = grepCode(roots, { query: "呼称" });
    assert.match(r.unsearched[0] ?? "", /rg を起動できない/, "リポジトリ内の rg が走っている");
  } finally {
    if (before === undefined) delete process.env.PATH;
    else process.env.PATH = before;
    fs.rmSync(planted);
  }
});

// **rg はあるが弾かれた、を切り分ける。**理由まで見ないと、rg が無い環境でも通ってしまう。
test("正規表現が壊れているときは、その理由ごと返す", () => {
  const r = grepCode(roots, { query: "unclosed(" });
  assert.equal(r.unsearched.length, 1);
  assert.match(r.unsearched[0] ?? "", /終了コード 2/);
  assert.match(r.unsearched[0] ?? "", /regex parse error/);
});

// **資格情報のパスは、rg の stderr 経由でも出さない。**結果の枠だけを塞いでも回り込まれる。
// rg は読めなかったファイルを名指しで stderr へ書く（実測: `rg: ./src/gcp-credentials.json:
// Permission denied`）ので、読めない状態を作らないと検査にならない。
test("探せなかった理由に、資格情報のファイル名を載せない", {
  skip: root ? "root では chmod が効かない" : false,
}, () => {
  const secret = path.join(repo, "src", "gcp-credentials.json");
  fs.chmodSync(secret, 0o000);
  try {
    const r = grepCode(roots, { query: "呼称" });
    assert.equal(r.unsearched.length, 1, "読めないファイルがあったのに理由が出ていない");
    assert.ok(!(r.unsearched[0] ?? "").includes("gcp-credentials"), "資格情報のパスが理由に出ている");
    assert.equal(r.hits.length, 1, "読めた分は返る");
  } finally {
    fs.chmodSync(secret, 0o644);
  }
});

// **範囲に無いリポジトリを指定されたら、探していないと言う。**
test("repo がどの作業場所にも当たらないときは、探していないと返す", () => {
  const r = grepCode(roots, { query: "呼称", repo: "存在しないリポジトリ" });
  assert.equal(r.hits.length, 0);
  assert.match(r.unsearched[0] ?? "", /見ている範囲に無い/);
});

// **片方が読めなくても、もう片方で見つかったものは返す。**捨てると、直前の版より悪くなる。
// 消えたディレクトリで確かめる（chmod 000 は root で走ると効かず、実行ユーザーに依存する）。
test("探せなかった作業場所があっても、探せた分は返し、探せなかったことも返す", () => {
  const r = grepCode([...roots, { label: "消えた/repo", dir: path.join(tmp, "no-such-dir") }], {
    query: "呼称",
  });
  assert.equal(r.hits.length, 1, "生きている作業場所の結果は返る");
  assert.equal(r.unsearched.length, 1, "探せなかった作業場所が出る");
  assert.match(r.unsearched[0] ?? "", /消えた\/repo/);
});
