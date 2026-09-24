#!/usr/bin/env node
// release が作った SBOM が、バンドルして配る依存を全部載せているかを確かめる。使い方: node scripts/check-sbom.mjs <sbom.cdx.json>

import fs from "node:fs";
import path from "node:path";
import { sbomProblems } from "./lib/sbom.mjs";

const file = process.argv[2];
if (!file) throw new Error("SBOM の path を渡す");
const root = path.resolve(import.meta.dirname, "..");
const notices = fs.readFileSync(path.join(root, "plugin", "THIRD_PARTY_NOTICES.md"), "utf8");
const bom = JSON.parse(fs.readFileSync(file, "utf8"));
const problems = sbomProblems(notices, bom);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`SBOM: ${bom.components.length} 件。同梱した依存と過不足なく一致した`);
