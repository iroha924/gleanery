import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseKind, withoutReleaseVersion } from "../../scripts/lib/release-scope.mjs";

test("release対象外と plugin を分ける（Web の画面が無くなり、npm だけの release は無い）", () => {
  assert.equal(releaseKind(["README.md", ".agents/skills/plugin-release/SKILL.md"]), "none");
  assert.equal(releaseKind(["plugin/skills/trace/SKILL.md"]), "plugin");
  assert.equal(releaseKind(["server/src/mcp.ts"]), "plugin");
  assert.equal(releaseKind(["server/src/tui/app.ts"]), "plugin");
  assert.equal(releaseKind(["scripts/bundle-cli.ts"]), "plugin");
});

test("versionだけの変更をrelease種別の入力から外せる", () => {
  assert.equal(
    withoutReleaseVersion('{"name":"gleanery","version":"1.1.0"}'),
    withoutReleaseVersion('{"name":"gleanery","version":"1.0.0"}'),
  );
  assert.notEqual(
    withoutReleaseVersion('{"name":"gleanery","version":"1.1.0","files":["dist"]}'),
    withoutReleaseVersion('{"name":"gleanery","version":"1.0.0","files":["src"]}'),
  );
});
