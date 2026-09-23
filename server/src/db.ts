// DB（SQLite の 1 ファイル）を kysely で使う。**鍵は無い。**接続の役割で権限を分ける（sqlite.ts と db-write.ts）。
// ここに置くのは読む側も使うものだけ。書く接続を開く openWriter は db-write.ts にある。

import type { DatabaseSync } from "node:sqlite";
import { Kysely, ParseJSONResultsPlugin, SqliteDialect, sql } from "kysely";
import type { DB } from "./db-types.ts";
import { adapt } from "./kysely-node-sqlite.ts";
import { connectReader, dbFile } from "./sqlite.ts";

export { dbFile, type Role, SCHEMA_REVISION } from "./sqlite.ts";

/**
 * JSON の文字列を値へ戻す列。**名前で絞る。**既定の判定は `[` か `{` で囲まれた文字列を全部 JSON として読もうとするので、
 * 本文が `[]` や `[1] …` の発言が配列に化ける。ここに無い列は文字列のまま返る。
 * 列（`refs`・`downsides`・`next`・`metadata`）と、`jsonArrayFrom` で組んだ入れ子の列。
 */
export const JSON_COLUMNS = new Set([
  "refs",
  "downsides",
  "next",
  "metadata",
  "connectors",
  "files",
  "handles",
  "paths",
]);

const TOP_LEVEL = /^\$\[\d+\]\."([^"]+)"$/;

const parseJson = new ParseJSONResultsPlugin({
  shouldParse: (_value, jsonPath) => JSON_COLUMNS.has(jsonPath.match(TOP_LEVEL)?.[1] ?? ""),
});

/**
 * 接続を包んだ kysely。**接続は最初のクエリで開く。**起動時に開くと、DB が無いだけで MCP が立ち上がらなくなる。
 * 開くのに失敗したら覚えず、次のクエリで開き直す（kysely の driver の init がそうする）。
 */
export function kyselyOn(connect: () => DatabaseSync): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new SqliteDialect({ database: async () => adapt(connect()) }),
    plugins: [parseJson],
  });
}

/** 読むだけの接続。MCP・端末の画面・`gleanery search` が使う。 */
export function openReader(file: string = dbFile()): Kysely<DB> {
  return kyselyOn(() => connectReader(file));
}

/**
 * 書く transaction を張る。**`begin immediate` で始める**（最初に書き込みのロックを取る）。既定の `begin` は読みから
 * 始まり、書きへ上がるときに別の書き手と当たると busy_timeout を待たずに SQLITE_BUSY で落ちる。
 * 失敗すれば rollback して元の例外を投げる。接続は 1 本なので、fn の中で他の問い合わせを並行に投げない。
 */
export async function inTransaction<T>(db: Kysely<DB>, fn: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
  return db.connection().execute(async (c) => {
    await sql`begin immediate`.execute(c);
    try {
      const out = await fn(c);
      await sql`commit`.execute(c);
      return out;
    } catch (e) {
      // rollback 自体が投げると本来の原因が消える。
      await sql`rollback`.execute(c).catch(() => {});
      throw e;
    }
  });
}

/** DB に書く時刻の形（ISO 8601 の UTC、ミリ秒まで）。schema の CHECK がこれ以外を拒む。 */
export const iso = (d: Date | string | number): string => {
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) throw new RangeError(`時刻として読めない: ${String(d)}`);
  return t.toISOString();
};

/** SQLite が返した失敗の主な結果コード（node:sqlite は拡張コードを errcode に入れる）。SQLite 以外の失敗は null。 */
export function sqliteCode(e: unknown): number | null {
  const x = e as { code?: unknown; errcode?: unknown };
  return x?.code === "ERR_SQLITE_ERROR" && typeof x.errcode === "number" ? x.errcode & 0xff : null;
}
