// DB ファイルの在り処と、読むだけの接続。**書く接続は db-write.ts にだけ置く。**
// untrusted な文章を読む出口（MCP・端末の画面・search）が書く接続へ届かないよう、module を分けて
// scripts/check-architecture.mjs が import の向きを止める。
//
// 守るのは「gleanery のコードが誤って・untrusted な文章に唆されて書く」経路で、OS の権限境界ではない
// （同じ OS ユーザーのプロセスは DB ファイルを直接書き換えられる）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { constants as C, DatabaseSync } from "node:sqlite";

/** MCP・CLI・端末の画面が期待する schema の版。db/schema.sql の末尾の `pragma user_version` と同じ数にする。 */
export const SCHEMA_REVISION = 1;

/** 接続の役割。owner は schema の適用、reader は読むだけ、ingest は取り込み、capture は会話の自動記録（追記だけ）。 */
export type Role = "owner" | "reader" | "ingest" | "capture";

/**
 * DB ファイル。`GLEANERY_DB` は検査のためだけにある（子プロセスの HOME を一時ディレクトリへ向けるのと同じ目的）。
 * README には書かない。
 */
export const dbFile = (): string =>
  process.env.GLEANERY_DB || path.join(os.homedir(), ".gleanery", "gleanery.db");

/**
 * Node が権限境界に要る API を持つか。**弱い状態で続行しない。**`engines` は npm では警告だけになることがあるので、
 * MCP・自動記録・CLI・端末の画面の全入口で確かめる（setAuthorizer は v24.10、enableDefensive は v24.12）。
 */
export function requireRuntime(): void {
  const proto = DatabaseSync.prototype as unknown as Record<string, unknown>;
  if (typeof proto.setAuthorizer !== "function" || typeof proto.enableDefensive !== "function")
    throw new Error(`gleanery は Node 24.15 以降で動く（いまは ${process.version}）。Node を上げる`);
}

/** 無い DB を黙って作らない（空のファイルが「記録が 0 件」に見える）。作るのは `gleanery db init` だけ。 */
export function requireFile(file: string): void {
  if (!fs.existsSync(file)) throw new Error(`DB が無い（${file}）。\`gleanery db init\` で作る`);
}

/**
 * 開いた直後の設定。**authorizer より前に済ませる**（後だと PRAGMA が authorizer に弾かれる）。
 * `enableDefensive` は FTS5 の shadow table への直接の書き込みを止める。owner も直接書く理由が無いので全部で有効にする
 * （node:sqlite の既定でも有効だが、既定が変わっても外れないよう明示する）。
 */
export function prepare(raw: DatabaseSync, checkVersion: boolean): void {
  raw.enableDefensive(true);
  raw.exec("pragma foreign_keys = on");
  // 同時に書く取り込みと自動記録が待ち合う時間。待ちきれなければ SQLITE_BUSY で失敗し、自動記録は次の送信で送り直す。
  raw.exec("pragma busy_timeout = 5000");
  if (!checkVersion) return;
  const got = (raw.prepare("pragma user_version").get() as { user_version: number } | undefined)
    ?.user_version;
  if (got === SCHEMA_REVISION) return;
  if (!got) throw new Error("DB に gleanery の schema が無い。`gleanery db init` で作る");
  throw new Error(
    `DB の schema は revision ${got}、このコードは revision ${SCHEMA_REVISION} を期待している。` +
      (got < SCHEMA_REVISION ? "`gleanery db migrate` で進める" : "gleanery を更新する"),
  );
}

/** 読む側が呼ぶ関数。**足すのは test が落ちたときだけ**（全部の SQL は test で実 DB に通る）。 */
const READER_FUNCTIONS = new Set([
  "bm25",
  "coalesce",
  "count",
  "instr",
  "json_array_length",
  "json_extract",
  "json_group_array",
  "json_object",
  "length",
  "lower",
  "match",
  "max",
  "min",
  "substr",
]);

/** FTS5 が自分の索引を読むときの内部の問い合わせ。trigger の外（triggerOrView が null）で来る。 */
export const SHADOW = /^(knowledge|message)_fts_(data|idx|docsize|config)$/;

/**
 * 読むだけの接続。`readOnly` で開くので書き込みは SQLite が拒み、authorizer は DDL・ATTACH・仮想表の作成と、
 * 許していない関数を止める。`gleanery_terms` は登録しない（FTS の検索は語切りの関数を要らない）。
 */
export function connectReader(file: string = dbFile()): DatabaseSync {
  requireRuntime();
  requireFile(file);
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    prepare(raw, true);
  } catch (e) {
    raw.close();
    throw e;
  }
  raw.setAuthorizer((action, p1, p2) => {
    if (action === C.SQLITE_READ || action === C.SQLITE_SELECT || action === C.SQLITE_RECURSIVE)
      return C.SQLITE_OK;
    if (action === C.SQLITE_FUNCTION)
      return READER_FUNCTIONS.has((p2 ?? "").toLowerCase()) ? C.SQLITE_OK : C.SQLITE_DENY;
    // FTS5 は索引を読むたびに data_version を見る（値を渡さない、書き換えない pragma）。
    if (action === C.SQLITE_PRAGMA && p1 === "data_version" && p2 === null) return C.SQLITE_OK;
    return C.SQLITE_DENY;
  });
  return raw;
}
