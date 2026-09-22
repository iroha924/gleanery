import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseKind, withoutReleaseVersion } from "../../scripts/lib/release-scope.mjs";

test("release対象外、npm-only、pluginを分ける", () => {
  assert.equal(releaseKind(["README.md", ".agents/skills/plugin-release/SKILL.md"]), "none");
  assert.equal(releaseKind(["dashboard/src/App.tsx"]), "npm");
  assert.equal(releaseKind(["server/src/http/routes/knowledge.ts"]), "npm");
  assert.equal(releaseKind(["server/src/server.ts"]), "npm");
  assert.equal(releaseKind(["dashboard/tsconfig.app.json", "dashboard/tsconfig.node.json"]), "npm");
  assert.equal(releaseKind(["plugin/skills/trace/SKILL.md"]), "plugin");
  assert.equal(releaseKind(["server/src/mcp.ts"]), "plugin");
  assert.equal(releaseKind(["dashboard/src/App.tsx", "server/src/mcp.ts"]), "plugin");
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
