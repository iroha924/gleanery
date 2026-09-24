import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { pendingMigrations } from "../src/admin.ts";
import { SCHEMA_REVISION } from "../src/db.ts";

test("returns only migrations newer than the database version, in ascending revision order", () => {
  const files = ["0005_c.sql", "0003_a.sql", "0004_b.sql"];
  assert.deepEqual(pendingMigrations(files, 3), [
    { revision: 4, file: "0004_b.sql" },
    { revision: 5, file: "0005_c.sql" },
  ]);
  assert.deepEqual(pendingMigrations(files, 2), [
    { revision: 3, file: "0003_a.sql" },
    { revision: 4, file: "0004_b.sql" },
    { revision: 5, file: "0005_c.sql" },
  ]);
});

test("returns nothing when the database is at or past the last migration", () => {
  const files = ["0003_a.sql", "0004_b.sql"];
  assert.deepEqual(pendingMigrations(files, 4), []);
  assert.deepEqual(pendingMigrations(files, 5), []);
});

// Skipping unreadable names would make the database look current while that step never runs.
test("throws with the name of any file not named NNNN_<lowercase, digits, _>.sql, even when the database is current", () => {
  for (const bad of ["004_b.sql", "0004-b.sql", "0004_B.sql", "0004.sql", "0004_b.sql~", "README.md"]) {
    assert.throws(
      () => pendingMigrations(["0003_a.sql", bad], 3),
      (e: unknown) => {
        assert.ok(e instanceof Error && e.message.includes(bad), `${bad}: ${String(e)}`);
        return true;
      },
    );
  }
});

// Stopping on hidden files left by Finder or vim would block the migrations that should run.
test("names starting with `.` are not read as migrations, and the rest are returned", () => {
  assert.deepEqual(pendingMigrations([".DS_Store", "0003_a.sql", ".0004_b.sql.swp", "0004_b.sql"], 2), [
    { revision: 3, file: "0003_a.sql" },
    { revision: 4, file: "0004_b.sql" },
  ]);
});

// If two branches take the same number, the database applies one, advances the version, and never applies the other.
test("throws with both names when two migrations share a revision, even if the database is past it", () => {
  for (const current of [2, 4]) {
    assert.throws(
      () => pendingMigrations(["0003_a.sql", "0004_b.sql", "0004_c.sql"], current),
      (e: unknown) => {
        assert.ok(
          e instanceof Error && e.message.includes("0004_b.sql") && e.message.includes("0004_c.sql"),
          `current ${current}: ${String(e)}`,
        );
        return true;
      },
    );
  }
});

// Skipping a missing version would leave the database shape off from schema.sql while the version number matches.
test("throws with the missing revision when there is a gap between the next version and the last", () => {
  assert.throws(() => pendingMigrations(["0003_a.sql", "0005_c.sql"], 2), /(?<!\d)0*4(?!\d)/);
  assert.throws(() => pendingMigrations(["0004_b.sql"], 2), /(?<!\d)0*3(?!\d)/);
});

// The SQLite database starts at schema.sql (revision 1) and reaches its current shape by applying these migrations in order.
test("db/migrations runs from revision 2 without gaps or duplicates, and the last version matches the code and schema.sql", () => {
  const dir = new URL("../../db/migrations/", import.meta.url);
  const revisions = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((f) => !f.startsWith("."))
    .sort()
    .map((f) => {
      const m = f.match(/^(\d{4})_[a-z0-9_]+\.sql$/);
      assert.ok(m, `name is not NNNN_<name>.sql: ${f}`);
      return Number(m[1]);
    });
  assert.deepEqual(
    revisions,
    revisions.map((_, i) => i + 2),
  );
  const sql = fs.readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");
  assert.equal(revisions.at(-1) ?? 1, SCHEMA_REVISION);
  assert.equal(SCHEMA_REVISION, Number(sql.match(/pragma user_version = (\d+);/)?.[1]));
});
