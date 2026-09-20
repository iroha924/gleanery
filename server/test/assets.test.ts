import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dashboardRoot, dbDir } from "../src/assets.ts";

/**
 * 配る形を temp へ組み立てる。**リポジトリの外に作る。**
 * 中に作ると、候補を外しても親を辿ってリポジトリ直下の db に当たり、壊れたまま通る。
 */
function packaged(): { pkg: string; dist: string } {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-assets-"));
  fs.mkdirSync(path.join(pkg, "dist", "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "dist", "dashboard", "index.html"), "<!doctype html>");
  fs.mkdirSync(path.join(pkg, "db", "migrations"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "db", "schema.sql"), "-- schema");
  return { pkg, dist: path.join(pkg, "dist") };
}

test("配る形では、画面は dist の下、DB は package 直下から引く", () => {
  const { pkg, dist } = packaged();
  assert.equal(dashboardRoot(dist), path.join(dist, "dashboard"));
  // npm の files が db を <package>/db へ置くので、dist から 1 つ上がる。
  assert.equal(dbDir(dist), path.join(pkg, "db"));
});

test("配布物に db が無ければ、既定へ倒さず投げる", () => {
  const { pkg, dist } = packaged();
  fs.rmSync(path.join(pkg, "db"), { recursive: true });
  assert.throws(() => dbDir(dist), /db\/schema\.sql/);
});

test("画面が無いときは null（build 前に CLI を叩くことがある）", () => {
  const { pkg, dist } = packaged();
  fs.rmSync(path.join(dist, "dashboard"), { recursive: true });
  assert.equal(dashboardRoot(dist), null);
  assert.equal(dbDir(dist), path.join(pkg, "db"));
});

test("作業ツリーでは、リポジトリ直下の db を引く", () => {
  const dir = dbDir();
  assert.ok(fs.existsSync(path.join(dir, "schema.sql")), `${dir} に schema.sql が無い`);
  assert.ok(fs.existsSync(path.join(dir, "compose.yaml")), `${dir} に compose.yaml が無い`);
});
