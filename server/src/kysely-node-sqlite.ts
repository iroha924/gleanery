// kysely の SqliteDialect は better-sqlite3 の形を要求し、`node:sqlite` の公式 dialect は無い（0.29.6）。薄く包んで渡す。
// 行は prototype を持たない object で返るので、普通の object に直す（assert.deepStrictEqual が prototype まで比べる）。
// BLOB は Uint8Array で返る。型の生成（db-types.ts）は Buffer と書くので、Buffer に揃える（`.equals` で hash を比べる）。

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SqliteDatabase } from "kysely";

const plain = (row: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row))
    out[k] =
      v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v;
  return out;
};

export function adapt(raw: DatabaseSync): SqliteDatabase {
  return {
    prepare(sqlText: string) {
      const st = raw.prepare(sqlText);
      const args = (p: ReadonlyArray<unknown>) => p as SQLInputValue[];
      return {
        get reader() {
          return st.columns().length > 0;
        },
        all: (p) => st.all(...args(p)).map(plain),
        run: (p) => {
          const r = st.run(...args(p));
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
        },
        iterate: (p) => st.iterate(...args(p)),
      };
    },
    close: () => raw.close(),
  };
}
