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
