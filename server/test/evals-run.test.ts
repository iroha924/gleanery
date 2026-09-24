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

test("results go to <name>/<split> inside OUT", () => {
  assert.equal(runDir(out, "base-r2", "dev"), path.join(out, "base-r2", "dev"));
});

test("rejects a name pointing outside OUT before deleting", () => {
  for (const name of ["../x", "..", ".", "a/b", "/etc", "", "-x", "a\\b"])
    assert.throws(() => runDir(out, name, "dev"), /--name/, name);
});

test("rejects OUT/<name> as a symlink, whether it points outside or inside", () => {
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(out, "link"));
  assert.throws(() => runDir(out, "link", "dev"), /symlink/);
  assert.ok(fs.existsSync(outside));
});

test("rejects OUT itself as a symlink (in a shared temp area it could point elsewhere)", () => {
  const elsewhere = path.join(tmp, "elsewhere");
  fs.mkdirSync(elsewhere);
  const linked = path.join(tmp, "linked-out");
  fs.symlinkSync(elsewhere, linked);
  assert.throws(() => runDir(linked, "base", "dev"), /symlink/);
});
