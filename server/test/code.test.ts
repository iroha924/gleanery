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
fs.writeFileSync(path.join(tmp, "outside.txt"), "この中身は返してはいけない\n");
fs.symlinkSync(path.join(tmp, "outside.txt"), path.join(repo, "escape.txt"));

const roots: Root[] = [{ label: "test/repo", dir: repo }];

test("語で探せる", () => {
  const hits = grepCode(roots, { query: "呼称" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.path, "src/billing.ts");
  assert.equal(hits[0]?.line, 2);
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
