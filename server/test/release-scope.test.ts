import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXACT_PACKAGE_INPUTS,
  PACKAGE_PREFIXES,
  releaseKind,
  withoutReleaseVersion,
} from "../../scripts/lib/release-scope.mjs";

test("release対象外と plugin を分ける（Web の画面が無くなり、npm だけの release は無い）", () => {
  assert.equal(releaseKind(["README.ja.md", ".agents/skills/plugin-release/SKILL.md"]), "none");
  // README.md は bundle が tarball へ写し、npm の package のページに出る
  assert.equal(releaseKind(["README.md"]), "plugin");
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

test("pre-commit の bundle の glob は、配布物の入力を全部拾う（入力を変えてバージョンを据え置く commit を手元で止める）", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const lefthook = fs.readFileSync(path.join(root, "lefthook.yml"), "utf8");
  const glob = /- name: bundle\n(?:\s+#.*\n)*\s+glob: "\{([^}]*)\}"/.exec(lefthook)?.[1]?.split(",") ?? [];
  assert.ok(glob.length > 0, "lefthook.yml の bundle の glob を読めない");
  const covers = (file: string) =>
    glob.some((g) => g === file || (g.endsWith("/**") && file.startsWith(g.slice(0, -2))));
  for (const file of EXACT_PACKAGE_INPUTS) assert.ok(covers(file), `${file} が bundle の glob に無い`);
  // 前方一致の入力は、その下の全部のファイルを拾う glob でなければならない（`*.ts` に絞ると JSON などを落とす）
  for (const prefix of PACKAGE_PREFIXES)
    assert.ok(glob.includes(`${prefix}**`), `${prefix}** が bundle の glob に無い`);
});
