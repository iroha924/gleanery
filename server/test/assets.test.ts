import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dbDir } from "../src/assets.ts";

/**
 * 配る形を temp へ組み立てる。**リポジトリの外に作る。**
 * 中に作ると、候補を外しても親を辿ってリポジトリ直下の db に当たり、壊れたまま通る。
 */
function packaged(): { pkg: string; dist: string } {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-assets-"));
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  fs.mkdirSync(path.join(pkg, "db"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "db", "schema.sql"), "-- schema");
  return { pkg, dist: path.join(pkg, "dist") };
}

test("配る形では、DB は package 直下から引く", () => {
  const { pkg, dist } = packaged();
  // npm の files が db を <package>/db へ置くので、dist から 1 つ上がる。
  assert.equal(dbDir(dist), path.join(pkg, "db"));
});

test("配布物に db が無ければ、既定へ倒さず投げる", () => {
  const { pkg, dist } = packaged();
  fs.rmSync(path.join(pkg, "db"), { recursive: true });
  assert.throws(() => dbDir(dist), /db\/schema\.sql/);
});

test("作業ツリーでは、リポジトリ直下の db を引く", () => {
  const dir = dbDir();
  assert.ok(fs.existsSync(path.join(dir, "schema.sql")), `${dir} に schema.sql が無い`);
});
