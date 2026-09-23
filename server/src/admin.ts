// この PC の DB（~/.gleanery/gleanery.db）の面倒を見る。持ち主が手元で叩く。owner の接続（authorizer を掛けない）で繋ぐ。
//
//   gleanery db init              DB を作り、db/schema.sql を当てる。何度流してもよい（あれば触らない）
//   gleanery db migrate [--yes]   DB の版（user_version）より新しい db/migrations を当てる
//   gleanery db reindex           語彙索引（FTS）を作り直す。server/src/text.ts の terms() の規則を変えた後に打つ

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import type { DatabaseSync } from "node:sqlite";
import { dbDir } from "./assets.ts";
import { dbFile, SCHEMA_REVISION } from "./db.ts";
import { connectWriter } from "./db-write.ts";
import { indent } from "./tui/view.ts";

/** CLI の他の出力と同じく字下げする（見出しと締めは cli.ts の db command が付ける） */
const say = (text: string) => console.log(indent(text));

// 同梱物の在り処は assets.ts が 1 箇所で決める（配る形と作業ツリーで置かれ方が違う）。
const SCHEMA = (): string => path.join(dbDir(), "schema.sql");
const MIGRATIONS = (): string => path.join(dbDir(), "migrations");

const versionOf = (raw: DatabaseSync): number =>
  (raw.prepare("pragma user_version").get() as { user_version: number }).user_version;

/** 書き込みのロックを先に取った transaction で fn を流す。失敗すれば rollback して元の例外を投げる。 */
function immediate<T>(raw: DatabaseSync, fn: () => T): T {
  raw.exec("begin immediate");
  try {
    const out = fn();
    raw.exec("commit");
    return out;
  } catch (e) {
    raw.exec("rollback");
    throw e;
  }
}

/** 接続を開いて fn を流し、必ず閉じる。 */
function withOwner<T>(file: string, fn: (raw: DatabaseSync) => T, create = false): T {
  const raw = connectWriter("owner", file, create);
  try {
    return fn(raw);
  } finally {
    raw.close();
  }
}

/**
 * この PC の DB を用意する。**既にあれば触らない**ので何度流してもよい。
 * 一時ファイルへ schema を当ててから置く（途中で止まっても、schema の半分だけ当たった DB を残さない）。置き場所が先に
 * 埋まっていれば置かずに止まる。
 */
export function dbInit(file: string = dbFile()): void {
  if (fs.existsSync(file)) {
    const got = withOwner(file, versionOf);
    if (got === SCHEMA_REVISION) say(`既にある: ${file}（revision ${got}）`);
    else if (got === 0)
      throw new Error(`${file} は gleanery の DB ではない（schema が無い）。別の名前へ動かしてから打ち直す`);
    else
      say(
        `既にある: ${file}（revision ${got}。このコードは ${SCHEMA_REVISION}。\`gleanery db migrate\` で進める）`,
      );
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  try {
    withOwner(
      tmp,
      (raw) => {
        // WAL は DB ファイルに残る設定で、接続ごとに打たなくてよい。読む側（MCP）が書く側（取り込み）を待たない。
        raw.exec("pragma journal_mode = wal");
        raw.exec(fs.readFileSync(SCHEMA(), "utf8"));
        if (versionOf(raw) !== SCHEMA_REVISION)
          throw new Error(
            `db/schema.sql の user_version が ${versionOf(raw)}、コードは ${SCHEMA_REVISION} を期待している`,
          );
      },
      true,
    );
    // rename は先に置かれた DB を置き換える。link は置き場所が埋まっていれば EEXIST で止まる（同時の init の後から来た側）。
    // hard link を持たない FS（FAT・exFAT など）では rename で置く。複製は途中で止まると半端な DB を残すので使わない。
    try {
      fs.linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST" || fs.existsSync(file))
        throw new Error(`${file} は既にある（別の db init が先に作った）。打ち直せば確かめる`);
      fs.renameSync(tmp, file);
    }
  } finally {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
  }
  say(`作った: ${file}（revision ${SCHEMA_REVISION}）`);
}

/**
 * 名前の NNNN は当てた後の版。名前の形と重複は当てるものが無くても検査する（飛ばした 1 本は、版が進むと二度と当たらない）。
 */
export function pendingMigrations(files: string[], current: number): { revision: number; file: string }[] {
  const all = files
    // `.` で始まる名前は OS やエディタの隠しファイル（.DS_Store、vim の swap）で、書き損じた migration ではない。
    .filter((file) => !file.startsWith("."))
    .map((file) => {
      const revision = file.match(/^(\d{4})_[a-z0-9_]+\.sql$/)?.[1];
      if (!revision) throw new Error(`db/migrations/${file} の名前が NNNN_<英小文字・数字・_>.sql でない`);
      return { revision: Number(revision), file };
    })
    .sort((a, b) => a.revision - b.revision);
  const seen = new Map<number, string>();
  for (const m of all) {
    const other = seen.get(m.revision);
    if (other) throw new Error(`db/migrations に revision ${m.revision} が 2 本ある: ${other} と ${m.file}`);
    seen.set(m.revision, m.file);
  }
  const pending = all.filter((m) => m.revision > current);
  for (const [i, m] of pending.entries()) {
    if (m.revision !== current + 1 + i)
      throw new Error(`db/migrations に revision ${current + 1 + i} の migration が無い`);
  }
  return pending;
}

/**
 * DB の版より新しい migration を 1 つの transaction で当て、同じ transaction で user_version を上げる。
 * **当てる前に一覧を出して確かめる。**端末でないときは打たせられないので `--yes` を要る形にする。
 */
export async function migrate(
  yes: boolean,
  file: string = dbFile(),
  dir: string = MIGRATIONS(),
): Promise<void> {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const current = withOwner(file, versionOf);
  const todo = pendingMigrations(files, current);
  if (todo.length === 0) {
    say(`当てるものは無い: ${file} は revision ${current}`);
    return;
  }
  say(`DB: ${file}`);
  say(`いまの revision: ${current}`);
  say(`当てる: ${todo.map((m) => m.file).join(" / ")}`);
  if (!yes) {
    if (!process.stdin.isTTY) throw new Error("端末でないときは --yes を付ける");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // 標準入力が EOF で閉じても question は settle しない。
    const closed = new AbortController();
    rl.once("close", () => closed.abort());
    const typed = (
      await rl.question("続けるなら yes を打つ: ", { signal: closed.signal }).catch(() => "")
    ).trim();
    rl.close();
    if (typed !== "yes") {
      say("止めた。");
      process.exitCode = 1;
      return;
    }
  }
  const applied = withOwner(file, (raw) =>
    immediate(raw, () => {
      // 確かめている間に別の db migrate が版を進めていれば、その残りだけを当てる。
      const now = pendingMigrations(files, versionOf(raw));
      for (const m of now) raw.exec(fs.readFileSync(path.join(dir, m.file), "utf8"));
      const last = now.at(-1);
      if (last) raw.exec(`pragma user_version = ${last.revision}`);
      return now;
    }),
  );
  say(`当てた: ${applied.map((m) => m.file).join(" / ") || "無し"}`);
  say(`${file} は revision ${withOwner(file, versionOf)}`);
}

/**
 * 語彙索引を作り直す。**terms() の規則を変えた PR は、release の手順にこれを書く。**
 * 規則を変えても、既存の行の索引は書いたときの規則のまま残り、問いの語と合わなくなる。
 */
export function reindex(file: string = dbFile()): void {
  const counts = withOwner(file, (raw) =>
    immediate(raw, () => {
      raw.exec("insert into knowledge_fts (knowledge_fts) values ('delete-all')");
      raw.exec(`insert into knowledge_fts (rowid, h, b)
        select id, gleanery_terms(coalesce(heading, '')), gleanery_terms(body || char(10) || coalesce(reason, ''))
        from knowledge`);
      raw.exec("insert into message_fts (message_fts) values ('delete-all')");
      raw.exec(
        "insert into message_fts (rowid, lexemes) select seq, gleanery_terms(body) from message where indexed = 1",
      );
      const n = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;
      return {
        knowledge: n("select count(*) as n from knowledge"),
        message: n("select count(*) as n from message where indexed = 1"),
      };
    }),
  );
  say(`索引を作り直した: 知識 ${counts.knowledge} 件 / 発言 ${counts.message} 件`);
}

/** doctor が出す DB の状態。どれも読むだけで、ファイルを書き換えない。 */
export type Inspection = {
  revision: number;
  /** DB と WAL のファイルの大きさ（バイト） */
  bytes: number;
  /** 語彙索引の integrity-check。壊れていれば理由の文 */
  fts: { knowledge: string | null; message: string | null };
};

export function inspect(file: string = dbFile()): Inspection {
  const size = (f: string) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
  return withOwner(file, (raw) => {
    const check = (table: string): string | null => {
      try {
        raw.exec(`insert into ${table} (${table}, rank) values ('integrity-check', 1)`);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    return {
      revision: versionOf(raw),
      bytes: size(file) + size(`${file}-wal`),
      fts: { knowledge: check("knowledge_fts"), message: check("message_fts") },
    };
  });
}
