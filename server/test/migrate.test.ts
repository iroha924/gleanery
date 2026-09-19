import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { pendingMigrations } from "../src/admin.ts";
import { SCHEMA_REVISION } from "../src/db.ts";

test("DB の版より新しい migration だけを、revision の昇順で返す", () => {
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

test("DB が最後の migration の版か、それより新しければ何も返さない", () => {
  const files = ["0003_a.sql", "0004_b.sql"];
  assert.deepEqual(pendingMigrations(files, 4), []);
  assert.deepEqual(pendingMigrations(files, 5), []);
});

// 読めない名前を飛ばすと、DB が最新に見えたままその手順だけが当たらない。
test("名前が NNNN_<英小文字・数字・_>.sql でないファイルがあれば、DB が最新でもその名前を挙げて投げる", () => {
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

// Finder や vim が置く隠しファイルで止まると、当てるべき migration まで当たらなくなる。
test("`.` で始まる名前は migration として読まず、残りだけを返す", () => {
  assert.deepEqual(pendingMigrations([".DS_Store", "0003_a.sql", ".0004_b.sql.swp", "0004_b.sql"], 2), [
    { revision: 3, file: "0003_a.sql" },
    { revision: 4, file: "0004_b.sql" },
  ]);
});

// 別々の branch で同じ番号を取ると、DB は片方だけを当てて版を進め、もう片方は二度と当たらない。
test("同じ revision の migration が 2 本あれば、DB がその版を過ぎていても両方の名前を挙げて投げる", () => {
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

// 欠けた版を飛ばして次を当てると、DB の形が schema.sql からずれたまま版だけが揃う。
test("DB の次の版から最後までに欠番があれば、欠けた revision を挙げて投げる", () => {
  assert.throws(() => pendingMigrations(["0003_a.sql", "0005_c.sql"], 2), /(?<!\d)0*4(?!\d)/);
  assert.throws(() => pendingMigrations(["0004_b.sql"], 2), /(?<!\d)0*3(?!\d)/);
});

// 本番の DB は revision 2 から、ここの migration を順に当てて schema.sql の形へ進む。
test("db/migrations は revision 3 から欠番も重複も無く続き、最後の版がコードと schema.sql の版に一致する", () => {
  const revisions = fs
    .readdirSync(new URL("../../db/migrations/", import.meta.url))
    .filter((f) => !f.startsWith("."))
    .sort()
    .map((f) => {
      const m = f.match(/^(\d{4})_[a-z0-9_]+\.sql$/);
      assert.ok(m, `名前が NNNN_<名前>.sql でない: ${f}`);
      return Number(m[1]);
    });
  assert.deepEqual(
    revisions,
    revisions.map((_, i) => i + 3),
  );
  const sql = fs.readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");
  assert.equal(revisions.at(-1), SCHEMA_REVISION);
  assert.equal(
    revisions.at(-1),
    Number(sql.match(/comment on schema mitos is 'mitos schema revision (\d+)'/)?.[1]),
  );
});
