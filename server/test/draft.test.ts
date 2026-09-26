import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DRAFT_BYTES, newDraft, readDraft, removeDraft } from "../src/draft.ts";

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "sphica-drafts-"));

test("a draft is written by the agent, read by id, and removed after saving", () => {
  const r = root();
  try {
    const d = newDraft("harvest", r);
    assert.equal(path.dirname(path.dirname(d.file)), r);
    fs.writeFileSync(d.file, JSON.stringify({ schema: "harvest/1", pr: 1, items: [], note: "日本語" }));
    assert.deepEqual(readDraft(d.id, "harvest", r), {
      schema: "harvest/1",
      pr: 1,
      items: [],
      note: "日本語",
    });
    // A trace check does not read a harvest draft
    assert.throws(() => readDraft(d.id, "trace", r), /has no record yet/);
    assert.equal(removeDraft(d.id, r), null);
    assert.throws(() => readDraft(d.id, "harvest", r), /No draft/);
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

// check and save read only files this CLI issued: nothing a link, a path, or an oversized file points them at
test("a draft refuses ids it did not issue, links, directories, oversized files, and broken JSON", () => {
  const r = root();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-outside-"));
  try {
    for (const id of ["../x", "a/b", "-", "", "short"])
      assert.throws(() => readDraft(id, "trace", r), /Not a draft id/);
    assert.throws(() => readDraft("AAAAAAAAAAAA", "trace", r), /No draft/);
    const secret = path.join(outside, "secret.json");
    fs.writeFileSync(secret, "{}");
    const linked = newDraft("trace", r);
    fs.symlinkSync(secret, linked.file);
    assert.throws(() => readDraft(linked.id, "trace", r), /not a regular file/);
    fs.symlinkSync(outside, path.join(r, "BBBBBBBBBBBB"));
    assert.throws(() => readDraft("BBBBBBBBBBBB", "trace", r), /No draft/);
    const dir = newDraft("trace", r);
    fs.mkdirSync(dir.file);
    assert.throws(() => readDraft(dir.id, "trace", r), /not a regular file/);
    const big = newDraft("trace", r);
    fs.writeFileSync(big.file, " ".repeat(DRAFT_BYTES + 1));
    assert.throws(() => readDraft(big.id, "trace", r), /over the/);
    const broken = newDraft("trace", r);
    fs.writeFileSync(broken.file, "{");
    assert.throws(() => readDraft(broken.id, "trace", r), /is not JSON/);
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("issuing a draft removes drafts left for more than a day, and nothing else", () => {
  const r = root();
  try {
    const old = newDraft("trace", r);
    const fresh = newDraft("trace", r);
    const day = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(path.dirname(old.file), day, day);
    fs.writeFileSync(path.join(r, "not-a-draft"), "");
    newDraft("trace", r);
    assert.equal(fs.existsSync(path.dirname(old.file)), false);
    assert.equal(fs.existsSync(path.dirname(fresh.file)), true);
    assert.equal(fs.existsSync(path.join(r, "not-a-draft")), true);
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});
