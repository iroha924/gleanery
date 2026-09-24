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

test("passes when every bundled package is in the SBOM (scoped names included)", () => {
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

test("fails when a bundled package is missing from the SBOM or has a different version", () => {
  const got = sbomProblems(
    notices,
    bom([
      { name: "ajv", version: "8.20.0" },
      { name: "zod", version: "4.6.4" },
    ]),
  );
  assert.deepEqual(got, [
    "SBOM に @inkjs/ui 2.0.0 が無い",
    "SBOM に zod 4.6.5 が無い",
    "SBOM に同梱していない zod 4.6.4 がある",
  ]);
});

test("fails on an unreadable SBOM and an empty list (so the comparison never passes vacuously)", () => {
  assert.match(sbomProblems(notices, { bomFormat: "SPDX" }).join("\n"), /CycloneDX/);
  assert.match(sbomProblems("表の無い文書", bom([])).join("\n"), /package を読めない/);
});

test("fails when the SBOM lists a package that is not bundled (a mismatched scope would be false)", () => {
  const got = sbomProblems(
    notices,
    bom([
      { group: "@inkjs", name: "ui", version: "2.0.0" },
      { name: "ajv", version: "8.20.0" },
      { name: "zod", version: "4.6.5" },
      { name: "typescript", version: "7.0.2" },
    ]),
  );
  assert.deepEqual(got, ["SBOM に同梱していない typescript 7.0.2 がある"]);
});

test("fails on a malformed row in the notices table instead of leaving it out of the comparison", () => {
  const broken = `${notices}| react | 19.3.0 (patched) | MIT |\n| ink | | MIT |\n`;
  const got = sbomProblems(
    broken,
    bom([
      { group: "@inkjs", name: "ui", version: "2.0.0" },
      { name: "ajv", version: "8.20.0" },
      { name: "zod", version: "4.6.5" },
    ]),
  );
  assert.deepEqual(got, [
    "THIRD_PARTY_NOTICES.md の表の行を読めない: | react | 19.3.0 (patched) | MIT |",
    "THIRD_PARTY_NOTICES.md の表の行を読めない: | ink | | MIT |",
  ]);
});
