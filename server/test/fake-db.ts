// 実 DB へ繋がずに kysely を動かす。返す行を順に配り、実行された SQL を記録する。
//
// **DummyDriver では足りない。**0.29.6 の実装は常に `{ rows: [] }` を返すので、返ってきた行で分岐する検査が
// 書けない（公式 API ページは「execute すると throw」と書いているが、実装と食い違う）。
// 生成される SQL だけを見るなら、これではなく builder の `compile()` を呼ぶ。

import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import type { DB } from "../src/db-types.ts";

export type Call = { sql: string; parameters: readonly unknown[] };

/**
 * `respond` が、実行された SQL と何回目かを見て、返す行か投げるエラーを決める。既定は空の結果。
 */
export function fakeDb(respond: (sql: string, nth: number) => readonly unknown[] | Error = () => []): {
  db: Kysely<DB>;
  calls: Call[];
} {
  const calls: Call[] = [];
  let next = 0;
  const note = (sql: string): void => {
    calls.push({ sql, parameters: [] });
  };
  const connection: DatabaseConnection = {
    async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
      calls.push({ sql: q.sql, parameters: q.parameters });
      const step = respond(q.sql, next++);
      if (step instanceof Error) throw step;
      return { rows: step as R[] };
    },
    streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error("stream は使わない");
    },
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async () => note("begin"),
    commitTransaction: async () => note("commit"),
    rollbackTransaction: async () => note("rollback"),
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, calls };
}
