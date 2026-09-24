import assert from "node:assert/strict";
import { test } from "node:test";
import { sbomProblems } from "../../scripts/lib/sbom.mjs";

const notices = `# 同梱した第三者のソフトウェア

| package | バージョン | ライセンス |
|---|---|---|
| @inkjs/ui | 2.0.0 | MIT |
| ajv | 8.20.0 | MIT |
| ajv | 8.20.0 | MIT |
| zod | 4.6.5 | MIT |
`;
const bom = (components: { name: string; group?: string; version: string; type?: string }[]) => ({
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  components: components.map((c) => ({ type: "library", ...c })),
});

test("同梱した package が全部 SBOM にあれば通る（group 付きの名前も揃える）", () => {
  assert.deepEqual(
    sbomProblems(
      notices,
      bom([
        { group: "@inkjs", name: "ui", version: "2.0.0" },
        { name: "ajv", version: "8.20.0" },
        { name: "zod", version: "4.6.5" },
      ]),
    ),
    [],
  );
});

test("同梱した package が SBOM に無い、版が違うと落とす", () => {
  const got = sbomProblems(
    notices,
    bom([
      { name: "ajv", version: "8.20.0" },
      { name: "zod", version: "4.6.4" },
    ]),
  );
  assert.deepEqual(got, ["SBOM に @inkjs/ui 2.0.0 が無い", "SBOM に zod 4.6.5 が無い"]);
});

test("読めない SBOM と空の一覧は落とす（照合が空振りしない）", () => {
  assert.match(sbomProblems(notices, { bomFormat: "SPDX" }).join("\n"), /CycloneDX/);
  assert.match(sbomProblems("表の無い文書", bom([])).join("\n"), /package を読めない/);
});
