// 書く接続（owner・ingest・capture）。**MCP・端末の画面・search から import しない**（scripts/check-architecture.mjs）。
// 接続の初期化順は固定: 開く → defensive と pragma → 語切りの関数 → authorizer（plan 5.5）。

import { constants as C, DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import { kyselyOn } from "./db.ts";
import type { DB } from "./db-types.ts";
import { dbFile, prepare, type Role, requireFile, requireRuntime, SHADOW } from "./sqlite.ts";
import { terms } from "./text.ts";

export type WriteRole = Exclude<Role, "reader">;

/**
 * schema を変える action。owner 以外には許さない。**最初に使うときに作る。**読み込みの時点で作ると、名前を持たない古い Node
 * （22 など）で `requireRuntime` の案内より先に落ち、`--help` まで使えなくなる。
 */
let ddl: Set<number> | null = null;
const DDL = (): Set<number> =>
  (ddl ??= new Set(
    [
      "SQLITE_ALTER_TABLE",
      "SQLITE_ANALYZE",
      "SQLITE_ATTACH",
      "SQLITE_CREATE_INDEX",
      "SQLITE_CREATE_TABLE",
      "SQLITE_CREATE_TEMP_INDEX",
      "SQLITE_CREATE_TEMP_TABLE",
      "SQLITE_CREATE_TEMP_TRIGGER",
      "SQLITE_CREATE_TEMP_VIEW",
      "SQLITE_CREATE_TRIGGER",
      "SQLITE_CREATE_VIEW",
      "SQLITE_CREATE_VTABLE",
      "SQLITE_DETACH",
      "SQLITE_DROP_INDEX",
      "SQLITE_DROP_TABLE",
      "SQLITE_DROP_TEMP_INDEX",
      "SQLITE_DROP_TEMP_TABLE",
      "SQLITE_DROP_TEMP_TRIGGER",
      "SQLITE_DROP_TEMP_VIEW",
      "SQLITE_DROP_TRIGGER",
      "SQLITE_DROP_VIEW",
      "SQLITE_DROP_VTABLE",
      "SQLITE_REINDEX",
    ].map((name) => {
      const code = (C as Record<string, number | undefined>)[name];
      // 名前の綴りを誤ると undefined になり、その操作が黙って許される。
      if (code === undefined) throw new Error(`node:sqlite の constants に ${name} が無い`);
      return code;
    }),
  ));

/** FTS5 は索引を触るたびに data_version を見る。値を渡さない pragma だけを許す。 */
const readsDataVersion = (p1: string | null, p2: string | null) => p1 === "data_version" && p2 === null;

/** capture が insert してよい view。列の無い身元・取り込み元は名乗れない（db/schema.sql）。 */
const CAPTURE_VIEWS = new Set(["capture_conversation", "capture_message", "capture_message_file"]);

/** trigger の中で書いてよい表。trigger の名前（authorizer の第 5 引数）ごとに持つ。 */
const TRIGGER_WRITES: Record<string, Set<string>> = {
  capture_conversation_insert: new Set(["conversation"]),
  capture_message_insert: new Set(["message"]),
  capture_message_file_insert: new Set(["message_file"]),
  message_fts_ai: new Set(["message_fts"]),
};

/**
 * capture が直接読んでよい列。作業場所の対応と、送る発言が既に在るか（件数を数える）だけ。**本文は読めない。**
 * trigger の中の読み（外部キーと一意制約の確かめ）は別に許す。
 */
const CAPTURE_READS: Record<string, Set<string>> = {
  project: new Set(["id", "key", "name"]),
  message: new Set(["id"]),
};

/**
 * `own` はこの接続が組み立てた文を prepare している間だけ true。FTS5 は内部の表（SHADOW）を読み書きする文を実行の途中で
 * prepare するので、そちらだけを通せる。**内部の表には索引の語がそのまま入る**ので、組み立てた文からは読ませない。
 */
function captureAuthorizer(
  own: boolean,
  action: number,
  p1: string | null,
  p2: string | null,
  triggerOrView: string | null,
): number {
  const table = p1 ?? "";
  // _config（FTS5 の版などの設定。語は入らない）は、新しい接続が仮想表を開く prepare の中で読まれる。
  const fts = SHADOW.test(table) && (!own || (action === C.SQLITE_READ && table.endsWith("_config")));
  if (action === C.SQLITE_INSERT) {
    if (CAPTURE_VIEWS.has(table)) return C.SQLITE_OK;
    if (triggerOrView !== null && TRIGGER_WRITES[triggerOrView]?.has(table)) return C.SQLITE_OK;
    return fts ? C.SQLITE_OK : C.SQLITE_DENY;
  }
  if (action === C.SQLITE_UPDATE || action === C.SQLITE_DELETE) return fts ? C.SQLITE_OK : C.SQLITE_DENY;
  if (action === C.SQLITE_READ) {
    if (triggerOrView !== null || fts) return C.SQLITE_OK;
    return CAPTURE_READS[table]?.has(p2 ?? "") ? C.SQLITE_OK : C.SQLITE_DENY;
  }
  if (action === C.SQLITE_FUNCTION) return p2 === "gleanery_terms" ? C.SQLITE_OK : C.SQLITE_DENY;
  if (action === C.SQLITE_PRAGMA) return readsDataVersion(p1, p2) ? C.SQLITE_OK : C.SQLITE_DENY;
  if (action === C.SQLITE_SELECT || action === C.SQLITE_TRANSACTION || action === C.SQLITE_SAVEPOINT)
    return C.SQLITE_OK;
  return C.SQLITE_DENY;
}

function ingestAuthorizer(action: number, p1: string | null, p2: string | null): number {
  if (DDL().has(action)) return C.SQLITE_DENY;
  if (action === C.SQLITE_PRAGMA) return readsDataVersion(p1, p2) ? C.SQLITE_OK : C.SQLITE_DENY;
  return C.SQLITE_OK;
}

/**
 * 書く接続を開く。`create` は owner の `db init` だけが渡す（無い DB を黙って作らない）。
 * **語切りの関数を必ず登録する。**登録しない接続が knowledge / message に書くと、FTS の trigger が
 * no such function で失敗する（索引を黙って欠かさない。fail-closed）。
 */
export function connectWriter(role: WriteRole, file: string = dbFile(), create = false): DatabaseSync {
  requireRuntime();
  if (!create) requireFile(file);
  const raw = new DatabaseSync(file);
  try {
    // 版は ingest だけが確かめる。owner は版を扱う側で、capture は旧版の plugin のまま書き続ける
    // （確かめると、DB を上げてから plugin を上げるまで記録が丸ごと止まる。弾かれた行は rejected/ へ回る）。
    prepare(raw, role === "ingest");
    raw.function("gleanery_terms", { deterministic: true }, (text) => terms(String(text ?? "")).join(" "));
  } catch (e) {
    raw.close();
    throw e;
  }
  if (role === "ingest") raw.setAuthorizer(ingestAuthorizer);
  else if (role === "capture") {
    let own = false;
    raw.setAuthorizer((action, p1, p2, _db, triggerOrView) =>
      captureAuthorizer(own, action, p1, p2, triggerOrView),
    );
    // exec は prepare と実行を分けられないので、実行の間も own のまま（FTS5 の内部の読みも拒まれる）。capture は exec を使わない。
    const prepare = raw.prepare.bind(raw);
    const exec = raw.exec.bind(raw);
    const mark =
      <A extends unknown[], R>(f: (...a: A) => R) =>
      (...a: A): R => {
        own = true;
        try {
          return f(...a);
        } finally {
          own = false;
        }
      };
    raw.prepare = mark(prepare);
    raw.exec = mark(exec);
  }
  return raw;
}

/** 書く接続を包んだ kysely。接続は最初のクエリで開く（db.ts の kyselyOn）。 */
export function openWriter(role: WriteRole, file: string = dbFile()): Kysely<DB> {
  return kyselyOn(() => connectWriter(role, file));
}
