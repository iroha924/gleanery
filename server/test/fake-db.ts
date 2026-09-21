// 実 DB へ繋がずに kysely を動かす。返す行を順に配り、実行された SQL を記録する。
//
// **DummyDriver では足りない。**0.29.6 の実装は常に `{ rows: [] }` を返すので、返ってきた行で分岐する検査が
// 書けない（公式 API ページは「execute すると throw」と書いているが、実装と食い違う）。
//
// `GLEANERY_SQL_CORPUS` が指すディレクトリがあるとき、組み立てた SQL をそこへ書き出す。
// scripts/check-sql-parse.mjs が使い捨ての PostgreSQL へ通す材料で、変数が無ければ何もしない
// （テストは今までどおり DB にも資格情報にも触れない）。

import fs from "node:fs";
import path from "node:path";
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryId,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
} from "kysely";
import type { DB } from "../src/db-types.ts";

export type Call = { sql: string; parameters: readonly unknown[] };

const CORPUS_DIR = process.env.GLEANERY_SQL_CORPUS;
// プロセスごとに別のファイルへ書く。node --test は並行に走るので、1 本へ追記すると行が混ざる。
const CORPUS_FILE = CORPUS_DIR ? path.join(CORPUS_DIR, `${process.pid}.jsonl`) : null;

// 台帳は file:line で持つ。同じ call site が入力によって別の SQL を出す（空配列の `in ()` がそれだった）。
function origin(): string {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  for (const line of stack.split("\n")) {
    const m = line.match(/\/server\/src\/([^\s:()]+):(\d+):\d+\)?$/);
    if (m) return `server/src/${m[1]}:${m[2]}`;
  }
  return "出所不明";
}

// 出所は compile と同じ同期の区間で取る。execute まで待つと、`Promise.all` を跨いだ呼び出し元が
// 非同期スタックから消える（実測: readKnowledge の related が出所不明になった）。
//
// queryId は同じ builder から派生した問い合わせで共有される。1 つに上書きすると、2 文が同じ行の
// ものとして数えられる（実測: readMessage の前後 2 本が両方 879 行になった）。compile と execute は
// どちらも呼ばれた順なので、順番で対応させる。
const origins = new WeakMap<QueryId, string[]>();
const recordOrigin: KyselyPlugin = {
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    const queue = origins.get(args.queryId) ?? [];
    queue.push(origin());
    origins.set(args.queryId, queue);
    return args.node;
  },
  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(args.result);
  },
};

/**
 * `respond` が、実行された SQL・パラメータ・何回目かを見て、返す行か投げるエラーを決める。既定は空の結果。
 */
export function fakeDb(
  respond: (
    sql: string,
    parameters: readonly unknown[],
    nth: number,
  ) => readonly unknown[] | Error = () => [],
): {
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
      // 実行しない代わりに、実行できない形を弾く。空配列を kysely の `in` / `not in` へ渡すと
      // `in ()` が出て PostgreSQL が構文エラーにする。記録するだけの double は、これを緑で通してしまう
      // （実測: 空配列の 6 箇所が 184/184 pass のまま本番で落ちる形で入った）。
      if (/\b(?:not )?in \(\)/i.test(q.sql)) {
        throw new Error(`空の配列を in / not in へ渡している。any / all で書く:\n${q.sql}`);
      }
      calls.push({ sql: q.sql, parameters: q.parameters });
      if (CORPUS_FILE) {
        const at = origins.get(q.queryId)?.shift() ?? "出所不明";
        fs.appendFileSync(CORPUS_FILE, `${JSON.stringify({ sql: q.sql, at })}\n`);
      }
      const step = respond(q.sql, q.parameters, next++);
      if (step instanceof Error) throw step;
      // 影響行数は返した行数として渡す。insert / update の件数を見る呼び出し側が、行を返せば数えられる。
      return { rows: step as R[], numAffectedRows: BigInt(step.length) };
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
    // 出所を取るときだけ挿す。常に挿すと、集めていない実行まで plugin を通すことになる。
    plugins: CORPUS_FILE ? [recordOrigin] : [],
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, calls };
}
