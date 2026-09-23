import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { runDir } from "../evals/agentic/run.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-evals-test-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const out = path.join(tmp, "out");
fs.mkdirSync(out);

test("結果の置き場所は OUT の中の <name>/<split>", () => {
  assert.equal(runDir(out, "base-r2", "dev"), path.join(out, "base-r2", "dev"));
});

test("OUT の外を指す名前を、消す前に拒む", () => {
  for (const name of ["../x", "..", ".", "a/b", "/etc", "", "-x", "a\\b"])
    assert.throws(() => runDir(out, name, "dev"), /--name/, name);
});

test("OUT/<name> が symlink なら、外を指していても中を指していても拒む", () => {
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(out, "link"));
  assert.throws(() => runDir(out, "link", "dev"), /symlink/);
  assert.ok(fs.existsSync(outside));
});

test("OUT そのものが symlink なら拒む（共有の一時領域で別の場所を指されうる）", () => {
  const elsewhere = path.join(tmp, "elsewhere");
  fs.mkdirSync(elsewhere);
  const linked = path.join(tmp, "linked-out");
  fs.symlinkSync(elsewhere, linked);
  assert.throws(() => runDir(linked, "base", "dev"), /symlink/);
});
