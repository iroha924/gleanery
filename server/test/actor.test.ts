import assert from "node:assert/strict";
import { test } from "node:test";
import { actorKind, isNoise } from "../src/actor.ts";

test("自動通知は取り込まない", () => {
  assert.equal(actorKind("release-bot[bot]"), "ci");
  assert.equal(actorKind("github-actions[bot]"), "ci");
  assert.equal(actorKind("renovate[bot]"), "ci");
  assert.equal(isNoise("github-actions[bot]"), true);
});

// **AI のレビューは中身がある。**まとめて落とすと指摘まで消える。
test("AI のレビューは残す", () => {
  assert.equal(actorKind("coderabbitai[bot]"), "ai");
  assert.equal(actorKind("gemini-code-assist[bot]"), "ai");
  assert.equal(actorKind("Copilot"), "ai");
  assert.equal(isNoise("coderabbitai[bot]"), false);
});

test("人はそのまま", () => {
  assert.equal(actorKind("reviewer-a"), "human");
  assert.equal(actorKind("Hirata Shunichi"), "human");
  assert.equal(isNoise("iroha924"), false);
});
