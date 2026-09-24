// Looks after this machine's database (~/.gleanery/gleanery.db). The owner runs these locally, with the owner connection (no authorizer).
//
//   gleanery init                 creates the database and applies db/schema.sql. Safe to run again (an existing one is left alone)
//   gleanery db migrate [--yes]   applies db/migrations newer than the database version (user_version)
//   gleanery db reindex           rebuilds the full-text index (FTS). Run it after changing the rules of terms() in server/src/text.ts

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { constants as C, type DatabaseSync } from "node:sqlite";
import { dbDir } from "./assets.ts";
import { dbFile, SCHEMA_REVISION } from "./db.ts";
import { connectWriter } from "./db-write.ts";
import { plural } from "./text.ts";
import { indent } from "./tui/view.ts";

/** Indented like other CLI output (the db command in cli.ts adds the heading and closing) */
const say = (text: string) => console.log(indent(text));

// assets.ts alone decides where bundled files live (the shipped package and the working tree differ).
const SCHEMA = (): string => path.join(dbDir(), "schema.sql");
const MIGRATIONS = (): string => path.join(dbDir(), "migrations");

const versionOf = (raw: DatabaseSync): number =>
  (raw.prepare("pragma user_version").get() as { user_version: number }).user_version;

/** Runs fn in a transaction that takes the write lock first. On failure it rolls back and rethrows the original error. */
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

/** Opens a connection, runs fn, and always closes it. */
function withOwner<T>(file: string, fn: (raw: DatabaseSync) => T, create = false): T {
  const raw = connectWriter("owner", file, create);
  try {
    return fn(raw);
  } finally {
    raw.close();
  }
}

/**
 * Prepares this machine's database. **An existing one is left alone**, so it is safe to run again.
 * The schema is applied to a temporary file before it is put in place (stopping midway never leaves a half-applied database).
 * If the destination is already taken, it stops without placing it.
 */
export function dbInit(file: string = dbFile()): void {
  if (fs.existsSync(file)) {
    const got = withOwner(file, versionOf);
    if (got === SCHEMA_REVISION) say(`Already exists: ${file} (revision ${got})`);
    else if (got === 0)
      throw new Error(
        `${file} is not a gleanery database (no schema). Move it to another name, then run this again.`,
      );
    else
      say(
        `Already exists: ${file} (revision ${got}; this gleanery expects ${SCHEMA_REVISION}. Run \`gleanery db migrate\`.)`,
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
        // WAL is a setting stored in the database file, so it need not be set per connection. Readers (MCP) do not wait for writers (imports).
        raw.exec("pragma journal_mode = wal");
        raw.exec(fs.readFileSync(SCHEMA(), "utf8"));
        if (versionOf(raw) !== SCHEMA_REVISION)
          throw new Error(
            `db/schema.sql has user_version ${versionOf(raw)}, but the code expects ${SCHEMA_REVISION}`,
          );
      },
      true,
    );
    // rename replaces a database already in place. link stops with EEXIST when the destination is taken (the later of two concurrent inits).
    // File systems without hard links (FAT, exFAT) fall back to rename. Copying is not used: stopping midway leaves a partial database.
    try {
      fs.linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST" || fs.existsSync(file))
        throw new Error(
          `${file} already exists (another gleanery init created it first). Run this again to check it.`,
        );
      fs.renameSync(tmp, file);
    }
  } finally {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
  }
  say(`Created: ${file} (revision ${SCHEMA_REVISION})`);
}

/**
 * NNNN in a name is the version after applying it. Name format and duplicates are checked even with nothing to apply (a skipped one never applies once the version moves on).
 */
export function pendingMigrations(files: string[], current: number): { revision: number; file: string }[] {
  const all = files
    // Names starting with `.` are OS or editor hidden files (.DS_Store, vim swap files), not misnamed migrations.
    .filter((file) => !file.startsWith("."))
    .map((file) => {
      const revision = file.match(/^(\d{4})_[a-z0-9_]+\.sql$/)?.[1];
      if (!revision)
        throw new Error(`db/migrations/${file} is not named NNNN_<lowercase letters, digits, _>.sql`);
      return { revision: Number(revision), file };
    })
    .sort((a, b) => a.revision - b.revision);
  const seen = new Map<number, string>();
  for (const m of all) {
    const other = seen.get(m.revision);
    if (other)
      throw new Error(`db/migrations has two migrations for revision ${m.revision}: ${other} and ${m.file}`);
    seen.set(m.revision, m.file);
  }
  const pending = all.filter((m) => m.revision > current);
  for (const [i, m] of pending.entries()) {
    if (m.revision !== current + 1 + i)
      throw new Error(`db/migrations has no migration for revision ${current + 1 + i}`);
  }
  return pending;
}

/**
 * The declaration on a migration's first line. Only `-- gleanery: foreign_keys=off` is accepted; any other `-- gleanery:` throws.
 * **Misreading it and applying with foreign keys on lets a table rebuild cascade-delete child rows.** Leading spaces also count as a declaration.
 * The authorizer in applyMigrations stops undeclared migrations from dropping tables (not judged from the SQL text).
 */
function directiveOf(dir: string, m: { file: string }): "foreign_keys=off" | null {
  const lines = fs.readFileSync(path.join(dir, m.file), "utf8").split(/\r?\n/);
  let found: "foreign_keys=off" | null = null;
  for (const [i, line] of lines.entries()) {
    const d = /^\s*--\s*gleanery:\s*(.*?)\s*$/.exec(line)?.[1];
    if (d === undefined) continue;
    if (i !== 0 || d !== "foreign_keys=off")
      throw new Error(`Cannot read the declaration on line ${i + 1} of db/migrations/${m.file}: ${d}`);
    found = d;
  }
  return found;
}

/**
 * Applies migrations newer than the database version and raises user_version per transaction (earlier ones stay if it fails midway, so it can be rerun).
 * Undeclared migrations in a row are applied in one transaction. A migration declaring `-- gleanery: foreign_keys=off` runs alone,
 * turning foreign keys off outside the transaction, checks foreign_key_check is empty before commit, and turns them back on (they cannot switch inside a transaction).
 */
export function applyMigrations(
  raw: DatabaseSync,
  files: string[],
  dir: string,
): { revision: number; file: string }[] {
  // Read every declaration before applying. If one cannot be read, nothing is applied.
  const pending = pendingMigrations(files, versionOf(raw));
  const off = new Set(pending.filter((m) => directiveOf(dir, m) !== null).map((m) => m.file));
  const applied: { revision: number; file: string }[] = [];
  for (;;) {
    const next = pendingMigrations(files, versionOf(raw))[0];
    if (!next) return applied;
    const single = off.has(next.file);
    if (single) {
      raw.exec("pragma foreign_keys = off");
      if ((raw.prepare("pragma foreign_keys").get() as { foreign_keys: number }).foreign_keys !== 0)
        throw new Error("Could not turn foreign keys off (inside a transaction)");
    }
    // Undeclared migrations may not drop or rebuild tables (ALTER, including adding columns, belongs in a declared migration).
    // A drop with foreign keys on cascade-deletes child rows, and renaming a parent rewrites children's foreign keys to the backup.
    // It stops on statements SQLite has parsed, so comments or line breaks in between do not slip through.
    if (!single)
      raw.setAuthorizer((action) =>
        action === C.SQLITE_DROP_TABLE || action === C.SQLITE_ALTER_TABLE ? C.SQLITE_DENY : C.SQLITE_OK,
      );
    try {
      const batch = immediate(raw, () => {
        // Read again after taking the lock. If another db migrate advanced it meanwhile, apply the rest from there.
        const now = pendingMigrations(files, versionOf(raw));
        if (now[0]?.file !== next.file) return [];
        const stop = now.findIndex((m) => off.has(m.file));
        const take = single ? [next] : now.slice(0, stop === -1 ? now.length : stop);
        for (const m of take) raw.exec(fs.readFileSync(path.join(dir, m.file), "utf8"));
        if (single) {
          const broken = raw.prepare("pragma foreign_key_check").all();
          if (broken.length)
            throw new Error(`${broken.length} foreign key references are broken after ${next.file}`);
        }
        raw.exec(`pragma user_version = ${(take.at(-1) as { revision: number }).revision}`);
        return take;
      });
      applied.push(...batch);
    } finally {
      if (single) raw.exec("pragma foreign_keys = on");
      else raw.setAuthorizer(null);
    }
  }
}

/**
 * Applies migrations newer than the database version. See applyMigrations for how.
 * **Lists them for confirmation before applying.** Without a terminal it cannot ask, so `--yes` is required.
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
    say(`Nothing to apply: ${file} is at revision ${current}`);
    return;
  }
  say(`DB: ${file}`);
  say(`Current revision: ${current}`);
  say(`To apply: ${todo.map((m) => m.file).join(" / ")}`);
  if (!yes) {
    if (!process.stdin.isTTY) throw new Error("Add --yes when not running in a terminal");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // question never settles when stdin closes at EOF.
    const closed = new AbortController();
    rl.once("close", () => closed.abort());
    const typed = (
      await rl.question("Type yes to continue: ", { signal: closed.signal }).catch(() => "")
    ).trim();
    rl.close();
    if (typed !== "yes") {
      say("Stopped.");
      process.exitCode = 1;
      return;
    }
  }
  const applied = withOwner(file, (raw) => applyMigrations(raw, files, dir));
  say(`Applied: ${applied.map((m) => m.file).join(" / ") || "none"}`);
  say(`${file} is at revision ${withOwner(file, versionOf)}`);
}

/**
 * Rebuilds the full-text index. **A PR changing the rules of terms() adds this to its release steps.**
 * Changing the rules leaves existing rows indexed with the old rules, and they stop matching query terms.
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
  say(
    `Rebuilt the index: ${plural(counts.knowledge, "knowledge row")}, ${plural(counts.message, "message")}`,
  );
}

/** Database state for doctor. Everything is read only; no file is modified. */
export type Inspection = {
  revision: number;
  /** Sizes of the database and WAL files (bytes) */
  bytes: number;
  /** integrity-check of the full-text index. The reason text when broken */
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
